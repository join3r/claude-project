import Foundation

/// What the app knows about a paired desktop. Persisted by the app; handed to
/// a `DesktopConnectionFactory` to resume a session.
public struct DesktopRecord: Codable, Sendable, Equatable, Identifiable {
    /// Desktop device ID (spec §1).
    public var id: String
    public var name: String
    public var relayURL: URL
    /// b64u raw X25519 public key of the desktop (Noise static, needed for IK).
    public var desktopX25519PublicKey: String
    /// b64u raw Ed25519 public key of the desktop.
    public var desktopEd25519PublicKey: String
    /// Keychain label (see `KeychainStore`) of this phone's identity used for
    /// the pairing. M1 uses one identity per phone, so this is usually
    /// `KeychainStore.deviceIdentityLabel`.
    public var keysReference: String
    public var pairedAt: Date
    public var lastSeen: Date?
    /// The `features` of the desktop's last hello (§8.1), kept so an offline
    /// desktop still shows what it can do. nil until the first session.
    public var features: [String]?

    public init(
        id: String,
        name: String,
        relayURL: URL,
        desktopX25519PublicKey: String,
        desktopEd25519PublicKey: String,
        keysReference: String,
        pairedAt: Date = Date(),
        lastSeen: Date? = nil,
        features: [String]? = nil
    ) {
        self.id = id
        self.name = name
        self.relayURL = relayURL
        self.desktopX25519PublicKey = desktopX25519PublicKey
        self.desktopEd25519PublicKey = desktopEd25519PublicKey
        self.keysReference = keysReference
        self.pairedAt = pairedAt
        self.lastSeen = lastSeen
        self.features = features
    }

    /// Whether the desktop's last hello listed `feature` (`DesktopFeature`).
    public func supports(_ feature: String) -> Bool {
        features?.contains(feature) ?? false
    }

    public init(invite: PairingInvite, keysReference: String, name: String? = nil) {
        self.init(
            id: invite.desktopId,
            name: name ?? invite.desktopName,
            relayURL: invite.relayURL,
            desktopX25519PublicKey: invite.desktopX25519PublicKey.base64URLEncodedString,
            desktopEd25519PublicKey: invite.desktopEd25519PublicKey.base64URLEncodedString,
            keysReference: keysReference
        )
    }
}

/// Connection state of one desktop as the phone sees it.
public enum ConnectionState: Sendable, Equatable {
    /// Not started, or stopped by the app.
    case idle
    /// Opening the relay socket / authenticating.
    case connecting
    /// Relay is up, Noise handshake in flight.
    case handshaking
    /// Pairing handshake answered `pending`: the user has to Accept on the desktop.
    case awaitingApproval
    /// Session established; inbox events flow.
    case online
    /// Relay reports the desktop offline (or the relay is unreachable).
    case offline(lastSeen: Date?)
    /// The desktop revoked this phone, or rejected the pairing.
    case revoked
    /// Version mismatch (`incompatible`); `updateDesktop` says which side is older.
    case incompatible(updateDesktop: Bool)
    /// The desktop doesn't know this phone any more (`unknown-device`).
    case unknownDevice
    case failed(String)

    public var isOnline: Bool { self == .online }
}

/// Outcome of a pairing attempt, from the handshake result and the `pairing` app event.
public enum PairingStatus: Sendable, Equatable {
    case pending
    case accepted(desktopName: String)
    case rejected
    case revoked
}

/// Everything a connection reports. One consumer (the app model) reads `events`.
public enum DesktopConnectionEvent: Sendable, Equatable {
    case state(ConnectionState)
    /// A full inbox replacement (from `inbox.get` or an `inbox` event).
    case inbox(Inbox)
    case pairing(PairingStatus)
    /// Relay presence update for the desktop (`peer` with `lastSeen`).
    case lastSeen(Date)
    /// The `features` of the desktop's hello (§8.1), sent just before each
    /// `.online`.
    case features(Set<String>)
}

/// A live link to one desktop through the relay.
///
/// The app creates one per paired desktop (or one for an in-flight pairing)
/// via a `DesktopConnectionFactory`, calls `start()`, and reads `events` until
/// the stream finishes. `stop()` closes the link and finishes the stream.
///
/// The relay/Noise implementation lands in `DevToolKit/Relay`; the app only
/// depends on this protocol, so swapping `MockDesktopConnection` for the real
/// one is a factory change.
public protocol DesktopConnection: AnyObject, Sendable {
    /// Desktop device ID this connection talks to.
    var desktopId: String { get }
    /// Connection state, inbox and pairing updates. Single consumer.
    var events: AsyncStream<DesktopConnectionEvent> { get }
    /// Connects (and, for a pairing connection, runs the pair handshake).
    func start() async
    /// Disconnects and finishes `events`.
    func stop() async
    /// Asks the desktop for a fresh inbox (`inbox.get`). The result also
    /// arrives on `events`. Throws when the desktop is not reachable.
    func refresh() async throws
    /// The app came to the foreground: reconnect now instead of waiting out
    /// the relay backoff (§8.3), and retry a handshake that is backing off.
    func reconnectNow() async

    /// Sends `{ t:"req", id, op, params }` and waits for the matching `res`.
    /// Returns `result` on `ok:true`; throws `DesktopConnectionError.remote`
    /// for `ok:false`, `.timeout` when no answer comes within `timeout`,
    /// `.connectionLost` when the session drops first, and `.notConnected` /
    /// `.desktopOffline` when there is no session to send on.
    func request(_ op: String, params: JSONValue?, timeout: Duration) async throws -> JSONValue

    /// A new stream of chat events and session changes. Any number of
    /// subscribers; each gets every event from the moment it subscribes, and
    /// the stream ends with `stop()`.
    func chatEvents() async -> AsyncStream<ChatStreamEvent>
}

/// What a chat subscriber sees (`DesktopConnection.chatEvents()`).
public enum ChatStreamEvent: Sendable, Equatable {
    /// An `evt chat` from the desktop (for any tab; filter by `tabId`).
    case chat(ChatEvent)
    /// A session with the desktop was (re)established. Subscriptions made on
    /// an earlier session are gone, so an open chat must `chat.open` again.
    case sessionStarted
    /// The session ended (desktop offline, relay reconnecting, …).
    case sessionLost
}

extension DesktopConnection {
    /// Default request timeout (§6.3 ops).
    public static var defaultRequestTimeout: Duration { .seconds(15) }

    public func request(_ op: String, params: JSONValue? = nil) async throws -> JSONValue {
        try await request(op, params: params, timeout: Self.defaultRequestTimeout)
    }

    private func decode<T>(_ value: JSONValue, _ parse: (JSONValue) throws(ProtocolError) -> T) throws -> T {
        do {
            return try parse(value)
        } catch {
            throw DesktopConnectionError.badResponse(error.message)
        }
    }

    // MARK: Chat (§6.3)

    /// `chat.open`: subscribes this phone to the tab's chat events (one open
    /// chat per phone) and returns the windowed view with its `seq`.
    public func openChat(tabId: String) async throws -> ChatOpenResult {
        let result = try await request(ChatOp.open, params: .object(["tabId": .string(tabId)]))
        return try decode(result, ChatOpenResult.parse)
    }

    public func closeChat(tabId: String) async throws {
        _ = try await request(ChatOp.close, params: .object(["tabId": .string(tabId)]))
    }

    /// `chat.earlier`: up to `limit` (≤ 100) items before `before`.
    public func earlierChatItems(tabId: String, before itemId: String, limit: Int? = nil) async throws -> ChatEarlierResult {
        var params: JSONObject = ["tabId": .string(tabId), "before": .string(itemId)]
        if let limit { params["limit"] = .int(Int64(max(1, min(limit, ChatOp.maxEarlierLimit)))) }
        let result = try await request(ChatOp.earlier, params: .object(params))
        return try decode(result, ChatEarlierResult.parse)
    }

    /// `chat.send`: `text` is at most 32000 chars.
    public func sendChat(tabId: String, text: String) async throws {
        guard text.count <= ChatOp.maxSendLength else {
            throw DesktopConnectionError.remote(code: AppErrorCode.badRequest, message: "Messages are limited to \(ChatOp.maxSendLength) characters.")
        }
        _ = try await request(ChatOp.send, params: .object(["tabId": .string(tabId), "text": .string(text)]))
    }

    /// `chat.answer`. An already-answered prompt throws `.remote(code: "gone")`.
    public func answerChat(tabId: String, promptId: String, answer: ChatAnswer, timeout: Duration? = nil) async throws {
        _ = try await request(ChatOp.answer, params: .object([
            "tabId": .string(tabId), "promptId": .string(promptId), "answer": answer.json,
        ]), timeout: timeout ?? Self.defaultRequestTimeout)
    }

    public func interruptChat(tabId: String) async throws {
        _ = try await request(ChatOp.interrupt, params: .object(["tabId": .string(tabId)]))
    }

    /// `chat.new` (§8.2): adds a claude-chat tab to the task and returns its
    /// ID. The tab shows up in the next inbox; `chat.open` starts it.
    public func newChat(taskId: String) async throws -> String {
        let result = try await request(ChatOp.new, params: ChatNewParams(taskId: taskId).json)
        return try decode(result, ChatNewResult.parse).tabId
    }

    /// `task.new` (§8.4): a new task in the project, named after `prompt`, whose
    /// Claude chat starts on it. The desktop answers once the prompt is sent,
    /// which includes starting Claude, so this waits longer than other ops; a
    /// retry after a timeout could make a second task.
    /// With `workspace` (§8.6) the desktop first creates a worktree on a new
    /// branch named after the prompt.
    public func newTask(projectId: String, prompt: String, mode: String? = nil, workspace: Bool = false) async throws -> TaskNewResult {
        guard prompt.utf16.count <= ChatOp.maxSendLength else {
            throw DesktopConnectionError.remote(code: AppErrorCode.badRequest, message: "Prompts are limited to \(ChatOp.maxSendLength) characters.")
        }
        let params = TaskNewParams(projectId: projectId, prompt: prompt, mode: mode, workspace: workspace)
        let result = try await request(TaskOp.new, params: params.json, timeout: .seconds(60))
        return try decode(result, TaskNewResult.parse)
    }

    /// `task.close` (§8.7): delete the task, and its worktree for a workspace.
    /// Work that would be lost comes back as `.blocked` until it is discarded.
    /// Git can take a while, so this waits longer than other ops.
    public func closeTask(_ params: TaskCloseParams) async throws -> TaskCloseResult {
        let result = try await request(TaskOp.close, params: params.json, timeout: .seconds(60))
        return try decode(result, TaskCloseResult.parse)
    }

    /// `tab.close` (§8.8): close one agent or terminal tab; the task stays.
    public func closeTab(tabId: String) async throws {
        _ = try await request(TaskOp.closeTab, params: .object(["tabId": .string(tabId)]))
    }

    /// `pin.set` (§8.10): pin or unpin a project, or its task when `taskId` is
    /// set. The new list comes back in the next inbox.
    public func setPin(_ pin: InboxPin, pinned: Bool) async throws {
        _ = try await request(TaskOp.setPin, params: PinSetParams(pin: pin, pinned: pinned).json)
    }

    /// `chat.settings` (§8.5): change the chat's permission mode, model or
    /// effort as the desktop's pickers do. Nil leaves a field as it is; ""
    /// for `model` or `effort` goes back to the default. The new values come
    /// back in the next `evt chat`.
    public func updateChatSettings(tabId: String, mode: String? = nil, model: String? = nil, effort: String? = nil) async throws {
        let params = ChatSettingsParams(tabId: tabId, mode: mode, model: model, effort: effort)
        _ = try await request(ChatOp.settings, params: params.json)
    }

    /// `chat.image` (§8.9): one image a tool result carried, its longest side
    /// at most `maxSide` pixels. Full-size images can take a while to encode
    /// and arrive in several fragments, so this waits longer than other ops.
    public func chatImage(tabId: String, itemId: String, index: Int, maxSide: Int) async throws -> ChatImageResult {
        let params = ChatImageParams(tabId: tabId, itemId: itemId, index: index, maxSide: maxSide)
        let result = try await request(ChatOp.image, params: params.json, timeout: .seconds(60))
        return try decode(result, ChatImageResult.parse)
    }

    /// `chat.detail`: a tool's full input/result, or a truncated item's full text.
    public func chatDetail(tabId: String, itemId: String) async throws -> ChatDetail {
        let result = try await request(ChatOp.detail, params: .object(["tabId": .string(tabId), "itemId": .string(itemId)]))
        return try decode(result, ChatDetail.parse)
    }
}

/// Creates connections. The app picks an implementation at launch.
public protocol DesktopConnectionFactory: Sendable {
    /// A connection that resumes an existing pairing (`kind: "resume"`).
    func connection(for desktop: DesktopRecord) -> any DesktopConnection
    /// A connection that pairs using a scanned invite (`kind: "pair"`).
    /// It reports `.pairing(.pending)` and later `.pairing(.accepted)` or
    /// `.pairing(.rejected)`; once accepted it stays open as a normal session.
    func pairingConnection(for invite: PairingInvite, deviceName: String) -> any DesktopConnection
}

public enum DesktopConnectionError: Error, Sendable, Equatable, LocalizedError {
    case notConnected
    case desktopOffline
    /// `res` with `ok:false`. `code` is an open string (`AppErrorCode`).
    case remote(code: String, message: String)
    /// No `res` within the request timeout.
    case timeout
    /// The session dropped before the `res` arrived.
    case connectionLost
    /// The `res` result didn't have the op's shape.
    case badResponse(String)

    /// The `error.code` of a remote failure.
    public var remoteCode: String? {
        if case .remote(let code, _) = self { return code }
        return nil
    }

    public var errorDescription: String? {
        switch self {
        case .notConnected: "Not connected to the desktop."
        case .desktopOffline: "The desktop is offline."
        case .remote(let code, let message):
            if !message.isEmpty { message } else {
                switch code {
                case AppErrorCode.notFound: "Not found on the desktop."
                case AppErrorCode.gone: "Already answered."
                case AppErrorCode.unsupported: "The desktop doesn't support this. Update DevTool."
                case AppErrorCode.notAuthorized: "The desktop hasn't accepted this phone yet."
                default: "The desktop reported an error (\(code))."
                }
            }
        case .timeout: "The desktop didn't answer in time."
        case .connectionLost: "The connection to the desktop dropped."
        case .badResponse: "Unexpected answer from the desktop."
        }
    }
}
