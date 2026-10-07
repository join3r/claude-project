import Foundation

/// A `DesktopConnection` that needs no relay: it serves a canned inbox and
/// flips one tab's status every few seconds. Used by `-mockDesktop`, SwiftUI
/// previews and, until the relay client lands, the pairing flow.
public actor MockDesktopConnection: DesktopConnection {
    public enum Behavior: Sendable, Equatable {
        /// Comes online right away.
        case online
        /// Stays offline; the app shows its cached inbox.
        case offline(lastSeen: Date)
        /// Runs a fake pairing: pending, then accepted after `acceptAfter`.
        case pairing(acceptAfter: Duration)
    }

    public nonisolated let desktopId: String
    public nonisolated let events: AsyncStream<DesktopConnectionEvent>

    private let desktopName: String
    private let behavior: Behavior
    private let flipInterval: Duration
    private let continuation: AsyncStream<DesktopConnectionEvent>.Continuation
    private var inbox: Inbox
    private var state: ConnectionState = .idle
    private var runner: Task<Void, Never>?
    private var flipIndex = 0
    private var newChatCount = 0
    private var chats: [String: MockChatTranscript]
    /// The phone's one open chat (§6.3).
    private var openTab: String?
    private var chatSubscribers: [UUID: AsyncStream<ChatStreamEvent>.Continuation] = [:]
    private var scripts: [String: Task<Void, Never>] = [:]
    /// Pause between streamed chunks.
    private let streamStep: Duration

    public init(
        desktopId: String,
        desktopName: String,
        behavior: Behavior = .online,
        flipInterval: Duration = .seconds(4),
        inbox: Inbox? = nil,
        streamStep: Duration = .milliseconds(250)
    ) {
        self.streamStep = streamStep
        chats = MockChats.all()
        self.desktopId = desktopId
        self.desktopName = desktopName
        self.behavior = behavior
        self.flipInterval = flipInterval
        self.inbox = inbox ?? MockInbox.sample(desktopId: desktopId, desktopName: desktopName)
        (events, continuation) = AsyncStream.makeStream(bufferingPolicy: .bufferingNewest(64))
    }

    public func start() async {
        guard runner == nil else { return }
        runner = Task { [weak self] in
            await self?.run()
        }
    }

    public func stop() async {
        runner?.cancel()
        runner = nil
        for script in scripts.values { script.cancel() }
        scripts = [:]
        set(.idle)
        continuation.finish()
        for subscriber in chatSubscribers.values { subscriber.finish() }
        chatSubscribers = [:]
    }

    public func refresh() async throws {
        guard state == .online else { throw DesktopConnectionError.desktopOffline }
        inbox.generatedAt = Date().unixMilliseconds
        continuation.yield(.inbox(inbox))
    }

    /// Nothing to reconnect: the mock is either online or offline for good.
    public func reconnectNow() async {}

    private func set(_ newState: ConnectionState) {
        state = newState
        continuation.yield(.state(newState))
        if newState == .online { publish(.sessionStarted) }
    }

    // MARK: Chat

    public func chatEvents() async -> AsyncStream<ChatStreamEvent> {
        let (stream, continuation) = AsyncStream.makeStream(of: ChatStreamEvent.self, bufferingPolicy: .bufferingNewest(256))
        let id = UUID()
        chatSubscribers[id] = continuation
        continuation.onTermination = { [weak self] _ in
            Task { await self?.removeSubscriber(id) }
        }
        return stream
    }

    private func removeSubscriber(_ id: UUID) {
        chatSubscribers[id] = nil
    }

    private func publish(_ event: ChatStreamEvent) {
        for subscriber in chatSubscribers.values { subscriber.yield(event) }
    }

    public func request(_ op: String, params: JSONValue?, timeout: Duration) async throws -> JSONValue {
        guard state == .online else {
            if case .offline = state { throw DesktopConnectionError.desktopOffline }
            throw DesktopConnectionError.notConnected
        }
        // A little latency, like a relay round trip.
        try? await Task.sleep(for: .milliseconds(120))
        let p = params?.objectValue ?? JSONObject()
        func string(_ key: String) throws -> String {
            guard let value = p[key]?.stringValue else {
                throw DesktopConnectionError.remote(code: AppErrorCode.badRequest, message: "\(key) must be a string")
            }
            return value
        }
        func notFound() -> DesktopConnectionError {
            .remote(code: AppErrorCode.notFound, message: "No such chat")
        }

        switch op {
        case AppOp.inboxGet:
            return inbox.json
        case ChatOp.open:
            let tabId = try string("tabId")
            guard let chat = chats[tabId] else { throw notFound() }
            openTab = tabId
            return ChatOpenResult(seq: chat.seq, view: chat.view(tabId: tabId)).json
        case ChatOp.close:
            if openTab == (try string("tabId")) { openTab = nil }
            return .object([:])
        case ChatOp.earlier:
            let tabId = try string("tabId")
            let limit = p["limit"].flatMap { if case .number(let n) = $0 { Int(n) } else { nil } } ?? 50
            guard let page = chats[tabId]?.earlier(before: try string("before"), limit: min(limit, ChatOp.maxEarlierLimit)) else {
                throw notFound()
            }
            return page.json
        case ChatOp.detail:
            let tabId = try string("tabId"), itemId = try string("itemId")
            guard let chat = chats[tabId], let item = chat.item(itemId) else { throw notFound() }
            if let detail = chat.details[itemId] { return detail.json }
            switch item.content {
            case .text(let markdown, _): return ChatDetail.text(markdown: markdown).json
            case .user(let text, _, _, _): return ChatDetail.text(markdown: text).json
            case .tool(let tool): return ChatDetail.tool(input: "{}", result: tool.status.isActive ? nil : "(no output)").json
            default: throw notFound()
            }
        case ChatOp.image:
            let parsed: ChatImageParams
            do {
                parsed = try ChatImageParams.parse(params)
            } catch {
                throw DesktopConnectionError.remote(code: AppErrorCode.badRequest, message: error.message)
            }
            guard let chat = chats[parsed.tabId], let item = chat.item(parsed.itemId),
                  case .tool(let tool) = item.content, parsed.index < (tool.images ?? 0),
                  let data = MockChatTranscript.image(index: parsed.index, maxSide: parsed.maxSide ?? 2048) else {
                throw DesktopConnectionError.remote(code: AppErrorCode.notFound, message: "No such image")
            }
            return ChatImageResult(mediaType: "image/png", data: data).json
        case ChatOp.send:
            let tabId = try string("tabId"), text = try string("text")
            guard chats[tabId] != nil else { throw notFound() }
            startReply(tabId: tabId, text: text)
            return .object([:])
        case ChatOp.answer:
            let tabId = try string("tabId"), promptId = try string("promptId")
            guard let chat = chats[tabId] else { throw notFound() }
            guard let prompt = chat.prompts.first(where: { $0.id == promptId }) else {
                throw DesktopConnectionError.remote(code: AppErrorCode.gone, message: "That prompt was already answered.")
            }
            let answer: ChatAnswer
            do {
                answer = try ChatAnswer.parse(p["answer"])
            } catch {
                throw DesktopConnectionError.remote(code: AppErrorCode.badRequest, message: error.message)
            }
            resolve(prompt, answer: answer, tabId: tabId)
            return .object([:])
        case ChatOp.new:
            let taskId: String
            do {
                taskId = try ChatNewParams.parse(params).taskId
            } catch {
                throw DesktopConnectionError.remote(code: AppErrorCode.badRequest, message: error.message)
            }
            return ChatNewResult(tabId: try addChat(taskId: taskId)).json
        case TaskOp.new:
            let parsed: TaskNewParams
            do {
                parsed = try TaskNewParams.parse(params)
            } catch {
                throw DesktopConnectionError.remote(code: AppErrorCode.badRequest, message: error.message)
            }
            let result = try addTask(projectId: parsed.projectId, streamId: parsed.streamId, prompt: parsed.prompt)
            startReply(tabId: result.tabId, text: parsed.prompt)
            return result.json
        case TaskOp.close:
            let parsed: TaskCloseParams
            do {
                parsed = try TaskCloseParams.parse(params)
            } catch {
                throw DesktopConnectionError.remote(code: AppErrorCode.badRequest, message: error.message)
            }
            return try removeTask(parsed).json
        case TaskOp.closeTab:
            try removeTab(tabId: try string("tabId"))
            return .object([:])
        case TaskOp.setPin:
            let parsed: PinSetParams
            do {
                parsed = try PinSetParams.parse(params)
            } catch {
                throw DesktopConnectionError.remote(code: AppErrorCode.badRequest, message: error.message)
            }
            try setPin(parsed)
            return .object([:])
        case TaskOp.triage:
            let parsed: TaskTriageParams
            do {
                parsed = try TaskTriageParams.parse(params)
            } catch {
                throw DesktopConnectionError.remote(code: AppErrorCode.badRequest, message: error.message)
            }
            try triage(parsed)
            return .object([:])
        case ChatOp.settings:
            let parsed: ChatSettingsParams
            do {
                parsed = try ChatSettingsParams.parse(params)
            } catch {
                throw DesktopConnectionError.remote(code: AppErrorCode.badRequest, message: error.message)
            }
            guard chats[parsed.tabId] != nil else { throw notFound() }
            change(parsed.tabId, upserts: []) { chat in
                if let mode = parsed.mode { chat.status.permissionMode = mode }
                var settings = chat.status.settings ?? MockChatTranscript.settings(model: chat.status.model, now: Date().unixMilliseconds).0
                if let model = parsed.model {
                    settings.model = model.isEmpty ? nil : model
                    let picked = settings.models.first { $0.value == model }
                    settings.modelName = picked?.label ?? "Opus 4.5"
                    chat.status.model = "claude-\(picked?.value ?? "opus")-4-5"
                }
                if let effort = parsed.effort {
                    settings.effort = effort.isEmpty ? nil : effort
                    settings.defaultEffort = effort.isEmpty ? "medium" : nil
                }
                chat.status.settings = settings
            }
            return .object([:])
        case ChatOp.interrupt:
            let tabId = try string("tabId")
            guard chats[tabId] != nil else { throw notFound() }
            interrupt(tabId: tabId)
            return .object([:])
        case PushOp.register:
            // No pushes in mock mode; just check the params like a desktop would.
            do {
                _ = try PushRegisterParams.parse(params)
            } catch {
                throw DesktopConnectionError.remote(code: AppErrorCode.badRequest, message: error.message)
            }
            return .object([:])
        case PushOp.unregister:
            return .object([:])
        default:
            throw DesktopConnectionError.remote(code: AppErrorCode.unsupported, message: "Unknown op \(op)")
        }
    }

    /// `chat.new`: a fresh claude-chat tab at the end of the task, with an
    /// empty transcript. The inbox with it goes out right away (the desktop
    /// sends it with its next throttled `inbox` event).
    private func addChat(taskId: String) throws -> String {
        for p in inbox.projects.indices {
            guard let t = inbox.projects[p].tasks.firstIndex(where: { $0.id == taskId }) else { continue }
            newChatCount += 1
            let tabId = "tab-new-\(newChatCount)"
            let now = Date().unixMilliseconds
            inbox.projects[p].tasks[t].tabs.append(InboxTab(id: tabId, type: .claudeChat, title: "Claude", status: .idle, since: now))
            inbox.generatedAt = now
            chats[tabId] = MockChatTranscript(title: "Claude", status: MockChatTranscript.freshStatus(), items: [], prompts: [], details: [:])
            continuation.yield(.inbox(inbox))
            return tabId
        }
        throw DesktopConnectionError.remote(code: AppErrorCode.notFound, message: "No such task")
    }

    /// `task.new`: a task at the end of the stream (default: the one last
    /// used), named after the prompt's first line, with one claude-chat tab.
    private func addTask(projectId: String, streamId: String?, prompt: String) throws -> TaskNewResult {
        guard let p = inbox.projects.firstIndex(where: { $0.id == projectId }) else {
            throw DesktopConnectionError.remote(code: AppErrorCode.notFound, message: "No such project")
        }
        let project = inbox.projects[p]
        let target = streamId.map { id in project.streams.first { $0.id == id } } ?? project.defaultStream
        guard let stream = target else {
            throw DesktopConnectionError.remote(code: AppErrorCode.notFound, message: "No such stream")
        }
        newChatCount += 1
        let tabId = "tab-new-\(newChatCount)", taskId = "task-new-\(newChatCount)"
        let now = Date().unixMilliseconds
        let firstLine = prompt.split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }.first { !$0.isEmpty } ?? ""
        let name = firstLine.count > 50 ? String(firstLine.prefix(49)) + "…" : firstLine
        let tab = InboxTab(id: tabId, type: .claudeChat, title: "Claude", status: .idle, since: now)
        let task = InboxTask(id: taskId, name: name, streamId: stream.id, streamName: stream.name, lastInteractedAt: now, tabs: [tab])
        // Stream by stream, as the desktop sends them: after the stream's last task.
        let insertAt = (project.tasks.lastIndex { $0.streamId == stream.id }).map { $0 + 1 }
            ?? project.tasks.firstIndex { task in
                (project.streams.firstIndex { $0.id == task.streamId } ?? .max) > (project.streams.firstIndex { $0.id == stream.id } ?? .max)
            } ?? project.tasks.count
        inbox.projects[p].tasks.insert(task, at: insertAt)
        inbox.projects[p].lastStreamId = stream.id
        inbox.generatedAt = now
        chats[tabId] = MockChatTranscript(title: "Claude", status: MockChatTranscript.freshStatus(), items: [], prompts: [], details: [:])
        continuation.yield(.inbox(inbox))
        return TaskNewResult(taskId: taskId, tabId: tabId)
    }

    /// `task.close`: archives the task. A working task reports `.working`
    /// until the phone confirms, so the demo shows the second confirmation.
    private func removeTask(_ params: TaskCloseParams) throws -> TaskCloseResult {
        for p in inbox.projects.indices {
            guard let t = inbox.projects[p].tasks.firstIndex(where: { $0.id == params.taskId }) else { continue }
            let task = inbox.projects[p].tasks[t]
            if task.status == .working, !params.stopWorking {
                return .blocked(.working)
            }
            for tab in task.tabs {
                scripts[tab.id]?.cancel()
                chats[tab.id] = nil
            }
            inbox.projects[p].tasks.remove(at: t)
            inbox.pinned.removeAll { $0.taskId == task.id }
            inbox.generatedAt = Date().unixMilliseconds
            continuation.yield(.inbox(inbox))
            return .closed
        }
        throw DesktopConnectionError.remote(code: AppErrorCode.notFound, message: "No such task")
    }

    /// `tab.close`: drops the tab; the task stays.
    private func removeTab(tabId: String) throws {
        for p in inbox.projects.indices {
            for t in inbox.projects[p].tasks.indices where inbox.projects[p].tasks[t].tabs.contains(where: { $0.id == tabId }) {
                inbox.projects[p].tasks[t].tabs.removeAll { $0.id == tabId }
                inbox.projects[p].tasks[t].status = Self.status(of: inbox.projects[p].tasks[t])
                scripts[tabId]?.cancel()
                chats[tabId] = nil
                inbox.generatedAt = Date().unixMilliseconds
                continuation.yield(.inbox(inbox))
                return
            }
        }
        throw DesktopConnectionError.remote(code: AppErrorCode.notFound, message: "No such tab")
    }

    /// `pin.set`: appends or removes the pin, as the desktop sidebar does. A
    /// task pin names the stream holding the task.
    private func setPin(_ params: PinSetParams) throws {
        guard let project = inbox.projects.first(where: { $0.id == params.pin.projectId }) else {
            throw DesktopConnectionError.remote(code: AppErrorCode.notFound, message: "No such project")
        }
        var pin = InboxPin(projectId: project.id)
        if let taskId = params.pin.taskId {
            guard let task = project.tasks.first(where: { $0.id == taskId }) else {
                throw DesktopConnectionError.remote(code: AppErrorCode.notFound, message: "No such task")
            }
            pin = .task(task, in: project)
        } else if let streamId = params.pin.streamId {
            guard let stream = project.streams.first(where: { $0.id == streamId }) else {
                throw DesktopConnectionError.remote(code: AppErrorCode.notFound, message: "No such stream")
            }
            pin = .stream(stream, in: project)
        }
        let isPinned = inbox.isPinned(pin)
        guard isPinned != params.pinned else { return }
        if params.pinned { inbox.pinned.append(pin) } else { inbox.pinned.removeAll { $0.key == pin.key } }
        inbox.generatedAt = Date().unixMilliseconds
        continuation.yield(.inbox(inbox))
    }

    /// `task.triage`: applies the action as the desktop would and sends the inbox.
    private func triage(_ params: TaskTriageParams) throws {
        for p in inbox.projects.indices {
            guard let t = inbox.projects[p].tasks.firstIndex(where: { $0.id == params.taskId }) else { continue }
            let now = Date()
            let task = inbox.projects[p].tasks[t]
            let next = task.applying(params.action, now: now)
            guard next != task else { return }
            inbox.projects[p].tasks[t] = next
            inbox.generatedAt = now.unixMilliseconds
            continuation.yield(.inbox(inbox))
            return
        }
        throw DesktopConnectionError.remote(code: AppErrorCode.notFound, message: "No such task")
    }

    /// Applies a change to a chat and, when the phone has it open, sends the event.
    private func change(_ tabId: String, upserts: [ChatItem] = [], removes: [String] = [], _ edit: (inout MockChatTranscript) -> Void = { _ in }) {
        guard var chat = chats[tabId] else { return }
        edit(&chat)
        for item in upserts { chat.upsert(item) }
        chat.items.removeAll { removes.contains($0.id) }
        chat.seq += 1
        chats[tabId] = chat
        guard openTab == tabId else { return }
        publish(.chat(ChatEvent(tabId: tabId, seq: chat.seq, upserts: upserts, removes: removes,
                                prompts: chat.prompts, status: chat.status)))
    }

    private func run(_ tabId: String, _ body: @escaping @Sendable (MockDesktopConnection) async throws -> Void) {
        scripts[tabId]?.cancel()
        scripts[tabId] = Task { [weak self] in
            guard let self else { return }
            try? await body(self)
        }
    }

    private func pause(_ steps: Int = 1) async throws {
        try await Task.sleep(for: streamStep * steps)
    }

    /// Streams `markdown` into item `id` a few words at a time.
    private func stream(_ tabId: String, id: String, _ markdown: String) async throws {
        let words = markdown.split(separator: " ", omittingEmptySubsequences: false)
        var shown = 0
        while shown < words.count {
            shown = min(words.count, shown + 4)
            let partial = words[0..<shown].joined(separator: " ")
            change(tabId, upserts: [ChatItem(id: id, .text(markdown: partial, streaming: shown < words.count))])
            try await pause()
        }
    }

    private func startReply(tabId: String, text: String) {
        guard var chat = chats[tabId] else { return }
        let userId = chat.makeId("u"), thinkingId = chat.makeId("th"), textId = chat.makeId("a"), toolId = chat.makeId("t")
        chats[tabId] = chat
        let busy = chat.status.busy
        change(tabId, upserts: [ChatItem(id: userId, .user(text: text, images: nil, queued: busy, failed: false))]) {
            $0.status.busy = true
            $0.status.process = .running
            if $0.status.turnStartedAt == nil || !busy { $0.status.turnStartedAt = Date().unixMilliseconds }
        }
        if busy { return } // Queued behind the running turn, like the desktop does.
        run(tabId) { mock in
            try await mock.pause(2)
            await mock.change(tabId, upserts: [ChatItem(id: thinkingId, .thinking(preview: "Let me check the working tree before answering…", streaming: true))])
            try await mock.pause(3)
            await mock.change(tabId, upserts: [ChatItem(id: thinkingId, .thinking(preview: "Let me check the working tree before answering…", streaming: false))])
            try await mock.stream(tabId, id: textId, """
                Sure. I'll take a look at the current state of the branch first, then get back to you with a short summary                 of what changed and what is left to do.
                """)
            await mock.change(tabId, upserts: [ChatItem(id: toolId, .tool(ChatTool(name: "Bash", summary: "git status --short", status: .waiting, hasDetail: true)))]) {
                $0.details[toolId] = .tool(input: MockChats.prettyJSON(.object(["command": "git status --short"])), result: nil)
                $0.prompts.append(ChatPrompt(id: "p-\(toolId)", .permission(ChatPermission(
                    toolName: "Bash", title: "Run a shell command", summary: "git status --short",
                    detail: "git status --short\n\ncwd: ~/code/api-server", canAlwaysAllow: true))))
            }
        }
    }

    private func resolve(_ prompt: ChatPrompt, answer: ChatAnswer, tabId: String) {
        guard let chat = chats[tabId] else { return }
        // The tool the prompt belongs to: the last one still waiting.
        let toolItem = chat.items.last { if case .tool(let t) = $0.content { t.status == .waiting } else { false } }
        func updated(_ status: ChatToolStatus) -> [ChatItem] {
            guard let toolItem, case .tool(var tool) = toolItem.content else { return [] }
            tool.status = status
            return [ChatItem(id: toolItem.id, .tool(tool))]
        }
        let allowed: Bool
        switch answer {
        case .allow, .answers, .approvePlan: allowed = true
        case .deny: allowed = false
        }
        change(tabId, upserts: updated(allowed ? .running : .denied)) { $0.prompts.removeAll { $0.id == prompt.id } }
        guard var next = chats[tabId] else { return }
        let replyId = next.makeId("a"), noticeId = next.makeId("n"), questionId = next.makeId("t")
        chats[tabId] = next

        let summary: String
        switch (prompt.content, answer) {
        case (_, .deny):
            summary = prompt.kind == "plan" ? "OK, I'll keep planning. What should change?" : "Understood, I won't run that. Anything you'd like me to do instead?"
        case (.question, .answers(let answers)):
            summary = "Got it: " + answers.map { "**\($0.answer)**" }.joined(separator: " and ") + ". I'll draft the layout next."
        case (.plan, _):
            summary = "Plan approved. Starting with the API endpoint."
        default:
            summary = "All **42** auth tests pass, including the new `refresh_expired` case."
        }
        let askFollowUp = prompt.id == "p-bash"
        let doneItems = updated(.done)
        run(tabId) { mock in
            try await mock.pause(4)
            if allowed { await mock.change(tabId, upserts: doneItems) } else {
                await mock.change(tabId, upserts: [ChatItem(id: noticeId, .notice(text: "Denied from the phone", tone: .warning))])
            }
            try await mock.stream(tabId, id: replyId, summary)
            if askFollowUp {
                await mock.change(tabId, upserts: [ChatItem(id: questionId, .tool(ChatTool(name: "AskUserQuestion", summary: "Asking 1 question", status: .waiting, hasDetail: false)))]) {
                    $0.prompts.append(ChatPrompt(id: "p-\(questionId)", .question([ChatQuestion(
                        question: "Should I open a pull request for the fix?", header: "Next step", multiSelect: false,
                        options: [ChatQuestionOption(label: "Open a draft PR", description: "Push the branch and open a draft for review"),
                                  ChatQuestionOption(label: "Push only"),
                                  ChatQuestionOption(label: "Not yet")])])))
                }
            } else {
                await mock.change(tabId) {
                    $0.status.busy = false
                    $0.status.turnStartedAt = nil
                }
            }
        }
    }

    private func interrupt(tabId: String) {
        scripts[tabId]?.cancel()
        scripts[tabId] = nil
        guard var chat = chats[tabId] else { return }
        let noticeId = chat.makeId("n")
        chats[tabId] = chat
        var upserts: [ChatItem] = chat.items.compactMap { item in
            switch item.content {
            case .text(let markdown, true): ChatItem(id: item.id, .text(markdown: markdown, streaming: false))
            case .thinking(let preview, true): ChatItem(id: item.id, .thinking(preview: preview, streaming: false))
            case .tool(let tool) where tool.status.isActive:
                ChatItem(id: item.id, .tool(ChatTool(name: tool.name, summary: tool.summary, status: .denied, hasDetail: tool.hasDetail,
                                                     childCount: tool.childCount, lastChild: tool.lastChild)))
            default: nil
            }
        }
        upserts.append(ChatItem(id: noticeId, .notice(text: "Interrupted", tone: .muted)))
        change(tabId, upserts: upserts) {
            $0.prompts = []
            $0.status.busy = false
            $0.status.turnStartedAt = nil
        }
    }

    private func run() async {
        set(.connecting)
        guard (try? await Task.sleep(for: .milliseconds(300))) != nil else { return }

        switch behavior {
        case .offline(let lastSeen):
            continuation.yield(.lastSeen(lastSeen))
            set(.offline(lastSeen: lastSeen))
            return
        case .pairing(let acceptAfter):
            set(.handshaking)
            guard (try? await Task.sleep(for: .milliseconds(300))) != nil else { return }
            continuation.yield(.pairing(.pending))
            set(.awaitingApproval)
            guard (try? await Task.sleep(for: acceptAfter)) != nil else { return }
            continuation.yield(.pairing(.accepted(desktopName: desktopName)))
        case .online:
            set(.handshaking)
            guard (try? await Task.sleep(for: .milliseconds(200))) != nil else { return }
        }

        continuation.yield(.features([
            DesktopFeature.chatNew, DesktopFeature.taskNew, DesktopFeature.chatSettings,
            DesktopFeature.taskClose, DesktopFeature.tabClose, DesktopFeature.chatImage,
            DesktopFeature.pin, DesktopFeature.taskTriage,
        ]))
        set(.online)
        continuation.yield(.lastSeen(Date()))
        inbox.generatedAt = Date().unixMilliseconds
        continuation.yield(.inbox(inbox))

        while !Task.isCancelled {
            guard (try? await Task.sleep(for: flipInterval)) != nil else { return }
            flipNextTab()
            continuation.yield(.inbox(inbox))
        }
    }

    /// Round-robin across agent tabs that aren't exited: idle → working,
    /// working → attention, attention → working (as if the user answered).
    private func flipNextTab() {
        var slots: [(Int, Int, Int)] = []
        for (p, project) in inbox.projects.enumerated() {
            for (t, task) in project.tasks.enumerated() {
                for (b, tab) in task.tabs.enumerated() where tab.status != .exited && tab.type != .terminal {
                    slots.append((p, t, b))
                }
            }
        }
        guard !slots.isEmpty else { return }
        let (p, t, b) = slots[flipIndex % slots.count]
        flipIndex += 1

        let now = Date().unixMilliseconds
        var task = inbox.projects[p].tasks[t]
        var tab = task.tabs[b]
        switch tab.status {
        case .working:
            tab.status = .attention
            tab.activity = "Wants to run npm test"
            // An attention event, as the desktop records it: unread, un-settled,
            // and an "until it needs me" snooze wakes.
            task.eventAt = now
            task.unread = true
            task.settledAt = nil
            task.snoozeUntilAttention = false
        case .attention:
            tab.status = .working
            tab.activity = "Running Bash"
            task.lastInteractedAt = now
        default:
            tab.status = .working
            tab.activity = "Editing files"
        }
        tab.since = now
        task.tabs[b] = tab
        task.status = Self.status(of: task)
        let statusTab = Self.statusTabs(of: task).first { $0.status == task.status }
        task.since = statusTab?.since
        task.activity = statusTab?.activity
        task.attentionAt = task.status == .attention ? (task.attentionAt ?? now) : nil
        inbox.projects[p].tasks[t] = task
        inbox.generatedAt = now
    }

    /// The desktop's status tabs: agent tabs, else the first terminal (a
    /// terminal task's main tab). The mock has no main tab of its own.
    static func statusTabs(of task: InboxTask) -> [InboxTab] {
        let agents = task.tabs.filter { $0.type != .terminal }
        return agents.isEmpty ? Array(task.tabs.prefix(1)) : agents
    }

    /// The task's one status, as the desktop's `taskStatus` reads it (§4.4).
    static func status(of task: InboxTask) -> TabStatus {
        statusTabs(of: task).map(\.status).max { $0.priority < $1.priority } ?? .idle
    }
}

/// Factory that hands out mock connections. Pairing auto-accepts after `acceptAfter`.
public struct MockDesktopConnectionFactory: DesktopConnectionFactory {
    public var acceptAfter: Duration
    /// Desktop IDs that should behave as offline, with their last-seen time.
    public var offline: [String: Date]

    public init(acceptAfter: Duration = .seconds(2), offline: [String: Date] = [:]) {
        self.acceptAfter = acceptAfter
        self.offline = offline
    }

    public func connection(for desktop: DesktopRecord) -> any DesktopConnection {
        let behavior: MockDesktopConnection.Behavior =
            offline[desktop.id].map { .offline(lastSeen: $0) } ?? .online
        return MockDesktopConnection(desktopId: desktop.id, desktopName: desktop.name, behavior: behavior)
    }

    public func pairingConnection(for invite: PairingInvite, deviceName: String) -> any DesktopConnection {
        MockDesktopConnection(
            desktopId: invite.desktopId,
            desktopName: invite.desktopName,
            behavior: .pairing(acceptAfter: acceptAfter)
        )
    }
}

/// Canned inbox content.
public enum MockInbox {
    public static func sample(desktopId: String, desktopName: String, now: Date = Date()) -> Inbox {
        let t = now.unixMilliseconds
        func ago(_ minutes: Double) -> Int64 { t - Int64(minutes * 60_000) }

        let apiMain = InboxStream(id: "s-api-main", name: "main", isMain: true)
        let api050 = InboxStream(id: "s-api-050", name: "0.5.0", branch: "0.5.0")
        let apiBugs = InboxStream(id: "s-api-bugs", name: "bugfixes")
        let webMain = InboxStream(id: "s-web-main", name: "main", isMain: true)
        let webLogin = InboxStream(id: "s-web-login", name: "login-redesign", branch: "login-redesign")
        let infraMain = InboxStream(id: "s-infra-main", name: "main", isMain: true)
        func task(_ id: String, _ name: String, _ stream: InboxStream, lastInteractedAt: Int64? = nil, attentionAt: Int64? = nil,
                  eventAt: Int64? = nil, unread: Bool = false, settledAt: Int64? = nil, snoozedUntil: Int64? = nil,
                  tabs: [InboxTab]) -> InboxTask {
            var task = InboxTask(id: id, name: name, streamId: stream.id, streamName: stream.name,
                                 lastInteractedAt: lastInteractedAt, attentionAt: attentionAt, eventAt: eventAt, unread: unread,
                                 settledAt: settledAt, snoozedUntil: snoozedUntil, tabs: tabs)
            task.status = MockDesktopConnection.status(of: task)
            let statusTab = MockDesktopConnection.statusTabs(of: task).first { $0.status == task.status }
            task.since = statusTab?.since
            task.activity = statusTab?.activity
            return task
        }

        return Inbox(
            desktop: InboxDesktop(id: desktopId, name: desktopName),
            generatedAt: t,
            projects: [
                InboxProject(id: "p-api", name: "api-server", emoji: "🚀", streams: [apiMain, api050, apiBugs], lastStreamId: api050.id, tasks: [
                    task("t-docs", "openapi-docs", apiMain, lastInteractedAt: ago(180), eventAt: ago(170), settledAt: ago(160), tabs: [
                        InboxTab(id: "tab-5", type: .terminal, title: "npm run docs", status: .exited, since: ago(170)),
                    ]),
                    task("t-auth", "fix-auth", api050, lastInteractedAt: ago(3), attentionAt: ago(1), eventAt: ago(1), unread: true, tabs: [
                        InboxTab(id: "tab-1", type: .claudeChat, title: "Claude", status: .attention, since: ago(1), activity: "Wants to run npm test", topic: "Fix the flaky login test"),
                        InboxTab(id: "tab-2", type: .terminal, title: "zsh", status: .idle, since: ago(40)),
                    ]),
                    task("t-rate", "rate-limiter", api050, lastInteractedAt: ago(12), eventAt: ago(6), unread: true, tabs: [
                        InboxTab(id: "tab-3", type: .claude, title: "Claude Code", status: .working, since: ago(4), activity: "Running Bash", topic: "Bump the API client to v3"),
                    ]),
                    task("t-flaky", "flaky-login-test", apiBugs, lastInteractedAt: ago(30), eventAt: ago(30), tabs: [
                        InboxTab(id: "tab-4", type: .codex, title: "Codex", status: .exited, since: ago(30)),
                    ]),
                ]),
                InboxProject(id: "p-web", name: "web-dashboard", emoji: "📊", streams: [webMain, webLogin], tasks: [
                    task("t-charts", "usage-charts", webMain, lastInteractedAt: ago(25), tabs: [
                        InboxTab(id: "tab-11", type: .claudeChat, title: "Claude", status: .attention, since: ago(1), activity: "Plan ready for review", topic: "Plan the settings page redesign"),
                        InboxTab(id: "tab-7", type: .terminal, title: "vite", status: .idle, since: ago(25)),
                    ]),
                    task("t-pi", "chart-colors", webMain, lastInteractedAt: ago(20), tabs: [
                        InboxTab(id: "tab-6", type: .pi, title: "Pi", status: .working, since: ago(2), activity: "Reading files"),
                    ]),
                    task("t-login", "login-redesign", webLogin, lastInteractedAt: ago(60 * 26), snoozedUntil: t + 3 * 3_600_000, tabs: [
                        InboxTab(id: "tab-8", type: .claudeChat, title: "Claude", status: .idle, since: ago(60 * 26)),
                    ]),
                ]),
                InboxProject(id: "p-infra", name: "infra", emoji: "🛠️", remote: true, streams: [infraMain], tasks: [
                    task("t-k8s", "k8s-upgrade", infraMain, lastInteractedAt: ago(90), eventAt: ago(15), tabs: [
                        InboxTab(id: "tab-9", type: .claude, title: "Claude Code", status: .idle, since: ago(90)),
                        InboxTab(id: "tab-10", type: .terminal, title: "ssh prod-1", status: .working, since: ago(15), activity: "kubectl rollout"),
                    ]),
                    task("t-tail", "Terminal", infraMain, lastInteractedAt: ago(50), tabs: [
                        InboxTab(id: "tab-12", type: .terminal, title: "tail -f api.log", status: .working, since: ago(50)),
                    ]),
                ]),
            ],
            pinned: [
                InboxPin(projectId: "p-web", streamId: webMain.id, taskId: "t-charts"),
                InboxPin(projectId: "p-api", streamId: api050.id),
                InboxPin(projectId: "p-infra"),
            ]
        )
    }
}
