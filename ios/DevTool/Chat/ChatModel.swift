import DevToolKit
import Foundation
import Observation
import OSLog

/// One open chat screen: opens the chat on the desktop, applies `evt chat`
/// through `ChatState`, re-opens after a `seq` gap or a new session, and runs
/// the composer and prompt actions. One per `ChatScreen`.
///
/// It also keeps the chat's last transcript in the chat cache (§8.3), and
/// shows that read-only when the first open finds the desktop unreachable.
@MainActor
@Observable
final class ChatModel {
    enum Phase: Equatable {
        case loading
        case ready
        /// The desktop isn't reachable; the model re-opens once a session starts.
        case waiting
        case failed(String)
    }

    let route: ChatRoute
    private(set) var phase: Phase = .loading
    private(set) var state: ChatState?
    private(set) var loadingEarlier = false
    private(set) var sending = false
    private(set) var interrupting = false
    /// Prompts with an answer in flight.
    private(set) var answering: Set<String> = []
    /// Why the last answer to a prompt failed (shown on its card).
    private(set) var answerErrors: [String: String] = [:]
    /// A one-line message shown briefly above the composer.
    var toast: String?
    /// `state` holds the cached transcript, not a live one: read-only until the open succeeds.
    private(set) var showingCache = false
    /// When the cached transcript was saved.
    private(set) var cachedAt: Date?

    /// Where the model gets its connection, cached transcript and answer authorization.
    struct Dependencies {
        var connection: @MainActor () -> (any DesktopConnection)?
        var loadCache: @MainActor () -> CachedChat? = { nil }
        var saveCache: @MainActor (ChatView) -> Void = { _ in }
        /// "Require Face ID for approvals" (§8.3).
        var authorizeAnswer: @MainActor () async -> AuthOutcome = { .success }
    }

    /// Seconds between cache writes while the transcript changes (it streams).
    private static let saveInterval: Duration = .seconds(5)

    @ObservationIgnored private let dependencies: Dependencies
    @ObservationIgnored private var saveTask: Task<Void, Never>?
    @ObservationIgnored private var listener: Task<Void, Never>?
    @ObservationIgnored private var toastTask: Task<Void, Never>?
    /// Events that arrive while `chat.open` is in flight.
    @ObservationIgnored private var buffered: [ChatEvent] = []
    @ObservationIgnored private var opening = false
    @ObservationIgnored private var openGeneration = 0
    @ObservationIgnored private let log = Logger(subsystem: "sk.awantech.devtool", category: "chat")

    init(route: ChatRoute, dependencies: Dependencies) {
        self.route = route
        self.dependencies = dependencies
    }

    private var connection: @MainActor () -> (any DesktopConnection)? { dependencies.connection }

    var view: ChatView? { state?.view }
    var busy: Bool { state?.view.busy ?? false }

    // MARK: Lifecycle

    /// Subscribes and opens. Returns when `stop()` is called or the task is cancelled.
    func run() async {
        guard listener == nil, let connection = connection() else {
            if connection() == nil { phase = .failed("This desktop isn't connected.") }
            return
        }
        let stream = await connection.chatEvents()
        listener = Task { [weak self] in
            for await event in stream {
                guard let self else { return }
                self.handle(event)
            }
        }
        await open()
        await withTaskCancellationHandler {
            await listener?.value
        } onCancel: {
            Task { @MainActor [weak self] in self?.stop() }
        }
    }

    /// Stops listening and tells the desktop the chat is closed.
    func stop() {
        guard let listener else { return }
        listener.cancel()
        self.listener = nil
        saveNow()
        let tabId = route.tabId
        if let connection = connection() {
            Task { try? await connection.closeChat(tabId: tabId) }
        }
    }

    private func open() async {
        guard let connection = connection(), !opening else { return }
        opening = true
        openGeneration += 1
        let generation = openGeneration
        buffered = []
        if state == nil { phase = .loading }
        defer { opening = false }
        do {
            let result = try await connection.openChat(tabId: route.tabId)
            guard generation == openGeneration else { return }
            var next = ChatState(open: result)
            // Events that raced the open: stale ones are ignored, later ones applied.
            let pending = buffered
            buffered = []
            for event in pending where next.apply(event) == .gap {
                // Lost events while opening: try again.
                opening = false
                await open()
                return
            }
            state = next
            showingCache = false
            cachedAt = nil
            phase = .ready
            saveNow()
        } catch let error as DesktopConnectionError {
            switch error {
            case .desktopOffline, .notConnected, .connectionLost, .timeout:
                if state == nil, let cached = dependencies.loadCache() {
                    state = ChatState(view: cached.view, seq: -1)
                    showingCache = true
                    cachedAt = cached.savedAt
                }
                phase = state == nil || showingCache ? .waiting : .ready
            case .remote(let code, _) where code == AppErrorCode.notFound:
                phase = .failed("This chat isn't available any more. It may have been closed on the desktop.")
            default:
                phase = .failed(error.localizedDescription)
            }
        } catch {
            phase = .failed(error.localizedDescription)
        }
    }

    private func handle(_ event: ChatStreamEvent) {
        switch event {
        case .chat(let chat):
            guard chat.tabId == route.tabId else { return }
            if opening {
                buffered.append(chat)
                return
            }
            guard !showingCache, var current = state else { return }
            switch current.apply(chat) {
            case .applied:
                state = current
                scheduleSave()
            case .ignored:
                break
            case .gap:
                log.notice("Chat seq gap (\(current.seq) → \(chat.seq)); re-opening")
                Task { await open() }
            }
        case .sessionStarted:
            // The desktop forgot this phone's subscription with the old session.
            Task { await open() }
        case .sessionLost:
            answering = []
            saveNow()
        }
    }

    // MARK: Cache

    /// Saves the transcript at most every `saveInterval` while it changes.
    private func scheduleSave() {
        guard saveTask == nil else { return }
        saveTask = Task { [weak self] in
            guard (try? await Task.sleep(for: Self.saveInterval)) != nil else { return }
            self?.saveTask = nil
            self?.saveNow()
        }
    }

    /// Writes the live transcript to the cache now (open, close, session
    /// lost, app backgrounded). A cached one isn't written back.
    func saveNow() {
        saveTask?.cancel()
        saveTask = nil
        guard !showingCache, let state else { return }
        dependencies.saveCache(state.view)
    }

    // MARK: Actions

    func loadEarlier() async {
        guard let connection = connection(), let state, state.view.hasEarlier, !loadingEarlier,
              let first = state.view.items.first
        else { return }
        loadingEarlier = true
        defer { loadingEarlier = false }
        do {
            let page = try await connection.earlierChatItems(tabId: route.tabId, before: first.id, limit: 50)
            self.state?.prepend(page)
            scheduleSave()
        } catch {
            show(error)
        }
    }

    /// Returns true when the desktop took the message.
    func send(_ text: String) async -> Bool {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, let connection = connection() else { return false }
        sending = true
        defer { sending = false }
        do {
            try await connection.sendChat(tabId: route.tabId, text: text)
            return true
        } catch {
            show(error)
            return false
        }
    }

    func interrupt() async {
        guard let connection = connection(), !interrupting else { return }
        interrupting = true
        defer { interrupting = false }
        do {
            try await connection.interruptChat(tabId: route.tabId)
        } catch {
            show(error)
        }
    }

    /// Every in-app answer goes through here. With "Require Face ID for
    /// approvals" on it authenticates first; cancelling leaves the card as it was.
    func answer(_ prompt: ChatPrompt, _ answer: ChatAnswer) async {
        guard !showingCache, connection() != nil, !answering.contains(prompt.id) else { return }
        answering.insert(prompt.id)
        answerErrors[prompt.id] = nil
        defer { answering.remove(prompt.id) }
        switch await dependencies.authorizeAnswer() {
        case .success:
            break
        case .cancelled:
            return
        case .failed(let message):
            answerErrors[prompt.id] = message
            return
        }
        // The session may have changed while the prompt was up.
        guard let connection = connection() else { return }
        do {
            try await connection.answerChat(tabId: route.tabId, promptId: prompt.id, answer: answer)
            // The next event drops it too; don't leave the card up until then.
            state?.dismissPrompt(prompt.id)
        } catch let error as DesktopConnectionError where error.remoteCode == AppErrorCode.gone {
            state?.dismissPrompt(prompt.id)
            flash("Already answered.")
        } catch {
            answerErrors[prompt.id] = error.localizedDescription
        }
    }

    /// `chat.settings`: one of mode, model or effort; "" for model or effort is
    /// the default. The new values come back in the next chat event.
    func updateSettings(mode: String? = nil, model: String? = nil, effort: String? = nil) async {
        guard !showingCache, let connection = connection() else { return }
        do {
            try await connection.updateChatSettings(tabId: route.tabId, mode: mode, model: model, effort: effort)
        } catch {
            show(error)
        }
    }

    func detail(for itemId: String) async throws -> ChatDetail {
        guard let connection = connection() else { throw DesktopConnectionError.notConnected }
        return try await connection.chatDetail(tabId: route.tabId, itemId: itemId)
    }

    // MARK: Toast

    private func show(_ error: any Error) {
        flash(error.localizedDescription)
    }

    func flash(_ message: String) {
        toast = message
        toastTask?.cancel()
        toastTask = Task { [weak self] in
            guard (try? await Task.sleep(for: .seconds(4))) != nil else { return }
            self?.toast = nil
        }
    }
}
