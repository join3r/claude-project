import Foundation
@testable import DevToolKit

/// An in-process relay (SPEC.md §3) plus scripted desktops (SPEC.md §4, responder
/// side), so `RelayClient` and `RelayDesktopConnection` can be tested
/// without a network. The desktop logic follows `protocol/tools/fake-desktop-core.ts`.
actor FakeRelay: WebSocketConnector {
    final class Socket: WebSocketTransport, @unchecked Sendable {
        let relay: FakeRelay
        let incoming: AsyncStream<String>
        private let continuation: AsyncStream<String>.Continuation
        private var iterator: AsyncStream<String>.Iterator
        private let lock = NSLock()
        private var closeCode: Int?

        init(relay: FakeRelay) {
            self.relay = relay
            (incoming, continuation) = AsyncStream.makeStream()
            iterator = incoming.makeAsyncIterator()
        }

        func send(_ text: String) async throws {
            if lock.withLock({ closeCode }) != nil { throw WebSocketClosed(code: closeCode, reason: "closed") }
            await relay.received(text, from: self)
        }

        func receive() async throws -> String {
            // Single reader (the client's receive loop).
            var it = lock.withLock { iterator }
            let next = await it.next()
            lock.withLock { iterator = it }
            guard let next else { throw WebSocketClosed(code: lock.withLock { closeCode }, reason: "closed") }
            return next
        }

        func close(code: Int) {
            serverClose(code: code)
            Task { await relay.closed(self) }
        }

        /// The relay pushes a message to the client.
        func push(_ text: String) {
            continuation.yield(text)
        }

        func serverClose(code: Int) {
            lock.withLock { if closeCode == nil { closeCode = code } }
            continuation.finish()
        }
    }

    final class Desktop: @unchecked Sendable {
        struct Session {
            var transport: NoiseTransport
            var accepted: Bool
            var seq: Int64 = 0
        }

        let identity = DeviceIdentity.generate()
        let name: String
        var online = true
        var autoAccept = true
        var reply: (v: Int, min: Int) = (AppProtocol.version, AppProtocol.minVersion)
        var lastSeen: Int64 = 1_790_000_000_000
        var pairProof: Data?
        let secret = Data((0..<32).map { _ in UInt8.random(in: 0...255) })
        /// phone id → phone X25519 pub.
        var pairings: [String: Data] = [:]
        var sessions: [String: Session] = [:]
        var handshakes = 0
        var tick = 0
        /// §6.1 reassembly and fragment ids, per phone session.
        var reassemblers: [String: Reassembler] = [:]
        var fragmentIds: [String: UInt32] = [:]
        /// The canned claude-chat tab (see `FakeChat`).
        var chat = FakeChat()
        /// Ops the desktop receives but never answers (to exercise timeouts).
        var silentOps: Set<String> = []
        /// Every req the desktop got, in order.
        var requests: [(op: String, params: JSONValue?)] = []
        /// The last `push.register` (nil after `push.unregister`).
        var pushRegistration: PushRegisterParams?
        /// The hello's `features` (§8.1).
        var features: [String] = [DesktopFeature.taskNew]
        /// The hello's `app` (§4.3); `devtool-server/…` makes it a server.
        var helloApp = "fake/1"
        /// Tabs added with `task.new`, at the end of task `t`.
        var newTabs: [String] = []
        var streamNewParams: [StreamNewParams] = []
        var taskNewParams: [TaskNewParams] = []
        var taskCloseParams: [TaskCloseParams] = []
        var taskLandParams: [TaskLandParams] = []
        var closedTabs: [String] = []
        var pinSetParams: [PinSetParams] = []
        var taskTriageParams: [TaskTriageParams] = []

        var id: String { identity.deviceId }

        init(name: String) {
            self.name = name
        }

        var invite: PairingInvite {
            PairingInvite(
                relayURL: URL(string: "ws://fake.relay")!, desktopId: id,
                desktopX25519PublicKey: identity.x25519.pub, desktopEd25519PublicKey: identity.ed25519.pub,
                secret: secret, desktopName: name, expiresAt: Date().addingTimeInterval(300)
            )
        }

        func offer() {
            pairProof = Derive.pairProof(secret: secret)
        }

        var inbox: Inbox {
            Inbox(desktop: InboxDesktop(id: id, name: name), generatedAt: 1_790_000_000_000 + Int64(tick), projects: [
                InboxProject(id: "p", name: "api-server", tasks: [
                    InboxTask(id: "t", name: "fix-auth", tabs: [
                        InboxTab(id: "tab", type: .claudeChat, title: "Claude", status: tick % 2 == 0 ? .working : .attention),
                    ] + newTabs.map { InboxTab(id: $0, type: .claudeChat, title: "Claude", status: .idle) }),
                ]),
            ])
        }

        /// Returns the frames (envelopes) to send back to `from`.
        func handle(_ data: Data, from: String) -> [Data] {
            guard let envelope = try? Envelope.decode(data) else { return [frame(.reset)] }
            switch envelope.kind {
            case .handshake1:
                return handshake(envelope.body, from: from)
            case .transport:
                guard var session = sessions[from] else { return [frame(.reset)] }
                guard let plaintext = try? session.transport.decrypt(envelope.body) else {
                    sessions[from] = nil
                    return [frame(.reset)]
                }
                sessions[from] = session
                var reassembler = reassemblers[from] ?? Reassembler()
                let output = reassembler.receive(plaintext)
                reassemblers[from] = reassembler
                guard case .message(let json) = output,
                      case .req(let id, let op, let params)? = try? AppMessage.parse(json) else { return [] }
                requests.append((op, params))
                if !session.accepted {
                    return app(.resError(id: id, code: AppErrorCode.notAuthorized, message: "Pairing not accepted yet"), to: from)
                }
                if silentOps.contains(op) { return [] }
                if op == AppOp.inboxGet { return app(.resOk(id: id, result: inbox.json), to: from) }
                if PushOp.all.contains(op) {
                    if op == PushOp.register {
                        do {
                            pushRegistration = try PushRegisterParams.parse(params)
                        } catch {
                            return app(.resError(id: id, code: AppErrorCode.badRequest, message: error.message), to: from)
                        }
                    } else {
                        pushRegistration = nil
                    }
                    return app(.resOk(id: id, result: .object([:])), to: from)
                }
                if op == TaskOp.newStream || op == TaskOp.listBranches {
                    let feature = op == TaskOp.newStream ? DesktopFeature.streamNew : DesktopFeature.branchesList
                    guard features.contains(feature) else {
                        return app(.resError(id: id, code: AppErrorCode.unsupported, message: "Unknown op \(op)"), to: from)
                    }
                    if op == TaskOp.listBranches {
                        guard case .object(let o)? = params, case .string(let projectId)? = o["projectId"] else {
                            return app(.resError(id: id, code: AppErrorCode.badRequest, message: "projectId must be a string"), to: from)
                        }
                        // "p" has worktrees; "shell" runs a shell command, so it has none.
                        if projectId == "shell" {
                            return app(.resError(id: id, code: AppErrorCode.unsupported, message: "No worktrees"), to: from)
                        }
                        guard projectId == "p" else { return app(.resError(id: id, code: AppErrorCode.notFound, message: "No such project"), to: from) }
                        return app(.resOk(id: id, result: BranchesListResult(branches: ["dev", "main"], defaultBase: "main").json), to: from)
                    }
                    let parsed: StreamNewParams
                    do {
                        parsed = try StreamNewParams.parse(params)
                    } catch {
                        return app(.resError(id: id, code: AppErrorCode.badRequest, message: error.message), to: from)
                    }
                    guard parsed.projectId == "p" else { return app(.resError(id: id, code: AppErrorCode.notFound, message: "No such project"), to: from) }
                    streamNewParams.append(parsed)
                    return app(.resOk(id: id, result: StreamNewResult(streamId: "s-new-\(streamNewParams.count)").json), to: from)
                }
                if op == TaskOp.new {
                    guard features.contains(DesktopFeature.taskNew) else {
                        return app(.resError(id: id, code: AppErrorCode.unsupported, message: "Unknown op \(op)"), to: from)
                    }
                    let parsed: TaskNewParams
                    do {
                        parsed = try TaskNewParams.parse(params)
                    } catch {
                        return app(.resError(id: id, code: AppErrorCode.badRequest, message: error.message), to: from)
                    }
                    guard parsed.projectId == "p" else { return app(.resError(id: id, code: AppErrorCode.notFound, message: "No such project"), to: from) }
                    taskNewParams.append(parsed)
                    let tabId = "tab-new-\(newTabs.count + 1)"
                    newTabs.append(tabId)
                    return app(.resOk(id: id, result: TaskNewResult(taskId: "task-new", tabId: tabId).json), to: from)
                }
                if op == TaskOp.close || op == TaskOp.closeTab {
                    let feature = op == TaskOp.close ? DesktopFeature.taskClose : DesktopFeature.tabClose
                    guard features.contains(feature) else {
                        return app(.resError(id: id, code: AppErrorCode.unsupported, message: "Unknown op \(op)"), to: from)
                    }
                    if op == TaskOp.closeTab {
                        guard case .object(let o)? = params, case .string(let tabId)? = o["tabId"] else {
                            return app(.resError(id: id, code: AppErrorCode.badRequest, message: "tabId must be a string"), to: from)
                        }
                        closedTabs.append(tabId)
                        return app(.resOk(id: id, result: .object([:])), to: from)
                    }
                    let parsed: TaskCloseParams
                    do {
                        parsed = try TaskCloseParams.parse(params)
                    } catch {
                        return app(.resError(id: id, code: AppErrorCode.badRequest, message: error.message), to: from)
                    }
                    taskCloseParams.append(parsed)
                    // "w" has a worktree of its own whose landing conflicts (version 3).
                    if parsed.taskId == "w" {
                        let landing = TaskLanding(state: .conflict, intent: .close, files: ["a.ts"], fileCount: 1)
                        return app(.resOk(id: id, result: TaskCloseResult.landing(landing).json), to: from)
                    }
                    // "t" has a working agent until the phone says to stop it.
                    let result: TaskCloseResult = parsed.stopWorking ? .closed : .blocked(.working)
                    return app(.resOk(id: id, result: result.json), to: from)
                }
                if op == TaskOp.land {
                    guard features.contains(DesktopFeature.taskLand) else {
                        return app(.resError(id: id, code: AppErrorCode.unsupported, message: "Unknown op \(op)"), to: from)
                    }
                    let parsed: TaskLandParams
                    do {
                        parsed = try TaskLandParams.parse(params)
                    } catch {
                        return app(.resError(id: id, code: AppErrorCode.badRequest, message: error.message), to: from)
                    }
                    taskLandParams.append(parsed)
                    let result: TaskLandResult
                    switch parsed.action {
                    case .fixWithAgent: result = TaskLandResult(status: .fixing, landing: TaskLanding(state: .fixing, files: ["a.ts"], fileCount: 1))
                    case .abort: result = TaskLandResult(status: .aborted)
                    case .retry: result = TaskLandResult(status: .landed, closed: true)
                    }
                    return app(.resOk(id: id, result: result.json), to: from)
                }
                if op == TaskOp.setPin {
                    guard features.contains(DesktopFeature.pin) else {
                        return app(.resError(id: id, code: AppErrorCode.unsupported, message: "Unknown op \(op)"), to: from)
                    }
                    let parsed: PinSetParams
                    do {
                        parsed = try PinSetParams.parse(params)
                    } catch {
                        return app(.resError(id: id, code: AppErrorCode.badRequest, message: error.message), to: from)
                    }
                    pinSetParams.append(parsed)
                    return app(.resOk(id: id, result: .object([:])), to: from)
                }
                if op == TaskOp.triage {
                    guard features.contains(DesktopFeature.taskTriage) else {
                        return app(.resError(id: id, code: AppErrorCode.unsupported, message: "Unknown op \(op)"), to: from)
                    }
                    let parsed: TaskTriageParams
                    do {
                        parsed = try TaskTriageParams.parse(params)
                    } catch {
                        return app(.resError(id: id, code: AppErrorCode.badRequest, message: error.message), to: from)
                    }
                    taskTriageParams.append(parsed)
                    return app(.resOk(id: id, result: .object([:])), to: from)
                }
                if let replies = chat.handle(id: id, op: op, params: params) {
                    return replies.flatMap { app($0, to: from) }
                }
                return app(.resError(id: id, code: AppErrorCode.unsupported, message: "Unknown op \(op)"), to: from)
            case .reset:
                sessions[from] = nil
                return []
            case .handshake2:
                return []
            }
        }

        private func handshake(_ message: Data, from: String) -> [Data] {
            sessions[from] = nil
            reassemblers[from] = nil
            fragmentIds[from] = nil
            chat.subscribed = false
            handshakes += 1
            guard var responder = try? HandshakeState.responder(s: identity.x25519),
                  let payload = try? responder.readMessage(message)
            else { return [] } // Dropped silently (§4.3).
            let rs = responder.remoteStatic!
            var result: HandshakeResult
            if case .incompatible = VersionNegotiation.negotiate(
                local: VersionInfo(v: reply.v, min: reply.min), remote: (try? VersionInfo.parse(payload)) ?? VersionInfo(v: 1, min: 1)) {
                result = .incompatible
            } else if let hello = try? PhoneHello.parse(payload) {
                if (try? Derive.deviceId(ed25519Pub: Base64URL.decode(hello.ed) ?? Data())) != from {
                    result = .rejected
                } else if hello.kind == .resume {
                    result = pairings[from] == rs ? .ok : .unknownDevice
                } else if let proof = pairProof, let sent = Base64URL.decode(hello.proof ?? ""), Primitives.constantTimeEqual(proof, sent) {
                    pairProof = nil
                    result = .pending
                } else {
                    result = .rejected
                }
            } else {
                result = .rejected
            }
            let reply = DesktopHello(v: reply.v, min: reply.min, app: helloApp, features: features, desktopName: name, result: result)
            guard let msg2 = try? responder.writeMessage(reply.json.jsonData) else { return [] }
            var out = [frame(.handshake2, msg2)]
            guard result == .ok || result == .pending, let transport = try? responder.split() else { return out }
            sessions[from] = Session(transport: transport, accepted: result == .ok)
            if result == .pending, autoAccept {
                out += accept(from, rs: rs)
            }
            return out
        }

        func accept(_ phone: String, rs: Data? = nil) -> [Data] {
            guard var session = sessions[phone] else { return [] }
            pairings[phone] = rs ?? session.transport.remoteStatic
            session.accepted = true
            sessions[phone] = session
            return app(.pairing(.accepted), to: phone)
        }

        func pushInbox() -> [(String, Data)] {
            tick += 1
            var out: [(String, Data)] = []
            for (phone, var session) in sessions where session.accepted {
                session.seq += 1
                sessions[phone] = session
                out += app(.inbox(seq: session.seq, inbox: inbox), to: phone).map { (phone, $0) }
            }
            return out
        }

        func app(_ message: AppMessage, to phone: String) -> [Data] {
            guard var session = sessions[phone] else { return [] }
            let id = fragmentIds[phone] ?? 0
            guard let plaintexts = try? Fragmentation.encode(message.encoded, id: id) else { return [] }
            if plaintexts.count > 1 { fragmentIds[phone] = id &+ 1 }
            var out: [Data] = []
            for plaintext in plaintexts {
                guard let ciphertext = try? session.transport.encrypt(plaintext) else { return [] }
                out.append(frame(.transport, ciphertext))
            }
            sessions[phone] = session
            return out
        }

        /// Pushes chat events the desktop produced on its own (a streamed reply) to subscribed phones.
        func pushChat(_ edit: (inout FakeChat) -> [AppMessage]) -> [(String, Data)] {
            let messages = edit(&chat)
            guard chat.subscribed else { return [] }
            var out: [(String, Data)] = []
            for (phone, session) in sessions where session.accepted {
                for message in messages { out += app(message, to: phone).map { (phone, $0) } }
            }
            return out
        }

        func frame(_ kind: FrameKind, _ body: Data = Data()) -> Data {
            (try? Envelope(kind: kind, body: body).encode()) ?? Data()
        }
    }

    private var challenges: [ObjectIdentifier: String] = [:]
    private var phones: [ObjectIdentifier: (socket: Socket, id: String, pair: RelayPair?)] = [:]
    private var desktops: [String: Desktop] = [:]
    private(set) var connectionCount = 0
    private(set) var hellos: [RelayClientMessage] = []

    func add(_ desktop: Desktop) {
        desktops[desktop.id] = desktop
    }

    nonisolated func open(_ url: URL) -> any WebSocketTransport {
        let socket = Socket(relay: self)
        Task { await self.opened(socket) }
        return socket
    }

    private func opened(_ socket: Socket) {
        connectionCount += 1
        let nonce = Data((0..<32).map { _ in UInt8.random(in: 0...255) }).base64URLEncodedString
        challenges[ObjectIdentifier(socket)] = nonce
        socket.push(RelayServerMessage.challenge(nonce: nonce).text)
    }

    func closed(_ socket: Socket) {
        phones[ObjectIdentifier(socket)] = nil
    }

    var openPhoneSockets: Int { phones.count }

    func received(_ text: String, from socket: Socket) {
        guard let message = try? RelayClientMessage.parse(text) else {
            socket.push(RelayServerMessage.error(code: .badRequest, message: nil, to: nil).text)
            return
        }
        let key = ObjectIdentifier(socket)
        switch message {
        case .hello(let role, let pub, let sig, let pair):
            hellos.append(message)
            guard role == .phone, let nonce = challenges[key],
                  let id = RelayProtocol.verifyHello(pub: pub, sig: sig, role: role, nonce: nonce)
            else {
                socket.push(RelayServerMessage.error(code: .auth, message: "bad signature", to: nil).text)
                socket.serverClose(code: RelayProtocol.CloseCode.auth)
                return
            }
            // §3.5: a second connection with the same device ID replaces the first.
            for (other, phone) in phones where phone.id == id && other != key {
                phone.socket.serverClose(code: RelayProtocol.CloseCode.replaced)
                phones[other] = nil
            }
            phones[key] = (socket, id, pair)
            socket.push(RelayServerMessage.ready(id: id).text)
        case .watch(let ids):
            for id in ids {
                guard let desktop = desktops[id] else { continue }
                socket.push(RelayServerMessage.peer(id: id, state: desktop.online ? .online : .offline,
                                                    lastSeen: desktop.online ? nil : desktop.lastSeen).text)
            }
        case .frame(let to, let data):
            guard let phone = phones[key] else { return }
            guard let desktop = desktops[to] else {
                socket.push(RelayServerMessage.error(code: .forbidden, message: nil, to: to).text)
                return
            }
            guard desktop.online else {
                socket.push(RelayServerMessage.error(code: .offline, message: nil, to: to).text)
                return
            }
            for reply in desktop.handle(Base64URL.decode(data) ?? Data(), from: phone.id) {
                socket.push(RelayServerMessage.frame(from: to, data: reply.base64URLEncodedString).text)
            }
        case .ping:
            socket.push(RelayServerMessage.pong.text)
        default:
            break
        }
    }

    // MARK: Test controls

    func pushChat(_ desktop: Desktop, _ edit: (inout FakeChat) -> [AppMessage]) {
        for (phoneId, frame) in desktop.pushChat(edit) {
            send(from: desktop.id, to: phoneId, frame)
        }
    }

    func pushInbox(_ desktop: Desktop) {
        for (phoneId, frame) in desktop.pushInbox() {
            send(from: desktop.id, to: phoneId, frame)
        }
    }

    func send(from desktopId: String, to phoneId: String, _ frame: Data) {
        for phone in phones.values where phone.id == phoneId {
            phone.socket.push(RelayServerMessage.frame(from: desktopId, data: frame.base64URLEncodedString).text)
        }
    }

    func setOnline(_ desktop: Desktop, _ online: Bool) {
        desktop.online = online
        if !online { desktop.sessions = [:] }
        for phone in phones.values {
            phone.socket.push(RelayServerMessage.peer(id: desktop.id, state: online ? .online : .offline,
                                                      lastSeen: online ? nil : desktop.lastSeen).text)
        }
    }

    func revoke(_ desktop: Desktop, phone phoneId: String) {
        desktop.pairings[phoneId] = nil
        desktop.sessions[phoneId] = nil
        for phone in phones.values where phone.id == phoneId {
            phone.socket.push(RelayServerMessage.peer(id: desktop.id, state: .revoked, lastSeen: nil).text)
        }
    }

    /// What the real relay does when a pending phone's window ends without
    /// `authorize` (§3.7): `error forbidden` addressed to the desktop, then 4403.
    func lapsePairing(_ desktop: Desktop, phone phoneId: String) {
        for (key, phone) in phones where phone.id == phoneId {
            phone.socket.push(RelayServerMessage.error(code: .forbidden, message: "pairing window expired", to: desktop.id).text)
            phone.socket.serverClose(code: RelayProtocol.CloseCode.pairingExpired)
            phones[key] = nil
        }
    }

    /// Pushes raw JSON text to every socket of `phoneId`, e.g. values a newer relay may send.
    func pushRaw(_ text: String, to phoneId: String) {
        for phone in phones.values where phone.id == phoneId { phone.socket.push(text) }
    }

    /// Drops every phone socket, as a relay restart would.
    func dropAll() {
        for phone in phones.values { phone.socket.serverClose(code: 1001) }
        phones = [:]
    }

    /// The desktop forgets its session with `phoneId` and says so with a reset.
    func resetSession(_ desktop: Desktop, phone phoneId: String) {
        desktop.sessions[phoneId] = nil
        send(from: desktop.id, to: phoneId, desktop.frame(.reset))
    }
}

/// Collects a connection's events so tests can wait for one.
actor EventRecorder {
    private(set) var events: [DesktopConnectionEvent] = []
    private var task: Task<Void, Never>?

    init(_ connection: any DesktopConnection) {
        let stream = connection.events
        Task { await self.consume(stream) }
    }

    private func consume(_ stream: AsyncStream<DesktopConnectionEvent>) async {
        for await event in stream { events.append(event) }
    }

    /// Waits until `predicate` holds for some event recorded after `index`;
    /// returns the index just past it.
    @discardableResult
    func waitFor(after index: Int = 0, timeout: Duration = .seconds(5), _ predicate: @Sendable (DesktopConnectionEvent) -> Bool) async throws -> Int {
        let deadline = ContinuousClock.now + timeout
        while ContinuousClock.now < deadline {
            if let found = events.indices.first(where: { $0 >= index && predicate(events[$0]) }) { return found + 1 }
            try await Task.sleep(for: .milliseconds(5))
        }
        throw TimeoutError(events: events)
    }

    struct TimeoutError: Error, CustomStringConvertible {
        let events: [DesktopConnectionEvent]
        var description: String { "timed out; events so far: \(events)" }
    }

    var count: Int { events.count }
}

/// The desktop side of one claude-chat tab (`tab-chat`), following SPEC.md §6.3–§6.4.
struct FakeChat {
    var tabId = "tab-chat"
    var items: [ChatItem] = (1...70).map { ChatItem(id: "old\($0)", .text(markdown: "Earlier message \($0)", streaming: false)) }
    var prompts: [ChatPrompt] = []
    var status = ChatStatus(busy: false, process: .running, model: "claude-opus-4-5")
    var seq: Int64 = 10
    var subscribed = false
    var nextId = 1
    /// Texts received through `chat.send`.
    var sent: [String] = []
    var answers: [(promptId: String, answer: ChatAnswer)] = []

    static let window = 60

    var view: ChatView {
        ChatView(tabId: tabId, title: "Claude", status: status, items: Array(items.suffix(Self.window)),
                 hasEarlier: items.count > Self.window, prompts: prompts)
    }

    mutating func makeId(_ prefix: String) -> String {
        defer { nextId += 1 }
        return "\(prefix)\(nextId)"
    }

    /// Records a change and returns its event.
    mutating func event(upserts: [ChatItem] = [], removes: [String] = []) -> AppMessage {
        items.removeAll { removes.contains($0.id) }
        for item in upserts {
            if let index = items.firstIndex(where: { $0.id == item.id }) { items[index] = item } else { items.append(item) }
        }
        seq += 1
        return .chat(ChatEvent(tabId: tabId, seq: seq, upserts: upserts, removes: removes, prompts: prompts, status: status))
    }

    private func error(_ id: Int64, _ code: String, _ message: String = "") -> [AppMessage] {
        [.resError(id: id, code: code, message: message)]
    }

    /// Replies for a chat op (the `res` first, then any events), or nil when `op` isn't a chat op.
    mutating func handle(id: Int64, op: String, params: JSONValue?) -> [AppMessage]? {
        let parsed: ChatParams?
        do {
            parsed = try ChatParams.parse(op: op, params)
        } catch {
            return self.error(id, AppErrorCode.badRequest, error.message)
        }
        guard let parsed else { return nil }
        guard parsed.tabId == tabId else { return self.error(id, AppErrorCode.notFound, "No such tab") }
        let ok: AppMessage = .resOk(id: id, result: .object([:]))
        switch parsed {
        case .tab(ChatOp.open, _):
            subscribed = true
            return [.resOk(id: id, result: ChatOpenResult(seq: seq, view: view).json)]
        case .tab(ChatOp.close, _):
            subscribed = false
            return [ok]
        case .tab(_, _): // interrupt
            status.busy = false
            status.turnStartedAt = nil
            let notice = ChatItem(id: makeId("n"), .notice(text: "Interrupted", tone: .muted))
            return [ok, event(upserts: [notice])]
        case .earlier(_, let before, let limit):
            guard let index = items.firstIndex(where: { $0.id == before }) else { return self.error(id, AppErrorCode.notFound) }
            let start = max(0, index - (limit ?? 100))
            return [.resOk(id: id, result: ChatEarlierResult(items: Array(items[start..<index]), hasEarlier: start > 0).json)]
        case .send(_, let text):
            sent.append(text)
            status.busy = true
            status.turnStartedAt = 1_790_000_000_000
            let user = ChatItem(id: makeId("u"), .user(text: String(text.prefix(16_000)), images: nil, queued: false, failed: false))
            let replyId = makeId("a")
            let tool = ChatItem(id: makeId("t"), .tool(ChatTool(name: "Bash", summary: "Bash · ls", status: .waiting, hasDetail: true)))
            let reply = text == "long"
                ? String(repeating: "All work and no play makes Jack a dull boy. ", count: 2_000) // ~90 KB: fragmented
                : "Sure."
            var out: [AppMessage] = [ok, event(upserts: [user])]
            out.append(event(upserts: [ChatItem(id: replyId, .text(markdown: String(reply.prefix(10)), streaming: true))]))
            prompts = [ChatPrompt(id: "req-1", .permission(ChatPermission(toolName: "Bash", title: "Run a command", summary: "ls", canAlwaysAllow: true)))]
            out.append(event(upserts: [ChatItem(id: replyId, .text(markdown: reply, streaming: false)), tool]))
            return out
        case .answer(_, let promptId, let answer):
            guard prompts.contains(where: { $0.id == promptId }) else {
                return self.error(id, AppErrorCode.gone, "Already answered")
            }
            answers.append((promptId, answer))
            prompts.removeAll { $0.id == promptId }
            status.busy = false
            return [ok, event()]
        case .detail(_, let itemId):
            guard let item = items.first(where: { $0.id == itemId }) else { return self.error(id, AppErrorCode.notFound) }
            if case .tool = item.content { return [.resOk(id: id, result: ChatDetail.tool(input: "{\n  \"command\": \"ls\"\n}", result: "a\nb").json)] }
            return [.resOk(id: id, result: .object(["kind": "text", "markdown": .string(item.id)]))]
        }
    }
}
