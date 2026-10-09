import DevToolKit
import SwiftUI

/// A claude-chat tab: live transcript, prompt cards and composer (SPEC.md §6).
struct ChatScreen: View {
    @Environment(AppModel.self) private var app
    @Environment(\.scenePhase) private var scenePhase
    @State private var model: ChatModel
    @State private var draft = ""
    @State private var atBottom = true
    @State private var detailItem: ChatItem?
    @State private var viewerImage: ChatImageRef?
    @State private var sideQuestion: SideQuestion?
    @State private var showingPermissions = false
    @FocusState private var composerFocused: Bool
    /// The chat's height above the keyboard, bottom bar included; caps the prompt card.
    @State private var viewportHeight: CGFloat = 0

    /// Opens the task info sheet (the header and ⓘ).
    private let onInfo: (() -> Void)?

    private static let bottomID = "chat-bottom"

    init(route: ChatRoute, app: AppModel, onInfo: (() -> Void)? = nil) {
        self.onInfo = onInfo
        _model = State(initialValue: ChatModel(route: route, dependencies: .init(
            connection: { [weak app] in app?.connection(for: route.desktopId) },
            loadCache: { [weak app] in app?.cachedChat(route) },
            saveCache: { [weak app] view in app?.cacheChat(view, desktopId: route.desktopId) },
            authorizeAnswer: { [weak app] in await app?.security?.authorizeAnswer() ?? .success }
        )))
    }

    private var route: ChatRoute { model.route }
    private var offline: Bool { app.isOffline(route.desktopId) }
    /// Offline, or showing the cached transcript (§8.3): nothing can be sent or answered.
    private var readOnly: Bool { offline || model.showingCache }
    private var found: (task: InboxTask, tab: InboxTab)? { app.tab(desktopId: route.desktopId, tabId: route.tabId) }

    var body: some View {
        content
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                if let context, let onInfo {
                    TaskNavigationHeader(project: context.project, task: context.task, detail: modeLabel, onInfo: onInfo)
                } else {
                    ToolbarItem(placement: .principal) { titleView }
                }
            }
            .sheet(item: $detailItem) { item in
                ItemDetailSheet(item: item) { try await model.detail(for: item.id) }
                    .presentationDetents([.medium, .large])
                    .presentationDragIndicator(.visible)
            }
            .sheet(item: $sideQuestion) { side in
                SideQuestionSheet(question: side.question) { [model] in try await model.askSideQuestion(side.question) }
                    .presentationDetents([.medium, .large])
                    .presentationDragIndicator(.visible)
            }
            .sheet(isPresented: $showingPermissions) {
                PermissionsSheet(
                    mode: model.view?.status.permissionMode,
                    editable: !readOnly,
                    load: { [model] in try await model.permissionSources() },
                    update: { [model] kind, behavior, rule, action in try await model.updatePermission(kind, behavior, rule: rule, action) }
                )
                .presentationDetents([.large])
            }
            .onChange(of: commandQuery != nil) { _, typing in
                if typing { Task { await model.loadCommands() } }
            }
            .fullScreenCover(item: $viewerImage) { ref in
                ChatImageViewer(start: ref) { [model] ref, side in try await model.image(ref, maxSide: side) }
            }
            .task { await model.run() }
            .onChange(of: scenePhase) { _, phase in
                if phase != .active { model.saveNow() }
            }
            // Pushes for the chat on screen aren't shown as banners.
            .onAppear { app.visibleChat = route }
            .onDisappear { if app.visibleChat == route { app.visibleChat = nil } }
            #if DEBUG
            .task {
                await DemoChatScript.run(model: model, openDetail: { detailItem = $0 }, setDraft: {
                    draft = $0
                    composerFocused = true
                }, openSheet: { sheet in
                    switch sheet {
                    case .permissions: showingPermissions = true
                    case .btw(let question): sideQuestion = SideQuestion(question: question)
                    }
                })
            }
            #endif
    }

    @ViewBuilder
    private var content: some View {
        switch model.phase {
        case .loading where model.state == nil:
            ProgressView("Opening chat…")
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        case .waiting where model.state == nil:
            VStack(spacing: 16) {
                OfflineBanner(title: app.kindTitle(route.desktopId), lastSeen: lastSeen)
                let server = app.isServer(route.desktopId)
                ContentUnavailableView(server ? "Waiting for the server" : "Waiting for the desktop",
                                       systemImage: server ? "server.rack" : "desktopcomputer",
                                       description: Text("The chat opens when \(app.desktop(route.desktopId)?.name ?? (server ? "the server" : "the desktop")) is back online."))
            }
            .padding()
        case .failed(let message):
            ContentUnavailableView("Can't open this chat", systemImage: "bubble.left.and.exclamationmark.bubble.right",
                                   description: Text(message))
        default:
            transcript
        }
    }

    private var titleView: some View {
        VStack(spacing: 0) {
            Text(found?.tab.title.nonEmpty ?? model.view?.title.nonEmpty ?? "Claude")
                .font(.headline)
                .lineLimit(1)
            if let subtitle {
                Text(subtitle)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
        }
        .accessibilityElement(children: .combine)
    }

    private var subtitle: String? {
        var parts: [String] = []
        if let task = found?.task.name { parts.append(task) }
        if let modeLabel { parts.append(modeLabel) }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    /// The project and task the chat belongs to, for the project-first header.
    private var context: (project: InboxProject, task: InboxTask)? {
        guard let task = found?.task else { return nil }
        return app.task(TaskRef(desktopId: route.desktopId, taskId: task.id))
    }

    /// The permission mode, when the controls bar doesn't show it (no pickers from the desktop).
    private var modeLabel: String? {
        guard let status = model.view?.status, status.settings == nil, let mode = status.permissionMode else { return nil }
        return Self.permissionModeLabel(mode)
    }

    static func permissionModeLabel(_ mode: String) -> String? {
        switch mode {
        case "default": nil
        case "plan": "Plan mode"
        case "acceptEdits": "Accept edits"
        case "auto": "Auto mode"
        case "bypassPermissions": "Bypass permissions"
        default: mode
        }
    }

    // MARK: Transcript

    private var transcript: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 14) {
                    if model.view?.hasEarlier == true {
                        loadEarlierButton(proxy)
                    }
                    ForEach(model.view?.items ?? []) { item in
                        ChatItemRow(item: item, images: imageActions) { detailItem = $0 }
                            .id(item.id)
                    }
                    // A saved transcript's status is stale: don't show it as running.
                    if let view = model.view, !model.showingCache {
                        processStatus(view.status)
                    }
                    Color.clear
                        .frame(height: 1)
                        .id(Self.bottomID)
                        .onAppear { atBottom = true }
                        .onDisappear { atBottom = false }
                }
                .padding(.horizontal, 16)
                .padding(.top, 12)
                .padding(.bottom, 8)
                .frame(maxWidth: 780)
                .frame(maxWidth: .infinity)
            }
            .defaultScrollAnchor(.bottom)
            .scrollDismissesKeyboard(.interactively)
            .onChange(of: model.view?.items.last) { _, _ in follow(proxy) }
            .onChange(of: model.view?.items.count) { _, _ in follow(proxy) }
            .onChange(of: model.view?.busy) { _, _ in follow(proxy) }
            .onChange(of: model.view?.prompts.first?.id) { _, id in
                // A card needs the room the keyboard takes, and its buttons, not the composer.
                if id != nil { composerFocused = false }
                follow(proxy)
            }
            .safeAreaInset(edge: .bottom, spacing: 0) {
                bottomBar(proxy)
            }
        }
        // Measured outside the bottom bar's inset: the card's height feeds the bar, so
        // measuring inside it would loop (card grows → viewport shrinks → cap shrinks → …).
        .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { if abs(viewportHeight - $0) > 1 { viewportHeight = $0 } }
    }

    /// Keeps the newest content in view while the user is at the bottom.
    private func follow(_ proxy: ScrollViewProxy) {
        guard atBottom else { return }
        withAnimation(.easeOut(duration: 0.2)) { proxy.scrollTo(Self.bottomID, anchor: .bottom) }
    }

    private func loadEarlierButton(_ proxy: ScrollViewProxy) -> some View {
        Button {
            let anchor = model.view?.items.first?.id
            Task {
                await model.loadEarlier()
                // Stay on the message that was at the top.
                if let anchor { proxy.scrollTo(anchor, anchor: .top) }
            }
        } label: {
            HStack(spacing: 6) {
                if model.loadingEarlier {
                    ProgressView().controlSize(.small)
                } else {
                    Image(systemName: "arrow.up.circle")
                }
                Text("Load earlier messages")
            }
            .font(.footnote.weight(.medium))
            .frame(maxWidth: .infinity)
            .padding(.vertical, 6)
        }
        .buttonStyle(.borderless)
        .disabled(model.loadingEarlier || readOnly)
    }

    @ViewBuilder
    private func processStatus(_ status: ChatStatus) -> some View {
        if status.busy {
            WorkingRow(since: status.turnStartedAt.map { Date(unixMilliseconds: $0) })
        } else if status.process == .starting {
            NoticeRow(text: "Starting Claude…", tone: .muted, symbol: "hourglass")
        } else if status.process == .exited {
            NoticeRow(text: status.processError.map { "Claude stopped: \($0). Sending a message restarts it." }
                      ?? "Claude isn't running. Sending a message starts it.",
                      tone: status.processError == nil ? .muted : .error)
        }
    }

    // MARK: Bottom bar

    private func bottomBar(_ proxy: ScrollViewProxy) -> some View {
        VStack(spacing: 8) {
            if let toast = model.toast {
                Text(toast)
                    .font(.footnote.weight(.medium))
                    .padding(.horizontal, 12)
                    .padding(.vertical, 6)
                    .background(.thinMaterial, in: Capsule())
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            }
            if let prompts = model.view?.prompts, let prompt = prompts.first {
                PromptCard(
                    prompt: prompt,
                    moreCount: prompts.count - 1,
                    answering: model.answering.contains(prompt.id),
                    error: model.answerErrors[prompt.id],
                    enabled: !readOnly,
                    // The / menu needs part of that room while it's up.
                    maxHeight: viewportHeight > 0 ? max(suggestions == nil ? 200 : 120, viewportHeight * (suggestions == nil ? 0.55 : 0.3)) : .infinity
                ) { answer in
                    Task { await model.answer(prompt, answer) }
                }
                .id(prompt.id)
                .transition(.move(edge: .bottom).combined(with: .opacity))
            }
            if offline {
                OfflineBanner(title: app.kindTitle(route.desktopId), lastSeen: lastSeen)
            }
            if model.showingCache {
                cachedNote
            } else if let status = model.view?.status, status.settings != nil || status.usage != nil {
                ChatControlsBar(status: status, editable: canChangeSettings) { mode, model, effort in
                    Task { await self.model.updateSettings(mode: mode, model: model, effort: effort) }
                }
            }
            if let suggestions {
                CommandSuggestions(commands: suggestions, maxHeight: viewportHeight > 0 ? viewportHeight * 0.3 : 270, pick: pick)
                    .transition(.opacity)
            }
            composer
        }
        .padding(.horizontal, 12)
        .padding(.top, 8)
        .padding(.bottom, 8)
        .frame(maxWidth: 780)
        .frame(maxWidth: .infinity)
        .background(.bar)
        .animation(.snappy, value: model.view?.prompts.first?.id)
        .animation(.snappy, value: model.toast)
        .animation(.snappy, value: suggestions?.map(\.name))
        // Above the bar, not over it: over the composer it would cover Stop and Send.
        .overlay(alignment: .topTrailing) {
            if !atBottom {
                Button {
                    withAnimation { proxy.scrollTo(Self.bottomID, anchor: .bottom) }
                } label: {
                    Image(systemName: "arrow.down")
                        .font(.footnote.weight(.bold))
                        .frame(width: 34, height: 34)
                        .background(.regularMaterial, in: Circle())
                        .shadow(color: .black.opacity(0.12), radius: 4, y: 1)
                }
                .buttonStyle(.plain)
                .padding(.trailing, 16)
                .offset(y: -42)
                .accessibilityLabel("Scroll to latest")
                .transition(.opacity)
            }
        }
    }

    private var cachedNote: some View {
        HStack(spacing: 4) {
            Image(systemName: "clock.arrow.circlepath")
            Text("Saved transcript, read-only")
            if let saved = model.cachedAt {
                Text("·")
                RelativeTime(date: saved)
            }
        }
        .font(.caption)
        .foregroundStyle(.secondary)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 4)
        .accessibilityElement(children: .combine)
    }

    private var lastSeen: Date? {
        if case .offline(let seen?) = app.state(of: route.desktopId) { return seen }
        return app.desktop(route.desktopId)?.lastSeen
    }

    /// Tool-result images (§8.9), for a reachable desktop that lists `chat.image`.
    private var imageActions: ChatImageActions? {
        guard !readOnly, app.supports(DesktopFeature.chatImage, on: route.desktopId) else { return nil }
        return ChatImageActions(
            load: { [model] ref, side in try await model.image(ref, maxSide: side) },
            open: { viewerImage = $0 }
        )
    }

    /// The desktop answers `chat.settings` and is reachable.
    private var canChangeSettings: Bool {
        !readOnly && app.supports(DesktopFeature.chatSettings, on: route.desktopId)
    }

    private var canSend: Bool {
        !readOnly && !model.sending && !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && draft.count <= ChatOp.maxSendLength
    }

    private var composer: some View {
        HStack(alignment: .bottom, spacing: 8) {
            TextField(offline ? "\(app.kindTitle(route.desktopId)) offline" : model.showingCache ? "Connecting…" : (model.busy ? "Queue a message" : "Message Claude"),
                      text: $draft, axis: .vertical)
                .lineLimit(1...6)
                .focused($composerFocused)
                .padding(.horizontal, 14)
                .padding(.vertical, 9)
                .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 20, style: .continuous))
                .disabled(readOnly)
            if model.busy && draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                Button {
                    Task { await model.interrupt() }
                } label: {
                    Image(systemName: "stop.circle.fill")
                        .font(.system(size: 32))
                        .symbolRenderingMode(.hierarchical)
                        .foregroundStyle(readOnly ? Color.secondary : Color.red)
                }
                .disabled(readOnly || model.interrupting)
                .accessibilityLabel("Stop")
            } else {
                Button(action: send) {
                    Group {
                        if model.sending {
                            ProgressView().frame(width: 32, height: 32)
                        } else {
                            Image(systemName: "arrow.up.circle.fill")
                                .font(.system(size: 32))
                                .foregroundStyle(canSend ? Color.accentColor : Color.secondary.opacity(0.5))
                        }
                    }
                }
                .disabled(!canSend)
                .accessibilityLabel("Send")
            }
        }
    }

    private func send() {
        guard canSend else { return }
        if supportsCommands, runCommand(draft) { return }
        let text = draft
        draft = ""
        atBottom = true
        // Hand the screen back to the transcript: the reply and any card land there.
        composerFocused = false
        Task {
            if await !model.send(text), draft.isEmpty {
                draft = text // Give the text back so it isn't lost.
            }
        }
    }
}

// MARK: - The / menu (§8.14)

/// A `/btw` question on screen.
struct SideQuestion: Identifiable {
    let id = UUID()
    let question: String
}

extension ChatScreen {
    /// The desktop lists the `/` menu ops.
    private var supportsCommands: Bool {
        app.supports(DesktopFeature.chatCommands, on: route.desktopId)
    }

    /// What follows the `/` while the composer holds `/` and one word.
    private var commandQuery: String? {
        guard supportsCommands, !readOnly else { return nil }
        return ChatCommandMenu.query(draft)
    }

    private var suggestions: [ChatCommand]? {
        guard let query = commandQuery, let commands = model.commands else { return nil }
        let matches = ChatCommandMenu.matches(commands, query: query)
        return matches.isEmpty ? nil : matches
    }

    private func pick(_ command: ChatCommand) {
        guard !command.terminalOnly else { return }
        if command.name == ChatCommandMenu.permissions {
            draft = ""
            composerFocused = false
            showingPermissions = true
            return
        }
        draft = "/\(command.name) "
    }

    /// `/permissions`, `/btw <question>` and terminal-only commands, which the
    /// composer handles itself rather than sending. True when `text` was one.
    private func runCommand(_ text: String) -> Bool {
        let command = ChatCommandMenu.command(in: text)
        if command == ChatCommandMenu.permissions {
            draft = ""
            composerFocused = false
            showingPermissions = true
            return true
        }
        if let command, model.isTerminalOnly(command) {
            model.flash("/\(command) only works in a terminal on the desktop.")
            return true
        }
        guard let question = ChatCommandMenu.sideQuestion(in: text) else { return false }
        // A bare /btw does nothing, as on the desktop.
        guard !question.isEmpty else { return true }
        draft = ""
        composerFocused = false
        sideQuestion = SideQuestion(question: question)
        return true
    }
}

extension String {
    var nonEmpty: String? { isEmpty ? nil : self }
}
