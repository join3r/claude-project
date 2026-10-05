import DevToolKit
import SwiftUI

struct TaskDetailView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.scenePhase) private var scenePhase
    let ref: TaskRef
    /// The phone closed this task (§8.7); the caller leaves the screen.
    var onClosed: () -> Void = {}

    @State private var creatingChat = false
    @State private var newChatError: String?
    @State private var closingTask: CloseTaskRequest?
    /// A busy tab waiting on "Close tab?".
    @State private var confirmTab: InboxTab?
    @State private var closingTabs: Set<String> = []
    @State private var closeTabError: String?

    var body: some View {
        if let found = model.task(ref) {
            let project = found.project
            let task = found.task
            let offline = model.isOffline(ref.desktopId)
            let desktop = model.desktop(ref.desktopId)
            List {
                if offline {
                    Section {
                        OfflineBanner(title: "Desktop", lastSeen: lastSeen(desktop))
                    }
                    .listRowInsets(EdgeInsets())
                    .listRowBackground(Color.clear)
                }
                Section {
                    LabeledContent("Project") {
                        ProjectHeader(project: project, desktopName: nil)
                    }
                    LabeledContent("Desktop", value: desktop?.name ?? "")
                    if let branch = task.branch {
                        LabeledContent("Branch") {
                            Label(branch, systemImage: "arrow.triangle.branch")
                                .labelStyle(.titleAndIcon)
                                .lineLimit(1)
                        }
                    }
                    LabeledContent("Status") {
                        StatusBadge(status: task.summaryStatus)
                    }
                    if let triage = triageText(task) {
                        LabeledContent("Inbox", value: triage)
                    }
                    if let last = task.lastInteractedAt {
                        LabeledContent("Last used") {
                            RelativeTime(date: Date(unixMilliseconds: last))
                        }
                    }
                }

                Section {
                    ForEach(task.tabs) { tab in
                        Group {
                            if tab.type == .claudeChat {
                                // Only Claude chat tabs open on the phone; the rest are status only.
                                NavigationLink(value: ChatRoute(desktopId: ref.desktopId, tabId: tab.id)) {
                                    TabRow(tab: tab)
                                }
                            } else {
                                TabRow(tab: tab)
                            }
                        }
                        .opacity(closingTabs.contains(tab.id) ? 0.4 : 1)
                        .swipeActions(edge: .trailing) {
                            if model.supports(DesktopFeature.tabClose, on: ref.desktopId) && !offline {
                                Button {
                                    requestCloseTab(tab)
                                } label: {
                                    Label("Close", systemImage: "xmark")
                                }
                                .tint(.red)
                            }
                        }
                    }
                    if task.tabs.isEmpty {
                        Text("No agent or terminal tabs").foregroundStyle(.secondary)
                    }
                    if model.supports(DesktopFeature.chatNew, on: ref.desktopId) {
                        newChatRow(offline: offline)
                    }
                } header: {
                    Text("Tabs")
                } footer: {
                    if task.tabs.contains(where: { $0.type == .claudeChat }) {
                        Text("Open a Claude chat to read it, reply and answer its requests.")
                    }
                }
                .opacity(offline ? 0.55 : 1)

                if model.supports(DesktopFeature.taskClose, on: ref.desktopId) {
                    Section {
                        Button(role: .destructive) {
                            closingTask = CloseTaskRequest(desktopId: ref.desktopId, task: task)
                        } label: {
                            Label(task.branch == nil ? "Close task" : "Close workspace", systemImage: "xmark.circle")
                        }
                        .tint(.red)
                        .disabled(offline)
                    } footer: {
                        if task.branch != nil {
                            Text("Removes the worktree from disk. You're asked first if it has uncommitted or unmerged work.")
                        }
                    }
                }
            }
            .listStyle(.insetGrouped)
            .closeTaskFlow($closingTask) { _ in onClosed() }
            .confirmationDialog(
                confirmTab.map { "Close “\($0.title.isEmpty ? $0.type.displayName : $0.title)”?" } ?? "",
                isPresented: Binding(get: { confirmTab != nil }, set: { if !$0 { confirmTab = nil } }),
                titleVisibility: .visible,
                presenting: confirmTab
            ) { tab in
                Button("Close tab", role: .destructive) { Task { await closeTab(tab) } }
                Button("Cancel", role: .cancel) {}
            } message: { tab in
                Text(tab.status == .attention ? "It is waiting for you. Closing it stops it on the desktop." : "It is still working. Closing it stops it on the desktop.")
            }
            .alert("Couldn't close the tab", isPresented: Binding(get: { closeTabError != nil }, set: { if !$0 { closeTabError = nil } })) {
                Button("OK", role: .cancel) {}
            } message: {
                Text(closeTabError ?? "")
            }
            .navigationTitle(task.name)
            .navigationBarTitleDisplayMode(.inline)
            // Reading the task here reads it on the desktop too (§8.3), and so
            // does an event arriving while it is on screen. Marking it unread
            // here sticks until the next event.
            .onAppear { readIfActive() }
            .onChange(of: task.eventAt) { readIfActive() }
            .onChange(of: scenePhase) { readIfActive() }
            .toolbar {
                if model.supports(DesktopFeature.taskTriage, on: ref.desktopId) {
                    ToolbarItem(placement: .topBarTrailing) {
                        Menu("Inbox", systemImage: "tray") {
                            TriageMenuItems(ref: ref, task: task, now: Date())
                        }
                        .disabled(offline)
                    }
                }
                if model.supports(DesktopFeature.pin, on: ref.desktopId) {
                    let pinned = model.inboxes[ref.desktopId]?.isPinned(projectId: project.id, taskId: task.id) ?? false
                    ToolbarItem(placement: .topBarTrailing) {
                        Button(pinned ? "Unpin" : "Pin", systemImage: pinned ? "pin.fill" : "pin") {
                            Task { await model.setPin(InboxPin(projectId: project.id, taskId: task.id), pinned: !pinned, desktopId: ref.desktopId) }
                        }
                        .disabled(offline)
                    }
                }
            }
            .refreshable { await model.refresh([ref.desktopId]) }
            .alert("Couldn't start a chat", isPresented: Binding(get: { newChatError != nil }, set: { if !$0 { newChatError = nil } })) {
                Button("OK", role: .cancel) {}
            } message: {
                Text(newChatError ?? "")
            }
        } else {
            ContentUnavailableView("Task not found", systemImage: "questionmark.folder", description: Text("It may have been closed on the desktop."))
        }
    }

    /// "New chat" (§8.2, §8.3): adds a Claude chat to the task on the desktop
    /// and opens it once it shows up in the inbox.
    private func newChatRow(offline: Bool) -> some View {
        Button {
            Task { await createChat() }
        } label: {
            HStack(spacing: 12) {
                Image(systemName: "plus.bubble")
                    .frame(width: 28)
                Text("New chat")
                Spacer()
                if creatingChat { ProgressView() }
            }
        }
        .disabled(offline || creatingChat)
    }

    private func createChat() async {
        guard !creatingChat else { return }
        creatingChat = true
        defer { creatingChat = false }
        do {
            // RootView waits for the tab to appear in the inbox, then pushes the chat.
            model.requestedChat = try await model.newChat(in: ref)
        } catch {
            newChatError = error.localizedDescription
        }
    }

    /// A working or waiting tab is confirmed first; an idle or exited one closes at once.
    private func requestCloseTab(_ tab: InboxTab) {
        if tab.status == .working || tab.status == .attention {
            confirmTab = tab
        } else {
            Task { await closeTab(tab) }
        }
    }

    /// `tab.close` (§8.8). The row stays dimmed until the next inbox drops it.
    private func closeTab(_ tab: InboxTab) async {
        guard !closingTabs.contains(tab.id) else { return }
        closingTabs.insert(tab.id)
        do {
            try await model.closeTab(desktopId: ref.desktopId, tabId: tab.id)
        } catch {
            closingTabs.remove(tab.id)
            closeTabError = error.localizedDescription
        }
    }

    private func readIfActive() {
        if scenePhase == .active { model.markRead(ref) }
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

    private func lastSeen(_ desktop: DesktopRecord?) -> Date? {
        if case .offline(let seen?) = model.state(of: ref.desktopId) { return seen }
        return desktop?.lastSeen
    }
}

struct TabRow: View {
    let tab: InboxTab

    var body: some View {
        HStack(alignment: .center, spacing: 12) {
            TabTypeIcon(type: tab.type, status: tab.status)
            VStack(alignment: .leading, spacing: 4) {
                HStack(alignment: .firstTextBaseline) {
                    Text(tab.title.isEmpty ? tab.type.displayName : tab.title)
                        .lineLimit(1)
                    Spacer(minLength: 8)
                    if let since = tab.since {
                        RelativeTime(date: Date(unixMilliseconds: since))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                HStack(spacing: 6) {
                    StatusBadge(status: tab.status)
                    if let activity = tab.activity, !activity.isEmpty {
                        Text(activity)
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
}
