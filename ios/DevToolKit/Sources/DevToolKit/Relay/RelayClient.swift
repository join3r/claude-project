import Foundation
import OSLog

/// Timing knobs; tests shrink them.
public struct RelayTiming: Sendable {
    public var pingInterval: Duration
    public var initialBackoff: Duration
    public var maxBackoff: Duration
    /// How long the phone waits for Noise message 2 before trying again.
    public var handshakeTimeout: Duration

    public init(
        pingInterval: Duration = RelayProtocol.pingInterval,
        initialBackoff: Duration = .seconds(1),
        maxBackoff: Duration = .seconds(30),
        handshakeTimeout: Duration = .seconds(10)
    ) {
        self.pingInterval = pingInterval
        self.initialBackoff = initialBackoff
        self.maxBackoff = maxBackoff
        self.handshakeTimeout = handshakeTimeout
    }

    public static let standard = RelayTiming()
}

/// What a `RelayClient` tells one subscriber (one desktop's connection).
public enum RelayEvent: Sendable, Equatable {
    /// Opening the socket or authenticating.
    case connecting
    /// Authenticated. Every `ready` starts a new epoch: handshake again (§4.2).
    case ready
    /// The socket dropped; a reconnect is scheduled.
    case disconnected
    /// `frame.data` bytes from this subscriber's desktop.
    case frame(Data)
    /// Presence of this subscriber's desktop.
    case peer(PeerState, lastSeen: Int64?)
    /// A relay `error` addressed to this desktop (`to`), or a general one.
    case error(RelayErrorCode, message: String?)
    /// The relay refused our `hello` (4401), or our `pair` token.
    case authFailed(String)
}

public struct RelaySubscription: Sendable {
    public let id: UUID
    public let events: AsyncStream<RelayEvent>
}

/// One authenticated WebSocket to a relay, shared by every desktop the phone
/// talks to on that relay.
///
/// The relay allows one connection per device ID and closes the older one
/// (4409) when a second arrives (§3.5), so a phone paired with several
/// desktops on the same relay must multiplex them over one socket. Each
/// desktop connection subscribes with its desktop ID; incoming `frame`, `peer`
/// and targeted `error` messages are routed by `from`/`id`/`to`, and outgoing
/// frames carry `to`. `RelayHub` hands out one client per relay URL.
///
/// A `hello` can carry only one `pair` token. When a subscriber that is
/// pairing arrives while the socket is already authenticated without its
/// token, the client reconnects with it (the other desktops just re-handshake,
/// which they do on every reconnect anyway).
public actor RelayClient {
    public nonisolated let relayURL: URL
    private let identity: DeviceIdentity
    private let connector: any WebSocketConnector
    private let timing: RelayTiming
    private let log = Logger(subsystem: "sk.awantech.devtool", category: "relay")

    private struct Subscriber {
        let desktopId: String
        var pairToken: Data?
        /// Order of registration, so the newest pairing wins the `hello`.
        let order: Int
        let continuation: AsyncStream<RelayEvent>.Continuation
    }

    private var subscribers: [UUID: Subscriber] = [:]
    private var order = 0
    private var runner: Task<Void, Never>?
    private var socket: (any WebSocketTransport)?
    private var ready = false
    /// The `pair` sent in the current connection's hello.
    private var helloPair: RelayPair?
    /// Set when a reconnect should skip the backoff (new pairing token).
    private var skipBackoff = false
    /// The backoff sleep between sockets, while one is running.
    private var backoffSleep: Task<Void, Never>?
    /// `reconnectNow()` cut the backoff short.
    private var woken = false

    public init(relayURL: URL, identity: DeviceIdentity, connector: any WebSocketConnector = URLSessionWebSocketConnector(), timing: RelayTiming = .standard) {
        self.relayURL = relayURL
        self.identity = identity
        self.connector = connector
        self.timing = timing
    }

    /// `<relay>/v1`, keeping any path prefix of the relay base URL.
    public nonisolated var endpoint: URL {
        var base = relayURL.absoluteString
        while base.hasSuffix("/") { base.removeLast() }
        return URL(string: base + RelayProtocol.path) ?? relayURL.appending(path: "v1")
    }

    public var isReady: Bool { ready }

    // MARK: Subscribers

    /// Starts routing events for `desktopId` and opens the socket if needed.
    /// `pairToken` is the relayToken of a pairing in progress (§2, §3.1).
    public func subscribe(desktopId: String, pairToken: Data? = nil) -> RelaySubscription {
        let id = UUID()
        let (stream, continuation) = AsyncStream.makeStream(of: RelayEvent.self, bufferingPolicy: .bufferingNewest(256))
        order += 1
        subscribers[id] = Subscriber(desktopId: desktopId, pairToken: pairToken, order: order, continuation: continuation)
        continuation.onTermination = { [weak self] _ in
            Task { await self?.unsubscribe(id) }
        }
        if runner == nil {
            startRunner()
        } else if ready {
            if pairToken != nil, helloPair?.to != desktopId {
                // Our hello didn't carry this token: authenticate again with it.
                // Everyone gets `disconnected` and then `ready` again.
                continuation.yield(.connecting)
                skipBackoff = true
                socket?.close(code: 1000)
            } else {
                continuation.yield(.ready)
                sendWatch()
            }
        } else {
            continuation.yield(.connecting)
        }
        return RelaySubscription(id: id, events: stream)
    }

    public func unsubscribe(_ id: UUID) {
        guard let subscriber = subscribers.removeValue(forKey: id) else { return }
        subscriber.continuation.finish()
        if subscribers.isEmpty {
            runner?.cancel()
            runner = nil
            socket?.close(code: 1000)
            socket = nil
            ready = false
        }
    }

    /// The pairing finished (accepted or not): later hellos don't carry the token.
    public func clearPairToken(_ id: UUID) {
        subscribers[id]?.pairToken = nil
        // The pairing was just accepted, so the host has authorized us at the
        // relay. The relay ignored this id in earlier watches (it wasn't paired
        // yet); watch again so presence arrives without waiting for a reconnect.
        sendWatch()
    }

    /// Ends a running reconnect backoff now (the app came to the foreground,
    /// §8.3). With the socket up it pings the relay instead, so a socket that
    /// died while the app was suspended fails now rather than at the next
    /// scheduled ping.
    public func reconnectNow() {
        if let backoffSleep {
            woken = true
            backoffSleep.cancel()
        } else if ready, let socket {
            let ping = RelayClientMessage.ping.text
            Task { try? await socket.send(ping) }
        }
    }

    /// Sends `frame.data` bytes to `desktopId`.
    public func send(_ data: Data, to desktopId: String) async throws {
        guard ready, let socket else { throw DesktopConnectionError.notConnected }
        try await socket.send(RelayClientMessage.frame(to: desktopId, data: data.base64URLEncodedString).text)
    }

    // MARK: Connection loop

    private func startRunner() {
        runner = Task { [weak self] in
            await self?.run()
        }
    }

    private func run() async {
        var backoff = timing.initialBackoff
        while !Task.isCancelled, !subscribers.isEmpty {
            broadcast(.connecting)
            let wasReady = await connectOnce()
            if Task.isCancelled || subscribers.isEmpty { break }
            broadcast(.disconnected)
            if wasReady { backoff = timing.initialBackoff }
            if skipBackoff {
                skipBackoff = false
                continue
            }
            // A task of its own, so `reconnectNow()` can end it without
            // cancelling the loop.
            let sleep = Task { [backoff] in _ = try? await Task.sleep(for: backoff) }
            backoffSleep = sleep
            await withTaskCancellationHandler {
                await sleep.value
            } onCancel: {
                sleep.cancel()
            }
            backoffSleep = nil
            if Task.isCancelled { break }
            if woken {
                woken = false
                backoff = timing.initialBackoff
            } else {
                backoff = min(backoff * 2, timing.maxBackoff)
            }
        }
    }

    /// One socket lifetime. Returns whether it got as far as `ready`.
    private func connectOnce() async -> Bool {
        let socket = connector.open(endpoint)
        self.socket = socket
        ready = false
        helloPair = nil
        var reachedReady = false
        let pinger = Task { [timing] in
            while !Task.isCancelled {
                guard (try? await Task.sleep(for: timing.pingInterval)) != nil else { return }
                try? await socket.send(RelayClientMessage.ping.text)
            }
        }
        defer {
            pinger.cancel()
            socket.close(code: 1000)
            if self.socket === socket { self.socket = nil }
            ready = false
        }
        do {
            while !Task.isCancelled {
                let text = try await socket.receive()
                let parsed: RelayServerMessage?
                do {
                    parsed = try RelayServerMessage.parse(text)
                } catch {
                    log.error("Ignoring a bad relay message: \(error.localizedDescription, privacy: .public)")
                    continue
                }
                guard let message = parsed else { continue }
                if try await handle(message, on: socket) { reachedReady = true }
            }
        } catch let closed as WebSocketClosed {
            if closed.code == RelayProtocol.CloseCode.auth {
                authRefused("The relay refused this device (\(closed.reason)).")
            } else if closed.code == RelayProtocol.CloseCode.replaced {
                log.notice("Relay replaced this connection with a newer one (4409)")
            }
        } catch {
            log.error("Relay socket failed: \(error.localizedDescription, privacy: .public)")
        }
        return reachedReady
    }

    /// Returns true when this message made the connection ready.
    private func handle(_ message: RelayServerMessage, on socket: any WebSocketTransport) async throws -> Bool {
        switch message {
        case .challenge(let nonce):
            let pair = currentPair()
            helloPair = pair
            let hello = try RelayProtocol.hello(
                role: .phone, nonce: nonce, ed25519: identity.ed25519,
                pair: try pair.map { (to: $0.to, token: try Base64URL.decode($0.token).orThrow()) }
            )
            try await socket.send(hello.text)
            return false
        case .ready(let id):
            if id != identity.deviceId {
                log.error("Relay says our id is \(id, privacy: .public), expected \(self.identity.deviceId, privacy: .public)")
            }
            ready = true
            sendWatch()
            broadcast(.ready)
            return true
        case .frame(let from, let data):
            guard let bytes = Base64URL.decode(data) else { return false }
            deliver(to: from, .frame(bytes))
        case .peer(let id, let state, let lastSeen):
            deliver(to: id, .peer(state, lastSeen: lastSeen))
        case .error(let code, let message, let to):
            if code == .auth {
                authRefused(message ?? "The relay refused this device.")
            } else if let to {
                deliver(to: to, .error(code, message: message))
            } else {
                broadcast(.error(code, message: message))
            }
        case .ping:
            try await socket.send(RelayClientMessage.pong.text)
        case .pong:
            break
        }
        return false
    }

    /// The newest subscriber that is pairing gets the one `pair` slot in hello.
    private func currentPair() -> RelayPair? {
        subscribers.values
            .filter { $0.pairToken != nil }
            .max { $0.order < $1.order }
            .map { RelayPair(to: $0.desktopId, token: $0.pairToken!.base64URLEncodedString) }
    }

    /// An auth failure while carrying a pair token is blamed on the token: the
    /// pairing subscriber is told and the token dropped, so the others can
    /// reconnect without it. Otherwise everyone hears about it.
    private func authRefused(_ message: String) {
        if let pair = helloPair {
            for (id, subscriber) in subscribers where subscriber.desktopId == pair.to && subscriber.pairToken != nil {
                subscribers[id]?.pairToken = nil
                subscriber.continuation.yield(.authFailed(message))
            }
            helloPair = nil
        } else {
            broadcast(.authFailed(message))
        }
    }

    private func sendWatch() {
        guard ready, let socket else { return }
        let desktops = Array(Set(subscribers.values.map(\.desktopId))).sorted()
        let text = RelayClientMessage.watch(desktops: desktops).text
        Task { try? await socket.send(text) }
    }

    private func deliver(to desktopId: String, _ event: RelayEvent) {
        for subscriber in subscribers.values where subscriber.desktopId == desktopId {
            subscriber.continuation.yield(event)
        }
    }

    private func broadcast(_ event: RelayEvent) {
        for subscriber in subscribers.values {
            subscriber.continuation.yield(event)
        }
    }
}

extension Optional {
    func orThrow() throws(ProtocolError) -> Wrapped {
        guard let self else { throw ProtocolError("missing value") }
        return self
    }
}

/// One `RelayClient` per relay URL for this phone's identity, so every
/// desktop on a relay shares one socket (see `RelayClient`).
public actor RelayHub {
    private let identity: DeviceIdentity
    private let connector: any WebSocketConnector
    private let timing: RelayTiming
    private var clients: [String: RelayClient] = [:]

    public init(identity: DeviceIdentity, connector: any WebSocketConnector = URLSessionWebSocketConnector(), timing: RelayTiming = .standard) {
        self.identity = identity
        self.connector = connector
        self.timing = timing
    }

    public func client(for relayURL: URL) -> RelayClient {
        let key = Self.key(relayURL)
        if let client = clients[key] { return client }
        let client = RelayClient(relayURL: relayURL, identity: identity, connector: connector, timing: timing)
        clients[key] = client
        return client
    }

    /// Scheme and host are case-insensitive; a trailing slash doesn't matter.
    static func key(_ url: URL) -> String {
        var key = url.absoluteString
        if var components = URLComponents(url: url, resolvingAgainstBaseURL: false) {
            let scheme = components.scheme?.lowercased(), host = components.host?.lowercased()
            components.scheme = scheme
            components.host = host
            key = components.string ?? key
        }
        while key.hasSuffix("/") { key.removeLast() }
        return key
    }
}
