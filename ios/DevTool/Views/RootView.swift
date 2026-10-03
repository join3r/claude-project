import DevToolKit
import SwiftUI

enum SidebarSelection: Hashable {
    case all
    case desktop(String)
}

struct RootView: View {
    @Environment(AppModel.self) private var model
    let demoRoute: LaunchOptions.DemoRoute?

    @State private var sidebar: SidebarSelection?
    @State private var taskSelection: TaskRef?
    /// Pushed on top of the task detail (a chat).
    @State private var detailPath: [ChatRoute] = []
    @State private var preferredColumn: NavigationSplitViewColumn
    @State private var columnVisibility: NavigationSplitViewVisibility
    @State private var showSettings = false
    @State private var pairAfterSettings = false
    @State private var demoNavigating = false

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
        .onAppear { if sidebar == nil { sidebar = defaultSidebar } }
        .onChange(of: model.desktops.map(\.id)) { _, ids in
            if case .desktop(let id) = sidebar, !ids.contains(id) { sidebar = defaultSidebar }
            if let ref = taskSelection, !ids.contains(ref.desktopId) { taskSelection = nil }
            if sidebar == nil || (sidebar == .all && ids.count == 1) { sidebar = defaultSidebar }
        }
        .onChange(of: sidebar) { _, _ in
            if let ref = taskSelection, !scopeIds.contains(ref.desktopId) { taskSelection = nil }
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
            TaskListView(scope: sidebar ?? defaultSidebar, selection: $taskSelection)
        } detail: {
            NavigationStack(path: $detailPath) {
                if let ref = taskSelection {
                    TaskDetailView(ref: ref, onClosed: { taskSelection = nil })
                        .navigationDestination(for: ChatRoute.self) { route in
                            ChatScreen(route: route, app: model)
                        }
                } else {
                    ContentUnavailableView("Select a task", systemImage: "checklist", description: Text("Pick a task to see its tabs and what they are doing."))
                }
            }
        }
        .onChange(of: taskSelection) { _, _ in
            if !demoNavigating { detailPath = [] }
        }
    }

    private var defaultSidebar: SidebarSelection {
        if model.desktops.count == 1, let only = model.desktops.first { return .desktop(only.id) }
        return .all
    }

    private var scopeIds: [String] {
        switch sidebar ?? defaultSidebar {
        case .all: model.desktops.map(\.id)
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
        if detailPath.last == route { return }
        for _ in 0..<100 {
            if let found = model.tab(desktopId: route.desktopId, tabId: route.tabId) {
                demoNavigating = true
                sidebar = .desktop(route.desktopId)
                let ref = TaskRef(desktopId: route.desktopId, taskId: found.task.id)
                if taskSelection != ref {
                    taskSelection = ref
                    try? await Task.sleep(for: .milliseconds(350))
                }
                preferredColumn = .detail
                detailPath = found.tab.type == .claudeChat ? [route] : []
                demoNavigating = false
                return
            }
            try? await Task.sleep(for: .milliseconds(100))
        }
        sidebar = .desktop(route.desktopId)
    }

    /// Debug-only shortcuts for screenshots (`-demoRoute`).
    private func runDemoRoute() async {
        guard let demoRoute else { return }
        switch demoRoute {
        case .sidebar:
            try? await Task.sleep(for: .milliseconds(600))
            columnVisibility = .all
            preferredColumn = .sidebar
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
        case .chat:
            for _ in 0..<150 {
                if let target = demoChatTarget() {
                    demoNavigating = true
                    sidebar = .desktop(target.desktopId)
                    taskSelection = TaskRef(desktopId: target.desktopId, taskId: target.taskId)
                    preferredColumn = .detail
                    try? await Task.sleep(for: .milliseconds(350))
                    detailPath = [ChatRoute(desktopId: target.desktopId, tabId: target.tabId)]
                    demoNavigating = false
                    return
                }
                try? await Task.sleep(for: .milliseconds(100))
            }
        case .task:
            for attempt in 0..<50 {
                let fallback = attempt == 49 ? model.inboxes.values.first : nil
                if let inbox = model.inboxes[AppModel.mockOnlineId] ?? fallback,
                   let task = inbox.projects.first?.tasks.first {
                    sidebar = .desktop(inbox.desktop.id)
                    taskSelection = TaskRef(desktopId: inbox.desktop.id, taskId: task.id)
                    preferredColumn = .detail
                    return
                }
                try? await Task.sleep(for: .milliseconds(100))
            }
        }
    }
}
