import DevToolKit
import Foundation
import Observation
import UIKit

/// App-wide state: paired desktops, their cached inboxes, live connection
/// state, and the pairing flow. All UI reads from here.
@MainActor
@Observable
final class AppModel {
    private(set) var desktops: [DesktopRecord]
    private(set) var inboxes: [String: Inbox] = [:]
    private(set) var states: [String: ConnectionState] = [:]

    /// Non-nil while the pairing sheet is up.
    var pairing: PairingPhase?
    /// The chat on screen, if any (set by `ChatScreen`). Its pushes don't show as banners.
    var visibleChat: ChatRoute?
    /// A chat to navigate to (a tapped notification). `RootView` opens it and clears it.
    var requestedChat: ChatRoute?
    /// A failed Pin / Unpin (§8.10); `RootView` shows it and clears it.
    var pinError: String?
    /// A failed Settle, Snooze or Mark unread (§8.11); `RootView` shows it and clears it.
    var triageError: String?

    /// Push registration (SPEC.md §7.4); told about every established session.
    @ObservationIgnored weak var push: PushManager?
    /// "Require Face ID for approvals" (§8.3), which chat answers go through.
    @ObservationIgnored weak var security: SecuritySettings?

    @ObservationIgnored private let factory: any DesktopConnectionFactory
    @ObservationIgnored private let store: any AppPersistence
    /// Last transcripts of opened chats, shown while offline (§8.3).
    @ObservationIgnored let chatCache: any ChatCacheStore
    /// The tab IDs each desktop's cached chats were last pruned against.
    @ObservationIgnored private var prunedTabs: [String: Set<String>] = [:]
    @ObservationIgnored private var connections: [String: any DesktopConnection] = [:]
    @ObservationIgnored private var listeners: [String: Task<Void, Never>] = [:]
    @ObservationIgnored private var pairingConnection: (any DesktopConnection)?
    @ObservationIgnored private var pairingListener: Task<Void, Never>?

    init(factory: any DesktopConnectionFactory, store: any AppPersistence, chatCache: any ChatCacheStore) {
        self.factory = factory
        self.store = store
        self.chatCache = chatCache
        desktops = store.loadDesktops()
        for desktop in desktops {
            inboxes[desktop.id] = store.loadInbox(for: desktop.id)
            states[desktop.id] = .idle
        }
    }

    // MARK: - Lookup

    func desktop(_ id: String) -> DesktopRecord? {
        desktops.first { $0.id == id }
    }

    func state(of id: String) -> ConnectionState {
        states[id] ?? .idle
    }

    /// Whether the UI should treat this desktop's inbox as stale.
    func isOffline(_ id: String) -> Bool {
        switch state(of: id) {
        case .online, .connecting, .handshaking, .idle: false
        default: true
        }
    }

    func task(_ ref: TaskRef) -> (project: InboxProject, task: InboxTask)? {
        guard let inbox = inboxes[ref.desktopId] else { return nil }
        for project in inbox.projects {
            if let task = project.tasks.first(where: { $0.id == ref.taskId }) {
                return (project, task)
            }
        }
        return nil
    }

    /// The live connection to a desktop, for chat requests.
    func connection(for desktopId: String) -> (any DesktopConnection)? {
        connections[desktopId]
    }

    /// A tab and the task it belongs to.
    func tab(desktopId: String, tabId: String) -> (task: InboxTask, tab: InboxTab)? {
        guard let inbox = inboxes[desktopId] else { return nil }
        for project in inbox.projects {
            for task in project.tasks {
                if let tab = task.tabs.first(where: { $0.id == tabId }) { return (task, tab) }
            }
        }
        return nil
    }

    /// Every paired desktop's tasks in the desktop inbox's groups (§8.3), in sidebar order.
    func inboxPartition(now: Date, workingLast: Bool = false) -> InboxPartition {
        InboxPartition(desktops.compactMap { desktop in inboxes[desktop.id].map { (desktop.id, $0) } }, now: now, workingLast: workingLast)
    }

        func attentionCount(for desktopId: String) -> Int {
        inboxes[desktopId]?.projects.reduce(0) { sum, project in
            sum + project.tasks.filter { $0.status == .attention }.count
        } ?? 0
    }

    // MARK: - Connections

    func connectAll() {
        for desktop in desktops where connections[desktop.id] == nil {
            attach(factory.connection(for: desktop), desktopId: desktop.id)
        }
    }

    func refresh(_ desktopIds: [String]) async {
        for id in desktopIds {
            try? await connections[id]?.refresh()
        }
    }

    /// The app came to the foreground (§8.3): skip any relay backoff and
    /// refresh the inboxes of desktops that are still connected. The others
    /// ask for an inbox as soon as their session is back.
    func reconnectNow() async {
        for (id, connection) in connections {
            await connection.reconnectNow()
            if state(of: id) == .online { try? await connection.refresh() }
        }
    }

    /// Whether the desktop's last hello listed `feature` (§8.1).
    func supports(_ feature: String, on desktopId: String) -> Bool {
        desktop(desktopId)?.supports(feature) ?? false
    }

    /// `task.new` (§8.4): a new task in the project's stream `streamId` (nil:
    /// the one last used) whose Claude chat starts on `prompt`, and the route
    /// to that chat. The task shows up with the next inbox.
    func newTask(desktopId: String, projectId: String, streamId: String?, prompt: String, mode: String?) async throws -> ChatRoute {
        guard let connection = connections[desktopId] else { throw DesktopConnectionError.notConnected }
        let result = try await connection.newTask(projectId: projectId, streamId: streamId, prompt: prompt, mode: mode)
        return ChatRoute(desktopId: desktopId, tabId: result.tabId)
    }

    /// `stream.new` (§8.12): a new stream in the project, on a new worktree
    /// or in the project folder. Returns its ID; it shows up with the next inbox.
    func newStream(desktopId: String, projectId: String, name: String, worktree: Bool, branch: String?, baseBranch: String?) async throws -> String {
        guard let connection = connections[desktopId] else { throw DesktopConnectionError.notConnected }
        return try await connection.newStream(projectId: projectId, name: name, worktree: worktree, branch: branch, baseBranch: baseBranch)
    }

    /// `branches.list` (§8.13): the From picker's branches. `unsupported`
    /// means the project can't have worktrees.
    func listBranches(desktopId: String, projectId: String) async throws -> BranchesListResult {
        guard let connection = connections[desktopId] else { throw DesktopConnectionError.notConnected }
        return try await connection.listBranches(projectId: projectId)
    }

    /// `task.close` (§8.7): archives the task. It leaves with the next inbox.
    func closeTask(desktopId: String, _ params: TaskCloseParams) async throws -> TaskCloseResult {
        guard let connection = connections[desktopId] else { throw DesktopConnectionError.notConnected }
        return try await connection.closeTask(params)
    }

    /// `tab.close` (§8.8). The tab leaves with the next inbox.
    func closeTab(desktopId: String, tabId: String) async throws {
        guard let connection = connections[desktopId] else { throw DesktopConnectionError.notConnected }
        try await connection.closeTab(tabId: tabId)
    }

    /// `pin.set` (§8.10). The list changes at once and the next inbox
    /// confirms it; a failure puts it back and sets `pinError`.
    func setPin(_ pin: InboxPin, pinned: Bool, desktopId: String) async {
        guard let connection = connections[desktopId] else {
            pinError = DesktopConnectionError.notConnected.localizedDescription
            return
        }
        applyPin(pin, pinned: pinned, desktopId: desktopId)
        do {
            try await connection.setPin(pin, pinned: pinned)
        } catch {
            applyPin(pin, pinned: !pinned, desktopId: desktopId)
            pinError = error.localizedDescription
        }
    }

    private func applyPin(_ pin: InboxPin, pinned: Bool, desktopId: String) {
        guard var inbox = inboxes[desktopId], inbox.isPinned(pin) != pinned else { return }
        if pinned { inbox.pinned.append(pin) } else { inbox.pinned.removeAll { $0.key == pin.key } }
        inboxes[desktopId] = inbox
    }

    /// `task.triage` (§8.11). The row moves at once and the next inbox
    /// confirms it. A failure puts it back, unless an inbox has replaced it
    /// meanwhile, and sets `triageError`; a failed `read` is left to the next inbox.
    func triage(_ action: TaskTriageParams.Action, task ref: TaskRef) async {
        guard let connection = connections[ref.desktopId] else {
            if action != .read { triageError = DesktopConnectionError.notConnected.localizedDescription }
            return
        }
        let before = task(ref)?.task
        let applied = updateTask(ref) { $0.applying(action, now: Date()) }
        do {
            try await connection.triage(taskId: ref.taskId, action)
        } catch {
            guard action != .read else { return }
            if let before, let applied, task(ref)?.task == applied { updateTask(ref) { _ in before } }
            triageError = error.localizedDescription
        }
    }

    /// Opening an unread task reads it on the desktop too (§8.3).
    func markRead(_ ref: TaskRef) {
        guard supports(DesktopFeature.taskTriage, on: ref.desktopId), !isOffline(ref.desktopId),
              task(ref)?.task.unread == true else { return }
        Task { await triage(.read, task: ref) }
    }

    @discardableResult
    private func updateTask(_ ref: TaskRef, _ change: (InboxTask) -> InboxTask) -> InboxTask? {
        guard var inbox = inboxes[ref.desktopId] else { return nil }
        for p in inbox.projects.indices {
            guard let t = inbox.projects[p].tasks.firstIndex(where: { $0.id == ref.taskId }) else { continue }
            let next = change(inbox.projects[p].tasks[t])
            inbox.projects[p].tasks[t] = next
            inboxes[ref.desktopId] = inbox
            return next
        }
        return nil
    }

    // MARK: - Chat cache

    func cachedChat(_ route: ChatRoute) -> CachedChat? {
        chatCache.load(desktopId: route.desktopId, tabId: route.tabId)
    }

    /// Keeps `view` as the chat's offline transcript, unless the desktop was forgotten meanwhile.
    func cacheChat(_ view: ChatView, desktopId: String) {
        guard desktop(desktopId) != nil else { return }
        chatCache.save(CachedChat(desktopId: desktopId, view: view))
    }

    func forget(_ desktopId: String) {
        push?.forget(desktopId)
        if let connection = connections.removeValue(forKey: desktopId) {
            Task { await connection.stop() }
        }
        listeners.removeValue(forKey: desktopId)?.cancel()
        desktops.removeAll { $0.id == desktopId }
        inboxes.removeValue(forKey: desktopId)
        states.removeValue(forKey: desktopId)
        store.saveDesktops(desktops)
        store.deleteInbox(for: desktopId)
        chatCache.deleteAll(desktopId: desktopId)
        prunedTabs[desktopId] = nil
    }

    private func attach(_ connection: any DesktopConnection, desktopId: String) {
        connections[desktopId] = connection
        listeners[desktopId]?.cancel()
        listeners[desktopId] = Task { [weak self] in
            for await event in connection.events {
                guard let self else { return }
                self.handle(event, from: desktopId)
            }
        }
        Task { await connection.start() }
    }

    private func handle(_ event: DesktopConnectionEvent, from desktopId: String) {
        switch event {
        case .state(let state):
            states[desktopId] = state
            if case .offline(let lastSeen?) = state { updateLastSeen(lastSeen, for: desktopId) }
            if state == .online {
                updateLastSeen(Date(), for: desktopId)
                // Each `.online` is a fresh handshake that ended `ok` (§7.4).
                push?.sessionEstablished(desktopId)
            }
        case .inbox(let inbox):
            inboxes[desktopId] = inbox
            store.saveInbox(inbox, for: desktopId)
            // Cached chats go with their tabs.
            let tabs = Set(inbox.projects.flatMap(\.tasks).flatMap(\.tabs).map(\.id))
            if prunedTabs[desktopId] != tabs {
                prunedTabs[desktopId] = tabs
                chatCache.prune(desktopId: desktopId, keeping: tabs)
            }
            if let index = desktops.firstIndex(where: { $0.id == desktopId }),
               desktops[index].name != inbox.desktop.name, !inbox.desktop.name.isEmpty {
                desktops[index].name = inbox.desktop.name
                store.saveDesktops(desktops)
            }
        case .lastSeen(let date):
            updateLastSeen(date, for: desktopId)
        case .features(let features):
            let sorted = features.sorted()
            if let index = desktops.firstIndex(where: { $0.id == desktopId }), desktops[index].features != sorted {
                desktops[index].features = sorted
                store.saveDesktops(desktops)
            }
        case .pairing(.revoked):
            states[desktopId] = .revoked
        case .pairing:
            break
        }
    }

    private func updateLastSeen(_ date: Date, for desktopId: String) {
        guard let index = desktops.firstIndex(where: { $0.id == desktopId }) else { return }
        // Avoid rewriting the file for sub-minute changes.
        if let old = desktops[index].lastSeen, abs(old.timeIntervalSince(date)) < 60 { return }
        desktops[index].lastSeen = date
        store.saveDesktops(desktops)
    }

    // MARK: - Notification actions

    /// Answers a permission prompt from a notification action (§7.7): connects
    /// to the desktop if needed, waits for a session and sends `chat.answer`.
    /// `gone` (already answered) counts as done. Gives up at `deadline`.
    func answerFromNotification(desktopId: String, tabId: String, promptId: String, allow: Bool, deadline: ContinuousClock.Instant) async -> Bool {
        guard desktop(desktopId) != nil else { return false }
        connectAll()
        let answer: ChatAnswer = allow ? .allow(always: false) : .deny(message: nil)
        let clock = ContinuousClock()
        while clock.now < deadline {
            if let connection = connections[desktopId], state(of: desktopId) == .online {
                let remaining = deadline - clock.now
                do {
                    try await connection.answerChat(tabId: tabId, promptId: promptId, answer: answer, timeout: min(remaining, .seconds(15)))
                    return true
                } catch let error as DesktopConnectionError {
                    switch error {
                    case .remote(AppErrorCode.gone, _):
                        return true
                    case .notConnected, .desktopOffline, .connectionLost:
                        break // wait for the next session
                    default:
                        return false
                    }
                } catch {
                    return false
                }
            }
            switch state(of: desktopId) {
            case .revoked, .unknownDevice, .incompatible: return false
            default: break
            }
            try? await Task.sleep(for: .milliseconds(250))
        }
        return false
    }

    // MARK: - Pairing

    func presentPairing() {
        cancelPairingConnection()
        pairing = .scanning(error: nil)
    }

    /// Handles a scanned, pasted or opened `devtool://pair` link.
    func handlePairingLink(_ string: String) {
        do {
            let invite = try PairingInvite.parse(string, now: Date())
            cancelPairingConnection()
            pairing = .confirm(invite)
        } catch {
            pairing = .scanning(error: error.localizedDescription)
        }
    }

    func confirmPairing(_ invite: PairingInvite) {
        guard !invite.isExpired() else {
            pairing = .scanning(error: PairingInviteError.expired.localizedDescription)
            return
        }
        cancelPairingConnection()
        pairing = .waiting(invite)
        let connection = factory.pairingConnection(for: invite, deviceName: UIDevice.current.name)
        pairingConnection = connection
        // One consumer for the whole life of the connection: pairing events
        // first, then (once accepted) the normal desktop session.
        pairingListener = Task { [weak self] in
            var adopted = false
            for await event in connection.events {
                guard let self else { return }
                if adopted {
                    self.handle(event, from: invite.desktopId)
                    continue
                }
                switch self.handlePairingEvent(event, invite: invite, connection: connection) {
                case .pending: continue
                case .adopted: adopted = true
                case .finished: return
                }
            }
        }
        Task { await connection.start() }
    }

    private enum PairingEventOutcome { case pending, adopted, finished }

    private func handlePairingEvent(_ event: DesktopConnectionEvent, invite: PairingInvite, connection: any DesktopConnection) -> PairingEventOutcome {
        switch event {
        case .pairing(.accepted(let name)):
            let record = DesktopRecord(invite: invite, keysReference: KeychainStore.deviceIdentityLabel, name: name)
            desktops.removeAll { $0.id == record.id }
            desktops.append(record)
            store.saveDesktops(desktops)
            states[record.id] = .handshaking
            if let old = connections.removeValue(forKey: record.id) {
                Task { await old.stop() }
            }
            listeners.removeValue(forKey: record.id)?.cancel()
            // The accepted pairing connection keeps running as the desktop's session.
            connections[record.id] = connection
            listeners[record.id] = pairingListener
            pairingListener = nil
            pairingConnection = nil
            pairing = .paired(name: name)
            return .adopted
        case .pairing(.rejected), .pairing(.revoked), .state(.revoked):
            pairing = .failed("\(invite.desktopName) declined the pairing request.")
            cancelPairingConnection()
            return .finished
        case .state(.incompatible(let updateDesktop)):
            pairing = .failed(updateDesktop ? "Update DevTool on \(invite.desktopName) to pair." : "Update this app to pair with \(invite.desktopName).")
            cancelPairingConnection()
            return .finished
        case .state(.unknownDevice):
            pairing = .failed("\(invite.desktopName) didn't recognise this phone. Show a new pairing code.")
            cancelPairingConnection()
            return .finished
        case .state(.failed(let message)):
            pairing = .failed(message)
            cancelPairingConnection()
            return .finished
        case .state(.offline):
            pairing = .failed("\(invite.desktopName) isn't reachable through the relay.")
            cancelPairingConnection()
            return .finished
        default:
            return .pending
        }
    }

    func dismissPairing() {
        cancelPairingConnection()
        pairing = nil
    }

    private func cancelPairingConnection() {
        pairingListener?.cancel()
        pairingListener = nil
        if let connection = pairingConnection {
            pairingConnection = nil
            Task { await connection.stop() }
        }
    }
}

struct TaskRef: Hashable, Sendable {
    var desktopId: String
    var taskId: String
}

/// A claude-chat tab opened from a task's detail.
struct ChatRoute: Hashable, Sendable {
    var desktopId: String
    var tabId: String
}

enum PairingPhase: Equatable {
    case scanning(error: String?)
    case confirm(PairingInvite)
    case waiting(PairingInvite)
    case paired(name: String)
    case failed(String)
}

// MARK: - Mock data

extension AppModel {
    static let mockOnlineId = "4f1c2b9e7d6a53108e2f9c4b1a7d3e60"
    static let mockOfflineId = "9a8b7c6d5e4f30211203f4e5d6c7b8a9"

    /// Two paired desktops: one live (mock connection), one offline with a cached inbox.
    static func mock() -> AppModel {
        let now = Date()
        let lastSeen = now.addingTimeInterval(-47 * 60)
        let relay = URL(string: "wss://relay.devtool.awantech.sk")!
        let online = DesktopRecord(
            id: mockOnlineId, name: "join3r-mbp", relayURL: relay,
            desktopX25519PublicKey: Data(repeating: 1, count: 32).base64URLEncodedString,
            desktopEd25519PublicKey: Data(repeating: 2, count: 32).base64URLEncodedString,
            keysReference: KeychainStore.deviceIdentityLabel,
            pairedAt: now.addingTimeInterval(-86_400 * 3), lastSeen: now
        )
        let offline = DesktopRecord(
            id: mockOfflineId, name: "studio-mini", relayURL: relay,
            desktopX25519PublicKey: Data(repeating: 3, count: 32).base64URLEncodedString,
            desktopEd25519PublicKey: Data(repeating: 4, count: 32).base64URLEncodedString,
            keysReference: KeychainStore.deviceIdentityLabel,
            pairedAt: now.addingTimeInterval(-86_400 * 10), lastSeen: lastSeen
        )
        var cached = MockInbox.sample(desktopId: mockOfflineId, desktopName: "studio-mini", now: lastSeen)
        cached.projects = [
            InboxProject(id: "p-ml", name: "model-eval", emoji: "🧪", tasks: [
                InboxTask(id: "t-bench", name: "benchmark-suite", lastInteractedAt: lastSeen.unixMilliseconds - 300_000, tabs: [
                    InboxTab(id: "o-1", type: .claude, title: "Claude Code", status: .working, since: lastSeen.unixMilliseconds - 600_000, activity: "Running pytest", topic: "Speed up the benchmark suite"),
                    InboxTab(id: "o-2", type: .terminal, title: "zsh", status: .idle, since: lastSeen.unixMilliseconds - 900_000),
                    InboxTab(id: "o-3", type: .claudeChat, title: "Claude", status: .attention, since: lastSeen.unixMilliseconds - 120_000,
                             activity: "Wants to run pytest", topic: "Why is eval-42 flaky?"),
                ]),
            ]),
        ]
        let store = InMemoryAppStore(desktops: [online, offline], inboxes: [mockOfflineId: cached])
        let factory = MockDesktopConnectionFactory(acceptAfter: .seconds(2), offline: [mockOfflineId: lastSeen])
        // The offline desktop's chat was opened before: its transcript shows read-only.
        let transcript = ChatView(
            tabId: "o-3", title: "Claude",
            status: ChatStatus(busy: true, turnStartedAt: lastSeen.unixMilliseconds - 180_000, process: .running),
            items: [
                ChatItem(id: "o3-u1", .user(text: "Run the benchmark suite against the new tokenizer and compare with last week.", images: nil, queued: false, failed: false)),
                ChatItem(id: "o3-a1", .text(markdown: "I'll run `pytest benchmarks/ -k tokenizer` and diff the results against `results/2026-09-23.json`.", streaming: false)),
                ChatItem(id: "o3-t1", .tool(ChatTool(name: "Bash", summary: "pytest benchmarks/ -k tokenizer", status: .waiting, hasDetail: true))),
            ],
            prompts: [ChatPrompt(id: "o3-p1", .permission(ChatPermission(
                toolName: "Bash", title: "Run a shell command", summary: "pytest benchmarks/ -k tokenizer",
                detail: "pytest benchmarks/ -k tokenizer\n\ncwd: ~/code/model-eval", canAlwaysAllow: true)))]
        )
        let chatCache = InMemoryChatCacheStore([CachedChat(desktopId: mockOfflineId, view: transcript, savedAt: lastSeen)])
        return AppModel(factory: factory, store: store, chatCache: chatCache)
    }
}
