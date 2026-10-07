import DevToolKit
import SwiftUI

/// A task opens on its conversation (§8.3): a Claude chat task on `ChatScreen`,
/// any other on its status screen. The header (or ⓘ) opens the task info sheet.
struct TaskScreen: View {
    @Environment(AppModel.self) private var model
    @Environment(\.scenePhase) private var scenePhase
    let ref: TaskRef
    /// A chat tab of this task to open instead of its agent (a tapped notification).
    var openTab: String?
    /// The phone closed this task (§8.7); the caller leaves the screen.
    var onClosed: () -> Void = {}

    @State private var showInfo: Bool
    /// A chat picked in the info sheet (a task from before one agent per task).
    @State private var chosenTab: String?

    init(ref: TaskRef, openTab: String? = nil, showInfo: Bool = false, onClosed: @escaping () -> Void = {}) {
        self.ref = ref
        self.openTab = openTab
        self.onClosed = onClosed
        _showInfo = State(initialValue: showInfo)
    }

    var body: some View {
        if let found = model.task(ref) {
            let task = found.task
            Group {
                if let chat = chatTab(task) {
                    ChatScreen(route: ChatRoute(desktopId: ref.desktopId, tabId: chat.id), app: model, onInfo: { showInfo = true })
                        .id(chat.id)
                } else {
                    TaskStatusView(ref: ref, project: found.project, task: task, onInfo: { showInfo = true }, onClosed: onClosed)
                }
            }
            .sheet(isPresented: $showInfo) {
                TaskInfoSheet(ref: ref, onOpenChat: { tabId in
                    chosenTab = tabId
                    showInfo = false
                }, onClosed: {
                    showInfo = false
                    onClosed()
                })
            }
            // Reading the task here reads it on the desktop too (§8.3), and so
            // does an event arriving while it is on screen. Marking it unread
            // in the Inbox sticks until the next event.
            .onAppear { readIfActive() }
            .onChange(of: task.eventAt) { readIfActive() }
            .onChange(of: scenePhase) { readIfActive() }
        } else {
            ContentUnavailableView("Task not found", systemImage: "questionmark.folder", description: Text("It may have been closed on the desktop."))
        }
    }

    /// The chat to show: one asked for, else the task's agent when it is a Claude chat.
    private func chatTab(_ task: InboxTask) -> InboxTab? {
        for id in [chosenTab, openTab].compactMap({ $0 }) {
            if let tab = task.tabs.first(where: { $0.id == id }), tab.type == .claudeChat { return tab }
        }
        guard let agent = task.agentTab, agent.type == .claudeChat else { return nil }
        return agent
    }

    private func readIfActive() {
        if scenePhase == .active { model.markRead(ref) }
    }
}

/// The header of a task's screen in the navigation bar: tile, **project** ›
/// stream, task name. Tapping it opens the task info sheet.
struct TaskNavigationHeader: ToolbarContent {
    let project: InboxProject
    let task: InboxTask
    var detail: String?
    let onInfo: () -> Void

    var body: some ToolbarContent {
        ToolbarItem(placement: .principal) {
            Button(action: onInfo) {
                TaskTitleHeader(project: project, task: task, detail: detail)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityHint("Shows the task's details")
        }
        ToolbarItem(placement: .topBarTrailing) {
            Button("Task info", systemImage: "info.circle", action: onInfo)
        }
    }
}

/// A terminal agent's or terminal's task (§8.3): what it is doing, from the
/// inbox. It can't be answered from the phone.
struct TaskStatusView: View {
    @Environment(AppModel.self) private var model
    let ref: TaskRef
    let project: InboxProject
    let task: InboxTask
    let onInfo: () -> Void
    let onClosed: () -> Void
    @State private var closing: CloseTaskRequest?

    var body: some View {
        let offline = model.isOffline(ref.desktopId)
        let agent = task.agentTab
        List {
            if offline {
                Section {
                    OfflineBanner(title: "Desktop", lastSeen: lastSeen)
                }
                .listRowInsets(EdgeInsets())
                .listRowBackground(Color.clear)
            }
            Section {
                VStack(alignment: .leading, spacing: 12) {
                    HStack(spacing: 12) {
                        Image(systemName: agent?.type.symbol ?? "terminal")
                            .font(.system(size: 19, weight: .medium))
                            .foregroundStyle(Color.accentColor)
                            .frame(width: 40, height: 40)
                            .background(Color.accentColor.opacity(0.14), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                            .accessibilityHidden(true)
                        VStack(alignment: .leading, spacing: 1) {
                            Text(agentName(agent))
                                .font(.headline)
                            Text(isTerminal(agent) ? "A terminal on the desktop" : "Runs in a terminal on the desktop")
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                        }
                    }
                    StatusChip(status: task.status, since: task.since)
                    if let activity = InboxClock.activity(task) ?? agent?.activity.flatMap({ $0.isEmpty ? nil : $0 }) {
                        Text(activity)
                            .font(.title3.weight(.medium))
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    if let topic = agent?.topic, !topic.isEmpty {
                        Text("Last prompt: “\(topic)”")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                .padding(.vertical, 6)
            } footer: {
                Text(isTerminal(agent)
                     ? "A terminal can’t be used from the phone."
                     : "Terminal agents can’t be answered from the phone. Answer it on the desktop.")
            }
            AlsoOpenSection(ref: ref, tabs: task.otherTabs)
            if model.supports(DesktopFeature.taskClose, on: ref.desktopId) {
                Section {
                    Button(role: .destructive) {
                        closing = CloseTaskRequest(desktopId: ref.desktopId, task: task)
                    } label: {
                        Label("Close task", systemImage: "xmark.circle")
                            .foregroundStyle(.red)
                    }
                    .disabled(offline)
                }
            }
        }
        .listStyle(.insetGrouped)
        .navigationTitle(task.name)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { TaskNavigationHeader(project: project, task: task, onInfo: onInfo) }
        .closeTaskFlow($closing) { _ in onClosed() }
        .refreshable { await model.refresh([ref.desktopId]) }
    }

    private func isTerminal(_ agent: InboxTab?) -> Bool {
        agent.map { !$0.type.isAgent } ?? true
    }

    private func agentName(_ agent: InboxTab?) -> String {
        guard let agent else { return "Task" }
        if agent.type == .terminal, !agent.title.isEmpty { return agent.title }
        return agent.type.displayName
    }

    private var lastSeen: Date? {
        if case .offline(let seen?) = model.state(of: ref.desktopId) { return seen }
        return model.desktop(ref.desktopId)?.lastSeen
    }
}

/// The task info sheet (§8.3): where the task runs, its other tabs, and Pin,
/// Snooze and Close task.
struct TaskInfoSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let ref: TaskRef
    /// Opens another Claude chat of the task (one from before one agent per task).
    var onOpenChat: (String) -> Void = { _ in }
    let onClosed: () -> Void
    @State private var closing: CloseTaskRequest?

    var body: some View {
        NavigationStack {
            if let found = model.task(ref) {
                content(project: found.project, task: found.task)
            } else {
                ContentUnavailableView("Task not found", systemImage: "questionmark.folder", description: Text("It may have been closed on the desktop."))
                    .toolbar { doneButton }
            }
        }
        .presentationDetents([.large])
        .presentationDragIndicator(.visible)
    }

    private var doneButton: some ToolbarContent {
        ToolbarItem(placement: .confirmationAction) {
            Button("Done") { dismiss() }
        }
    }

    private func content(project: InboxProject, task: InboxTask) -> some View {
        let offline = model.isOffline(ref.desktopId)
        let stream = project.streams.first { $0.id == task.streamId }
        let streamName = stream?.name ?? task.streamName
        return List {
            Section {
                TaskTitleHeader(project: project, task: task, tileSize: 44, projectFont: .title3.weight(.bold))
                    .listRowBackground(Color.clear)
                    .listRowInsets(EdgeInsets(top: 0, leading: 4, bottom: 0, trailing: 4))
            }
            .listSectionSpacing(.compact)
            if offline {
                Section {
                    OfflineBanner(title: "Desktop", lastSeen: lastSeen)
                }
                .listRowInsets(EdgeInsets())
                .listRowBackground(Color.clear)
            }
            Section {
                LabeledContent("Task", value: task.agentTab?.type.displayName ?? "None")
                LabeledContent("Stream") {
                    if let stream {
                        StreamLabel(stream: stream)
                    } else {
                        Text(streamName.isEmpty ? "main" : streamName)
                    }
                }
                LabeledContent("Desktop", value: model.desktop(ref.desktopId)?.name ?? "")
                LabeledContent("Status") {
                    StatusChip(status: task.status, since: task.since)
                }
                if let triage = triageText(task) {
                    LabeledContent("Inbox", value: triage)
                }
            }
            AlsoOpenSection(ref: ref, tabs: task.otherTabs, onOpenChat: onOpenChat)
            actions(project: project, task: task, streamName: streamName, offline: offline)
        }
        .listStyle(.insetGrouped)
        .navigationTitle("")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { doneButton }
        .closeTaskFlow($closing) { _ in onClosed() }
    }

    @ViewBuilder
    private func actions(project: InboxProject, task: InboxTask, streamName: String, offline: Bool) -> some View {
        let canPin = model.supports(DesktopFeature.pin, on: ref.desktopId)
        let canTriage = model.supports(DesktopFeature.taskTriage, on: ref.desktopId)
        let canClose = model.supports(DesktopFeature.taskClose, on: ref.desktopId)
        if canPin || canTriage || canClose {
            Section {
                if canPin {
                    let pin = InboxPin.task(task, in: project)
                    let pinned = model.inboxes[ref.desktopId]?.isPinned(pin) ?? false
                    Button(pinned ? "Unpin task" : "Pin task", systemImage: pinned ? "pin.slash" : "pin") {
                        Task { await model.setPin(pin, pinned: !pinned, desktopId: ref.desktopId) }
                    }
                    .disabled(offline)
                }
                if canTriage {
                    let now = Date()
                    Menu {
                        if task.inboxGroup(now: now) == .snoozed {
                            Button("Unsnooze", systemImage: "bell") { triage(.unsnooze) }
                        }
                        ForEach(SnoozePreset.presets(now: now)) { preset in
                            Button(preset.menuTitle) { triage(preset.action) }
                        }
                    } label: {
                        Label("Snooze", systemImage: "moon.zzz")
                    }
                    .disabled(offline)
                }
                if canClose {
                    Button(role: .destructive) {
                        closing = CloseTaskRequest(desktopId: ref.desktopId, task: task)
                    } label: {
                        Label("Close task", systemImage: "xmark.circle")
                            .foregroundStyle(.red)
                    }
                    .disabled(offline)
                }
            } footer: {
                if canClose {
                    Text(streamName.isEmpty
                         ? "Moves it to the Done list, where it can be reopened."
                         : "Moves it to \(streamName)’s Done list, where it can be reopened.")
                }
            }
        }
    }

    private func triage(_ action: TaskTriageParams.Action) {
        Task { await model.triage(action, task: ref) }
    }

    /// The task's triage state, when it isn't simply in the inbox.
    private func triageText(_ task: InboxTask) -> String? {
        let now = Date()
        switch task.inboxGroup(now: now) {
        case .snoozed:
            if task.snoozeUntilAttention { return "Snoozed until it needs you" }
            guard let until = task.snoozedUntil else { return "Snoozed" }
            let date = Date(unixMilliseconds: until)
            let calendar = Calendar.current
            let time = date.formatted(date: .omitted, time: .shortened)
            if calendar.isDateInToday(date) { return "Snoozed until \(time)" }
            if calendar.isDateInTomorrow(date) { return "Snoozed until tomorrow \(time)" }
            return "Snoozed until \(date.formatted(.dateTime.weekday(.wide).hour().minute()))"
        case .settled:
            return "Settled"
        case .needsYou, .active:
            return task.unread ? "Unread" : nil
        }
    }

    private var lastSeen: Date? {
        if case .offline(let seen?) = model.state(of: ref.desktopId) { return seen }
        return model.desktop(ref.desktopId)?.lastSeen
    }
}

/// "Also open in this task": the terminals and the like beside the agent,
/// status only. Swipe to close one (§8.8).
struct AlsoOpenSection: View {
    @Environment(AppModel.self) private var model
    let ref: TaskRef
    let tabs: [InboxTab]
    /// Set where another Claude chat of the task can be opened.
    var onOpenChat: ((String) -> Void)?

    /// A busy tab waiting on "Close tab?".
    @State private var confirmTab: InboxTab?
    @State private var closingTabs: Set<String> = []
    @State private var closeTabError: String?

    var body: some View {
        let offline = model.isOffline(ref.desktopId)
        Section {
            ForEach(tabs) { tab in
                Group {
                    if tab.type == .claudeChat, let onOpenChat {
                        Button { onOpenChat(tab.id) } label: { TabRow(tab: tab) }
                            .buttonStyle(.plain)
                    } else {
                        TabRow(tab: tab)
                    }
                }
                .opacity(closingTabs.contains(tab.id) ? 0.4 : 1)
                .swipeActions(edge: .trailing) {
                    if model.supports(DesktopFeature.tabClose, on: ref.desktopId) && !offline {
                        Button {
                            requestClose(tab)
                        } label: {
                            Label("Close", systemImage: "xmark")
                        }
                        .tint(.red)
                    }
                }
            }
            if tabs.isEmpty {
                Text("Nothing else").foregroundStyle(.secondary)
            }
        } header: {
            Text("Also open in this task")
        } footer: {
            if !tabs.isEmpty {
                Text("Terminals and the like beside the agent. Status only on the phone.")
            }
        }
        .confirmationDialog(
            confirmTab.map { "Close “\($0.title.isEmpty ? $0.type.displayName : $0.title)”?" } ?? "",
            isPresented: Binding(get: { confirmTab != nil }, set: { if !$0 { confirmTab = nil } }),
            titleVisibility: .visible,
            presenting: confirmTab
        ) { tab in
            Button("Close tab", role: .destructive) { Task { await close(tab) } }
            Button("Cancel", role: .cancel) {}
        } message: { tab in
            Text(tab.status == .attention ? "It is waiting for you. Closing it stops it on the desktop." : "It is still working. Closing it stops it on the desktop.")
        }
        .alert("Couldn't close the tab", isPresented: Binding(get: { closeTabError != nil }, set: { if !$0 { closeTabError = nil } })) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(closeTabError ?? "")
        }
    }

    /// A working or waiting tab is confirmed first; an idle or exited one closes at once.
    private func requestClose(_ tab: InboxTab) {
        if tab.status == .working || tab.status == .attention {
            confirmTab = tab
        } else {
            Task { await close(tab) }
        }
    }

    /// `tab.close` (§8.8). The row stays dimmed until the next inbox drops it.
    private func close(_ tab: InboxTab) async {
        guard !closingTabs.contains(tab.id) else { return }
        closingTabs.insert(tab.id)
        do {
            try await model.closeTab(desktopId: ref.desktopId, tabId: tab.id)
        } catch {
            closingTabs.remove(tab.id)
            closeTabError = error.localizedDescription
        }
    }
}

struct TabRow: View {
    let tab: InboxTab

    var body: some View {
        HStack(alignment: .center, spacing: 12) {
            TabTypeIcon(type: tab.type, status: tab.status)
            VStack(alignment: .leading, spacing: 4) {
                HStack(alignment: .firstTextBaseline) {
                    Text(headline)
                        .lineLimit(2)
                    Spacer(minLength: 8)
                    if let since = tab.since {
                        RelativeTime(date: Date(unixMilliseconds: since))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                HStack(spacing: 6) {
                    StatusBadge(status: tab.status)
                    if let detail {
                        Text(detail)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                }
            }
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .combine)
    }

    private var kind: String {
        tab.title.isEmpty ? tab.type.displayName : tab.title
    }

    /// What the tab is about leads; "Claude" is only the kind of tab. A desktop
    /// without `topic` gives the activity line instead.
    private var headline: String {
        if let topic = nonEmpty(tab.topic) { return topic }
        return nonEmpty(tab.activity) ?? kind
    }

    /// The tab's kind, then what it is doing, minus whatever the headline already says.
    private var detail: String? {
        let parts = [kind, nonEmpty(tab.activity)].compactMap { $0 }.filter { $0 != headline }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    private func nonEmpty(_ text: String?) -> String? {
        guard let text, !text.isEmpty else { return nil }
        return text
    }
}
