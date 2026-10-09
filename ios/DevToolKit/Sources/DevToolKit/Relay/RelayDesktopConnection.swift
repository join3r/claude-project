import Foundation
import OSLog

/// A `DesktopConnection` through the relay: the phone side of SPEC.md §4.
///
/// It subscribes to the shared `RelayClient` for its relay, and on every
/// `ready` (each (re)connection) or when the desktop comes online, runs the
/// Noise IK handshake as initiator with `kind: "pair"` (pairing) or
/// `"resume"`. After `ok` it asks for the inbox (`inbox.get`) and then follows
/// `inbox` events. A pairing connection that gets `pending` waits for the
/// `pairing` event; once accepted it carries on as the normal session and
/// later handshakes use `resume`.
public actor RelayDesktopConnection: DesktopConnection {
    public enum Mode: Sendable {
        case pair(proof: Data, relayToken: Data)
        case resume
    }

    public struct Peer: Sendable {
        public var desktopId: String
        public var desktopName: String
        public var relayURL: URL
        /// Raw 32-byte X25519 public key from the QR code.
        public var x25519PublicKey: Data

        public init(desktopId: String, desktopName: String, relayURL: URL, x25519PublicKey: Data) {
            self.desktopId = desktopId
            self.desktopName = desktopName
            self.relayURL = relayURL
            self.x25519PublicKey = x25519PublicKey
        }
    }

    public nonisolated let desktopId: String
    public nonisolated let events: AsyncStream<DesktopConnectionEvent>

    private let peer: Peer
    private let identity: DeviceIdentity
    private let hub: RelayHub
    private let deviceName: String
    private let appVersion: String
    private let timing: RelayTiming
    private let continuation: AsyncStream<DesktopConnectionEvent>.Continuation
    private let log = Logger(subsystem: "sk.awantech.devtool", category: "connection")

    private var mode: Mode
    private var desktopName: String
    private var client: RelayClient?
    private var subscription: UUID?
    private var listener: Task<Void, Never>?
    private var started = false
    private var stopped = false

    private var state: ConnectionState = .idle
    /// A final answer (revoked, rejected, incompatible, unknown device): no more handshakes.
    private var terminal = false
    private var relayReady = false
    private var handshake: HandshakeState?
    private var handshakeGeneration = 0
    private var handshakeRetry: Duration
    private var retryTask: Task<Void, Never>?
    private var transport: NoiseTransport?
    /// `ok`, or `pending` followed by `pairing: accepted`.
    private var accepted = false
    private var lastSeq: Int64 = -1
    private var nextRequestId: Int64 = 1
    private var inboxRequests: Set<Int64> = []
    private var lastSeen: Date?
    /// `features` of the last desktop hello (§8.1).
    private var features: Set<String> = []
    /// Desktop or DevTool server, from the last hello's `app` (§4.3).
    private var hostKind: HostKind = .desktop

    /// In-flight `request(_:params:timeout:)` calls by `req` id.
    private var pending: [Int64: PendingRequest] = [:]
    private var chatSubscribers: [UUID: AsyncStream<ChatStreamEvent>.Continuation] = [:]
    /// §6.1 fragments, reset with every session.
    private var reassembler = Reassembler()
    private var nextFragmentId: UInt32 = 0
    /// Keeps transport frames in encryption order on the way to the relay.
    private var sendChain: Task<Void, Never>?

    private struct PendingRequest {
        var continuation: CheckedContinuation<JSONValue, any Error>
        var timeout: Task<Void, Never>
    }

    public init(
        peer: Peer,
        mode: Mode,
        identity: DeviceIdentity,
        hub: RelayHub,
        deviceName: String,
        appVersion: String,
        timing: RelayTiming = .standard,
        lastSeen: Date? = nil
    ) {
        desktopId = peer.desktopId
        self.peer = peer
        self.mode = mode
        self.identity = identity
        self.hub = hub
        self.deviceName = deviceName
        self.appVersion = appVersion
        self.timing = timing
        self.lastSeen = lastSeen
        desktopName = peer.desktopName
        handshakeRetry = timing.initialBackoff
        (events, continuation) = AsyncStream.makeStream(bufferingPolicy: .bufferingNewest(128))
    }

    private var isPairing: Bool {
        if case .pair = mode { return true }
        return false
    }

    // MARK: DesktopConnection

    public func start() async {
        guard !started, !stopped else { return }
        started = true
        set(.connecting)
        let client = await hub.client(for: peer.relayURL)
        guard !stopped else { return }
        self.client = client
        var pairToken: Data?
        if case .pair(_, let token) = mode { pairToken = token }
        let subscription = await client.subscribe(desktopId: peer.desktopId, pairToken: pairToken)
        self.subscription = subscription.id
        listener = Task { [weak self] in
            for await event in subscription.events {
                await self?.handle(event)
            }
        }
    }

    public func stop() async {
        guard !stopped else { return }
        stopped = true
        terminal = true
        retryTask?.cancel()
        listener?.cancel()
        dropSession()
        if let client, let subscription { await client.unsubscribe(subscription) }
        subscription = nil
        set(.idle)
        continuation.finish()
        for subscriber in chatSubscribers.values { subscriber.finish() }
        chatSubscribers = [:]
    }

    public func request(_ op: String, params: JSONValue?, timeout: Duration) async throws -> JSONValue {
        guard accepted, transport != nil else {
            if case .offline = state { throw DesktopConnectionError.desktopOffline }
            throw DesktopConnectionError.notConnected
        }
        let id = nextRequestId
        nextRequestId += 1
        let message = AppMessage.req(id: id, op: op, params: params)
        return try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<JSONValue, any Error>) in
            let timer = Task { [weak self] in
                guard (try? await Task.sleep(for: timeout)) != nil else { return }
                await self?.fail(id, DesktopConnectionError.timeout)
            }
            pending[id] = PendingRequest(continuation: continuation, timeout: timer)
            do {
                let send = try enqueueApp(message)
                Task { [weak self] in
                    do {
                        try await send.value
                    } catch {
                        await self?.fail(id, DesktopConnectionError.notConnected)
                    }
                }
            } catch {
                fail(id, error)
            }
        }
    }

    public func chatEvents() async -> AsyncStream<ChatStreamEvent> {
        let (stream, continuation) = AsyncStream.makeStream(of: ChatStreamEvent.self, bufferingPolicy: .bufferingNewest(256))
        guard !stopped else {
            continuation.finish()
            return stream
        }
        let id = UUID()
        chatSubscribers[id] = continuation
        continuation.onTermination = { [weak self] _ in
            Task { await self?.removeChatSubscriber(id) }
        }
        return stream
    }

    private func removeChatSubscriber(_ id: UUID) {
        chatSubscribers[id] = nil
    }

    private func publishChat(_ event: ChatStreamEvent) {
        for subscriber in chatSubscribers.values { subscriber.yield(event) }
    }

    private func fail(_ id: Int64, _ error: any Error) {
        guard let request = pending.removeValue(forKey: id) else { return }
        request.timeout.cancel()
        request.continuation.resume(throwing: error)
    }

    private func complete(_ id: Int64, _ result: Result<JSONValue, DesktopConnectionError>) -> Bool {
        guard let request = pending.removeValue(forKey: id) else { return false }
        request.timeout.cancel()
        request.continuation.resume(with: result)
        return true
    }

    public func refresh() async throws {
        guard accepted, transport != nil else {
            if case .offline = state { throw DesktopConnectionError.desktopOffline }
            throw DesktopConnectionError.notConnected
        }
        try await requestInbox()
    }

    public func reconnectNow() async {
        guard !stopped, !terminal, let client else { return }
        await client.reconnectNow()
        // A handshake waiting out its retry backoff goes again now.
        if relayReady, transport == nil, handshake == nil {
            handshakeRetry = timing.initialBackoff
            await beginHandshake()
        }
    }

    // MARK: Relay events

    private func handle(_ event: RelayEvent) async {
        guard !stopped else { return }
        switch event {
        case .connecting:
            relayReady = false
            if !terminal, state != .connecting, !isOffline { set(.connecting) }
        case .ready:
            relayReady = true
            dropSession()
            handshakeRetry = timing.initialBackoff
            await beginHandshake()
        case .disconnected:
            relayReady = false
            dropSession()
            if !terminal { set(.connecting) }
        case .frame(let data):
            await handleFrame(data)
        case .peer(.online, _):
            if isOffline { set(.handshaking) }
            if transport == nil, handshake == nil { await beginHandshake() }
        case .peer(.offline, let seen):
            dropSession()
            if let seen {
                let date = Date(unixMilliseconds: seen)
                lastSeen = date
                continuation.yield(.lastSeen(date))
            }
            if !terminal { set(.offline(lastSeen: lastSeen)) }
        case .peer(.revoked, _):
            finish(.revoked, pairing: .revoked)
        case .error(.offline, _):
            dropSession()
            if !terminal { set(.offline(lastSeen: lastSeen)) }
        case .error(.forbidden, let message):
            if isPairing {
                finish(.failed(message ?? "The relay didn't let this phone reach the desktop. Show a new pairing code on the desktop."))
            } else {
                // The relay no longer has this pairing.
                finish(.revoked, pairing: .revoked)
            }
        case .error(let code, let message):
            log.notice("Relay error \(code.rawValue, privacy: .public): \(message ?? "", privacy: .public)")
        case .authFailed(let message):
            if isPairing {
                finish(.failed(message))
            } else if !terminal {
                set(.failed(message))
            }
        }
    }

    private var isOffline: Bool {
        if case .offline = state { return true }
        return false
    }

    // MARK: Handshake

    private func beginHandshake() async {
        guard !terminal, relayReady, let client else { return }
        retryTask?.cancel()
        transport = nil
        accepted = false
        var proof: String?
        let kind: PairKind
        switch mode {
        case .pair(let pairProof, _):
            kind = .pair
            proof = pairProof.base64URLEncodedString
        case .resume:
            kind = .resume
        }
        let hello = PhoneHello(
            app: appVersion, kind: kind, proof: proof, deviceName: deviceName,
            ed: identity.ed25519.pub.base64URLEncodedString
        )
        let message: Data
        do {
            var state = try HandshakeState.initiator(s: identity.x25519, rs: peer.x25519PublicKey)
            message = try state.writeMessage(hello.json.jsonData)
            handshake = state
        } catch {
            finish(.failed("Couldn't start a secure session: \(error.localizedDescription)"))
            return
        }
        handshakeGeneration += 1
        let generation = handshakeGeneration
        if !isOffline { set(.handshaking) }
        do {
            try await client.send(try Envelope(kind: .handshake1, body: message).encode(), to: peer.desktopId)
        } catch {
            // Not connected: the next `ready` starts over.
            handshake = nil
            return
        }
        // The desktop drops a message 1 it can't process without answering
        // (§4.3), so a lost handshake is retried after a timeout, with backoff.
        retryTask = Task { [weak self, timing] in
            guard (try? await Task.sleep(for: timing.handshakeTimeout)) != nil else { return }
            await self?.handshakeTimedOut(generation)
        }
    }

    private func handshakeTimedOut(_ generation: Int) async {
        guard generation == handshakeGeneration, handshake != nil, !terminal else { return }
        handshake = nil
        scheduleRetry()
    }

    private func scheduleRetry() {
        guard !terminal else { return }
        let delay = handshakeRetry
        handshakeRetry = min(handshakeRetry * 2, timing.maxBackoff)
        retryTask?.cancel()
        retryTask = Task { [weak self] in
            guard (try? await Task.sleep(for: delay)) != nil else { return }
            await self?.retryHandshake()
        }
    }

    private func retryHandshake() async {
        guard transport == nil, handshake == nil else { return }
        await beginHandshake()
    }

    private func handleHandshake2(_ body: Data) async {
        guard var state = handshake else { return }
        handshake = nil
        retryTask?.cancel()
        let hello: DesktopHello
        do {
            let payload = try state.readMessage(body)
            hello = try DesktopHello.parse(payload)
        } catch {
            log.error("Bad handshake answer: \(error.localizedDescription, privacy: .public)")
            if !isOffline { set(.failed("Unexpected answer from \(desktopName).")) }
            scheduleRetry()
            return
        }
        desktopName = hello.desktopName.isEmpty ? desktopName : hello.desktopName
        features = Set(hello.features)
        hostKind = hello.hostKind
        let negotiation = VersionNegotiation.negotiate(local: AppProtocol.local, remote: hello.version)

        switch hello.result {
        case .ok, .pending:
            if case .incompatible(let update) = negotiation {
                // The desktop let us in, but we can't speak its version.
                finish(.incompatible(updateDesktop: update == .remote))
                try? await sendFrame(.reset)
                return
            }
            do {
                transport = try state.split()
            } catch {
                scheduleRetry()
                return
            }
            handshakeRetry = timing.initialBackoff
            lastSeq = -1
            inboxRequests = []
            reassembler.reset()
            nextFragmentId = 0
            if hello.result == .ok {
                await becomeAccepted()
            } else {
                continuation.yield(.pairing(.pending))
                set(.awaitingApproval)
            }
        case .rejected:
            finish(.revoked, pairing: isPairing ? .rejected : .revoked)
        case .incompatible:
            let updateDesktop: Bool
            switch negotiation {
            case .incompatible(let update): updateDesktop = update == .remote
            case .ok: updateDesktop = hello.v < AppProtocol.version
            }
            finish(.incompatible(updateDesktop: updateDesktop))
        case .unknownDevice:
            finish(.unknownDevice)
        }
    }

    private func becomeAccepted() async {
        accepted = true
        if case .pair = mode {
            mode = .resume
            if let client, let subscription { await client.clearPairToken(subscription) }
            continuation.yield(.pairing(.accepted(desktopName: desktopName)))
        }
        lastSeen = Date()
        continuation.yield(.hostKind(hostKind))
        continuation.yield(.features(features))
        set(.online)
        publishChat(.sessionStarted)
        try? await requestInbox()
    }

    // MARK: Frames

    private func handleFrame(_ data: Data) async {
        let envelope: Envelope
        do {
            envelope = try Envelope.decode(data)
        } catch {
            return
        }
        switch envelope.kind {
        case .handshake2:
            await handleHandshake2(envelope.body)
        case .transport:
            await handleTransport(envelope.body)
        case .reset:
            // A handshake in flight already replaces the desktop's session.
            reassembler.reset()
            guard handshake == nil, !terminal else { return }
            dropSession()
            await beginHandshake()
        case .handshake1:
            break // The phone is never the responder.
        }
    }

    private func handleTransport(_ body: Data) async {
        guard var session = transport else {
            // During our own handshake this is a leftover from the old
            // session; answering reset would kill the new one.
            if handshake == nil, !terminal { try? await sendFrame(.reset) }
            return
        }
        let plaintext: Data
        do {
            plaintext = try session.decrypt(body)
            transport = session
        } catch {
            try? await sendFrame(.reset)
            dropSession()
            await beginHandshake()
            return
        }
        let json: Data
        switch reassembler.receive(plaintext) {
        case .message(let data):
            json = data
        case .partial:
            return
        case .ignored:
            log.notice("Ignoring a transport message with an unknown first byte")
            return
        case .dropped(let id, let reason):
            log.error("Dropped fragmented message \(id): \(reason, privacy: .public)")
            return
        }
        let message: AppMessage?
        do {
            message = try AppMessage.parse(json)
        } catch {
            log.error("Bad app message: \(error.localizedDescription, privacy: .public)")
            return
        }
        guard let message else { return }
        await handleApp(message)
    }

    private func handleApp(_ message: AppMessage) async {
        switch message {
        case .resOk(let id, let result):
            if complete(id, .success(result)) { return }
            guard inboxRequests.remove(id) != nil else { return }
            do {
                deliver(try Inbox.parse(result))
            } catch {
                log.error("Bad inbox: \(error.localizedDescription, privacy: .public)")
            }
        case .resError(let id, let code, let message):
            if complete(id, .failure(.remote(code: code, message: message))) { return }
            inboxRequests.remove(id)
            if code != AppErrorCode.notAuthorized {
                log.notice("Request \(id) failed: \(code, privacy: .public) \(message, privacy: .public)")
            }
        case .inbox(let seq, let inbox):
            guard accepted, seq > lastSeq else { return }
            lastSeq = seq
            deliver(inbox)
        case .pairing(.accepted):
            guard !accepted else { return }
            await becomeAccepted()
        case .pairing(.rejected):
            finish(.revoked, pairing: .rejected)
        case .pairing(.revoked):
            finish(.revoked, pairing: .revoked)
        case .req(let id, let op, _):
            try? await sendApp(.resError(id: id, code: AppErrorCode.unsupported, message: "Unknown op \(op)"))
        case .chat(let event):
            guard accepted else { return }
            publishChat(.chat(event))
        }
    }

    private func deliver(_ inbox: Inbox) {
        guard accepted else { return }
        continuation.yield(.inbox(inbox))
    }

    private func requestInbox() async throws {
        let id = nextRequestId
        nextRequestId += 1
        inboxRequests.insert(id)
        try await sendApp(.req(id: id, op: AppOp.inboxGet))
    }

    private func sendApp(_ message: AppMessage) async throws {
        try await enqueueApp(message).value
    }

    /// Encrypts `message` (fragmented when it's over 60000 bytes, §6.1) and
    /// queues its frames. Encryption and queueing happen together, with no
    /// suspension in between, so frames reach the relay in nonce order and a
    /// message's fragments stay consecutive. The task finishes when the last
    /// frame is handed to the relay.
    private func enqueueApp(_ message: AppMessage) throws -> Task<Void, any Error> {
        guard var session = transport else { throw DesktopConnectionError.notConnected }
        let plaintexts = try Fragmentation.encode(message.encoded, id: nextFragmentId)
        if plaintexts.count > 1 { nextFragmentId &+= 1 }
        var frames: [Data] = []
        for plaintext in plaintexts {
            frames.append(try Envelope(kind: .transport, body: try session.encrypt(plaintext)).encode())
        }
        transport = session
        return enqueue(frames)
    }

    private func sendFrame(_ kind: FrameKind, _ body: Data = Data()) async throws {
        try await enqueue([try Envelope(kind: kind, body: body).encode()]).value
    }

    private func enqueue(_ frames: [Data]) -> Task<Void, any Error> {
        let previous = sendChain
        let client = client
        let to = peer.desktopId
        let task = Task<Void, any Error> {
            await previous?.value
            guard let client else { throw DesktopConnectionError.notConnected }
            for frame in frames { try await client.send(frame, to: to) }
        }
        sendChain = Task { _ = try? await task.value }
        return task
    }

    // MARK: State

    private func dropSession() {
        let hadSession = accepted
        transport = nil
        handshake = nil
        accepted = false
        reassembler.reset()
        for id in Array(pending.keys) { fail(id, DesktopConnectionError.connectionLost) }
        if hadSession { publishChat(.sessionLost) }
        retryTask?.cancel()
        retryTask = nil
    }

    /// A final answer: report it and stop handshaking. The relay subscription
    /// is released so an unused socket can close.
    private func finish(_ newState: ConnectionState, pairing: PairingStatus? = nil) {
        guard !terminal else { return }
        terminal = true
        dropSession()
        if let pairing { continuation.yield(.pairing(pairing)) }
        set(newState)
        if let client, let subscription {
            self.subscription = nil
            Task { await client.unsubscribe(subscription) }
        }
    }

    private func set(_ newState: ConnectionState) {
        guard newState != state else { return }
        state = newState
        continuation.yield(.state(newState))
    }
}

/// Hands out relay-backed connections that share one socket per relay URL.
public struct RelayDesktopConnectionFactory: DesktopConnectionFactory {
    public let identity: DeviceIdentity
    public let hub: RelayHub
    public let deviceName: String
    /// `ios/<version>`, sent in the handshake.
    public let appVersion: String
    public let timing: RelayTiming

    public init(
        identity: DeviceIdentity,
        deviceName: String,
        appVersion: String,
        connector: any WebSocketConnector = URLSessionWebSocketConnector(),
        timing: RelayTiming = .standard
    ) {
        self.identity = identity
        self.deviceName = deviceName
        self.appVersion = appVersion
        self.timing = timing
        hub = RelayHub(identity: identity, connector: connector, timing: timing)
    }

    public func connection(for desktop: DesktopRecord) -> any DesktopConnection {
        let key = Base64URL.decode(desktop.desktopX25519PublicKey) ?? Data()
        return RelayDesktopConnection(
            peer: .init(desktopId: desktop.id, desktopName: desktop.name, relayURL: desktop.relayURL, x25519PublicKey: key),
            mode: .resume,
            identity: identity, hub: hub, deviceName: deviceName, appVersion: appVersion, timing: timing,
            lastSeen: desktop.lastSeen
        )
    }

    public func pairingConnection(for invite: PairingInvite, deviceName: String) -> any DesktopConnection {
        RelayDesktopConnection(
            peer: .init(desktopId: invite.desktopId, desktopName: invite.desktopName, relayURL: invite.relayURL,
                        x25519PublicKey: invite.desktopX25519PublicKey),
            mode: .pair(proof: invite.pairProof, relayToken: invite.relayToken),
            identity: identity, hub: hub, deviceName: deviceName, appVersion: appVersion, timing: timing
        )
    }
}
