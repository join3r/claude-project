import DevToolKit
import SwiftUI

enum SidebarSelection: Hashable {
    /// Every desktop's tasks in the desktop inbox's groups (§8.3).
    case inbox
    case all
    case desktop(String)
}

struct RootView: View {
    @Environment(AppModel.self) private var model
    let demoRoute: LaunchOptions.DemoRoute?

    @State private var sidebar: SidebarSelection?
    @State private var taskSelection: TaskRef?
    /// Projects pushed on a desktop's screen.
    @State private var projectPath: [ProjectRef] = []
    /// A chat a notification asked for; the task screen opens it when it is one of the task's.
    @State private var openTab: ChatRoute?
    /// `-demoRoute taskInfo`: the task screen opens with its info sheet up.
    @State private var demoInfo = false
    @State private var preferredColumn: NavigationSplitViewColumn
    @State private var columnVisibility: NavigationSplitViewVisibility
    @State private var showSettings = false
    @State private var pairAfterSettings = false

    init(demoRoute: LaunchOptions.DemoRoute?) {
        self.demoRoute = demoRoute
        _preferredColumn = State(initialValue: demoRoute == .sidebar ? .sidebar : .content)
        _columnVisibility = State(initialValue: demoRoute == .sidebar ? .all : .automatic)
    }

    var body: some View {
        Group {
            if model.desktops.isEmpty {
                NavigationStack {
                    EmptyStateView(onPair: model.presentPairing)
                        .toolbar {
                            ToolbarItem(placement: .topBarTrailing) {
                                Button("Settings", systemImage: "gear") { showSettings = true }
                            }
                        }
                }
            } else {
                splitView
            }
        }
        .sheet(isPresented: pairingPresented) {
            PairingSheet()
        }
        .sheet(isPresented: $showSettings, onDismiss: {
            if pairAfterSettings {
                pairAfterSettings = false
                model.presentPairing()
            }
        }) {
            SettingsView(onPair: {
                pairAfterSettings = true
                showSettings = false
            })
        }
        .alert("Couldn't change the pin", isPresented: Binding(get: { model.pinError != nil }, set: { if !$0 { model.pinError = nil } })) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(model.pinError ?? "")
        }
        .alert("Couldn't update the inbox", isPresented: Binding(get: { model.triageError != nil }, set: { if !$0 { model.triageError = nil } })) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(model.triageError ?? "")
        }
        .onAppear { if sidebar == nil { sidebar = defaultSidebar } }
        .onChange(of: model.desktops.map(\.id)) { _, ids in
            if case .desktop(let id) = sidebar, !ids.contains(id) { sidebar = defaultSidebar }
            if let ref = taskSelection, !ids.contains(ref.desktopId) { taskSelection = nil }
            if sidebar == nil || (sidebar == .all && ids.count < 2) { sidebar = defaultSidebar }
        }
        .onChange(of: sidebar) { _, _ in
            if let ref = taskSelection, !scopeIds.contains(ref.desktopId) { taskSelection = nil }
            projectPath = []
        }
        .task { await runDemoRoute() }
        // A tapped notification: now, or (cold launch) as soon as the view is up.
        .task { await openRequestedChat() }
        .onChange(of: model.requestedChat) { _, route in
            if route != nil { Task { await openRequestedChat() } }
        }
    }

    private var splitView: some View {
        NavigationSplitView(columnVisibility: $columnVisibility, preferredCompactColumn: $preferredColumn) {
            SidebarView(
                selection: $sidebar,
                onSettings: { showSettings = true },
                onPair: model.presentPairing
            )
        } content: {
            switch sidebar ?? defaultSidebar {
            case .inbox:
                InboxView(selection: $taskSelection)
            case let scope:
                NavigationStack(path: $projectPath) {
                    DesktopView(scope: scope, selection: $taskSelection)
                        .navigationDestination(for: ProjectRef.self) { ref in
                            ProjectView(ref: ref, selection: $taskSelection)
                        }
                }
            }
        } detail: {
            NavigationStack {
                if let ref = taskSelection {
                    TaskScreen(
                        ref: ref,
                        openTab: openTab?.desktopId == ref.desktopId ? openTab?.tabId : nil,
                        showInfo: demoInfo,
                        onClosed: { taskSelection = nil }
                    )
                    .id(ref)
                } else {
                    ContentUnavailableView("No task open", systemImage: "bubble.left.and.text.bubble.right", description: Text("Pick a task to open its conversation."))
                }
            }
        }
    }

    private var defaultSidebar: SidebarSelection { .inbox }

    private var scopeIds: [String] {
        switch sidebar ?? defaultSidebar {
        case .inbox, .all: model.desktops.map(\.id)
        case .desktop(let id): [id]
        }
    }

    private var pairingPresented: Binding<Bool> {
        Binding(
            get: { model.pairing != nil },
            set: { if !$0 { model.dismissPairing() } }
        )
    }

    /// The claude-chat tab `-demoRoute chat` opens: `-demoTab`, else the first
    /// one that needs attention, else the first one.
    private func demoChatTarget() -> (desktopId: String, taskId: String, tabId: String)? {
        let wanted = LaunchOptions.current.demoTab
        var fallback: (String, String, String)?
        for desktop in model.desktops where !model.isOffline(desktop.id) {
            for project in model.inboxes[desktop.id]?.projects ?? [] {
                for task in project.tasks {
                    for tab in task.tabs where tab.type == .claudeChat {
                        if let wanted {
                            if tab.id == wanted { return (desktop.id, task.id, tab.id) }
                        } else if tab.status == .attention {
                            return (desktop.id, task.id, tab.id)
                        } else if fallback == nil {
                            fallback = (desktop.id, task.id, tab.id)
                        }
                    }
                }
            }
        }
        return wanted == nil ? fallback : nil
    }

    /// Opens the chat a tapped notification points at. On a cold launch the
    /// inbox may not be there yet, so it waits for the tab for a while; if it
    /// never shows up, it still selects the desktop.
    private func openRequestedChat() async {
        guard let route = model.requestedChat else { return }
        model.requestedChat = nil
        guard model.desktop(route.desktopId) != nil else { return }
        showSettings = false
        if model.pairing != nil { model.dismissPairing() }
        for _ in 0..<100 {
            if let found = model.tab(desktopId: route.desktopId, tabId: route.tabId) {
                open(TaskRef(desktopId: route.desktopId, taskId: found.task.id), tab: route)
                return
            }
            try? await Task.sleep(for: .milliseconds(100))
        }
        if !scopeIds.contains(route.desktopId) { sidebar = .desktop(route.desktopId) }
    }

    /// Shows a task's screen, on `tab` when it is one of its chats.
    private func open(_ ref: TaskRef, tab: ChatRoute? = nil) {
        // The Inbox (or All desktops) already lists the task; stay there.
        if !scopeIds.contains(ref.desktopId) { sidebar = .desktop(ref.desktopId) }
        openTab = tab
        taskSelection = ref
        preferredColumn = .detail
    }

    /// Debug-only shortcuts for screenshots (`-demoRoute`).
    private func runDemoRoute() async {
        guard let demoRoute else { return }
        switch demoRoute {
        case .sidebar:
            try? await Task.sleep(for: .milliseconds(600))
            columnVisibility = .all
            preferredColumn = .sidebar
        case .projects, .desktop:
            try? await Task.sleep(for: .milliseconds(400))
            if let first = model.desktops.first { sidebar = .desktop(first.id) }
        case .project:
            try? await Task.sleep(for: .milliseconds(400))
            if let first = model.desktops.first {
                sidebar = .desktop(first.id)
                for _ in 0..<50 {
                    if let project = model.inboxes[first.id]?.projects.first {
                        try? await Task.sleep(for: .milliseconds(300))
                        projectPath = [ProjectRef(desktopId: first.id, projectId: project.id)]
                        return
                    }
                    try? await Task.sleep(for: .milliseconds(100))
                }
            }
        case .pair:
            try? await Task.sleep(for: .milliseconds(400))
            model.presentPairing()
        case .pairConfirm, .pairWait:
            try? await Task.sleep(for: .milliseconds(400))
            let invite = PairingInvite(
                relayURL: URL(string: "wss://relay.devtool.awantech.sk")!,
                desktopId: "0123456789abcdef0123456789abcdef",
                desktopX25519PublicKey: Data(repeating: 5, count: 32),
                desktopEd25519PublicKey: Data(repeating: 6, count: 32),
                secret: Data(repeating: 7, count: 32),
                desktopName: "office-imac",
                expiresAt: Date().addingTimeInterval(300)
            )
            model.handlePairingLink(invite.uri)
            if demoRoute == .pairWait { model.confirmPairing(invite) }
        case .settings:
            try? await Task.sleep(for: .milliseconds(400))
            showSettings = true
        case .chat, .taskInfo:
            demoInfo = demoRoute == .taskInfo
            for _ in 0..<150 {
                if let target = demoChatTarget() {
                    open(TaskRef(desktopId: target.desktopId, taskId: target.taskId),
                         tab: ChatRoute(desktopId: target.desktopId, tabId: target.tabId))
                    return
                }
                try? await Task.sleep(for: .milliseconds(100))
            }
        case .task, .taskStatus:
            for attempt in 0..<50 {
                let fallback = attempt == 49 ? model.inboxes.values.first : nil
                if let inbox = model.inboxes[AppModel.mockOnlineId] ?? fallback {
                    let tasks = inbox.projects.flatMap(\.tasks)
                    // `taskStatus`: the first terminal agent's task.
                    let pick = demoRoute == .taskStatus
                        ? tasks.first { $0.agentTab.map { $0.type.isAgent && $0.type != .claudeChat } ?? false }
                        : tasks.first
                    if let task = pick {
                        open(TaskRef(desktopId: inbox.desktop.id, taskId: task.id))
                        return
                    }
                }
                try? await Task.sleep(for: .milliseconds(100))
            }
        }
    }
}
