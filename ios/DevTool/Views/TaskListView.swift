import DevToolKit
import SwiftUI

/// Projects → tasks for one desktop, or all desktops merged.
struct TaskListView: View {
    @Environment(AppModel.self) private var model
    let scope: SidebarSelection
    @Binding var selection: TaskRef?
    @State private var newTask: NewTaskTarget?
    @State private var closing: CloseTaskRequest?

    var body: some View {
        List(selection: $selection) {
            let problems = scopeDesktops.filter { model.state(of: $0.id).problem != nil }
            if !problems.isEmpty {
                Section {
                    ForEach(problems) { desktop in
                        if let problem = model.state(of: desktop.id).problem {
                            ConnectionProblemBanner(
                                desktopName: desktop.name,
                                problem: problem,
                                onPairAgain: model.presentPairing
                            )
                        }
                    }
                }
                .listRowInsets(EdgeInsets())
                .listRowBackground(Color.clear)
                .listSectionSpacing(.compact)
            }
            let offline = scopeDesktops.filter { model.isOffline($0.id) && model.state(of: $0.id).problem == nil }
            if !offline.isEmpty {
                Section {
                    ForEach(offline) { desktop in
                        OfflineBanner(
                            title: scopeDesktops.count == 1 ? "Desktop" : desktop.name,
                            lastSeen: offlineLastSeen(desktop)
                        )
                    }
                }
                .listRowInsets(EdgeInsets())
                .listRowBackground(Color.clear)
                .listSectionSpacing(.compact)
            }
            ForEach(scopeDesktops) { desktop in
                desktopSections(desktop)
            }
        }
        .listStyle(.insetGrouped)
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
        .refreshable {
            await model.refresh(scopeDesktops.map(\.id))
        }
        .sheet(item: $newTask) { target in
            NewTaskSheet(target: target)
        }
        .closeTaskFlow($closing) { closed in
            if selection == TaskRef(desktopId: closed.desktopId, taskId: closed.taskId) { selection = nil }
        }
    }

    @ViewBuilder
    private func desktopSections(_ desktop: DesktopRecord) -> some View {
        let offline = model.isOffline(desktop.id)
        let showDesktop = scopeDesktops.count > 1
        if let inbox = model.inboxes[desktop.id] {
            if inbox.projects.isEmpty {
                Section(showDesktop ? desktop.name : "") {
                    Text("No projects")
                        .foregroundStyle(.secondary)
                }
            }
            ForEach(inbox.projects) { project in
                Section {
                    ForEach(sortedTasks(project)) { task in
                        TaskRow(task: task)
                            .tag(TaskRef(desktopId: desktop.id, taskId: task.id))
                            .opacity(offline ? 0.55 : 1)
                            .swipeActions(edge: .trailing) {
                                if model.supports(DesktopFeature.taskClose, on: desktop.id) && !offline {
                                    // Not `role: .destructive`: the row stays until the desktop
                                    // confirms, and a blocker may keep it.
                                    Button {
                                        closing = CloseTaskRequest(desktopId: desktop.id, task: task)
                                    } label: {
                                        Label("Close", systemImage: "xmark")
                                    }
                                    .tint(.red)
                                }
                            }
                    }
                    if project.tasks.isEmpty {
                        Text("No tasks").foregroundStyle(.secondary)
                    }
                    if model.supports(DesktopFeature.taskNew, on: desktop.id) {
                        Button {
                            newTask = NewTaskTarget(desktopId: desktop.id, project: project, workspace: false)
                        } label: {
                            Label("New task", systemImage: "plus")
                        }
                        .disabled(offline)
                        if model.supports(DesktopFeature.taskWorkspace, on: desktop.id) {
                            Button {
                                newTask = NewTaskTarget(desktopId: desktop.id, project: project, workspace: true)
                            } label: {
                                Label("New workspace", systemImage: "arrow.triangle.branch")
                            }
                            .disabled(offline)
                        }
                    }
                } header: {
                    ProjectHeader(project: project, desktopName: showDesktop ? desktop.name : nil)
                }
            }
        } else {
            Section(showDesktop ? desktop.name : "") {
                if offline {
                    Label("Nothing cached from this desktop yet", systemImage: "tray")
                        .foregroundStyle(.secondary)
                } else {
                    HStack(spacing: 10) {
                        ProgressView()
                        Text("Connecting to \(desktop.name)…")
                            .foregroundStyle(.secondary)
                    }
                }
            }
        }
    }

    private var scopeDesktops: [DesktopRecord] {
        switch scope {
        case .all: model.desktops
        case .desktop(let id): model.desktops.filter { $0.id == id }
        }
    }

    private var title: String {
        switch scope {
        case .all: "All desktops"
        case .desktop(let id): model.desktop(id)?.name ?? "Desktop"
        }
    }

    private func offlineLastSeen(_ desktop: DesktopRecord) -> Date? {
        if case .offline(let seen?) = model.state(of: desktop.id) { return seen }
        return desktop.lastSeen
    }

    /// Tasks that need you first (newest attention first), then by last interaction.
    private func sortedTasks(_ project: InboxProject) -> [InboxTask] {
        project.tasks.sorted { a, b in
            let aAttention = a.summaryStatus == .attention
            let bAttention = b.summaryStatus == .attention
            if aAttention != bAttention { return aAttention }
            if a.sortTimestamp != b.sortTimestamp { return a.sortTimestamp > b.sortTimestamp }
            return a.name.localizedStandardCompare(b.name) == .orderedAscending
        }
    }
}

struct ProjectHeader: View {
    let project: InboxProject
    let desktopName: String?

    var body: some View {
        HStack(spacing: 6) {
            if let emoji = project.emoji, !emoji.isEmpty {
                Text(emoji)
            }
            Text(project.name)
            if project.remote {
                Image(systemName: "network")
                    .accessibilityLabel("Remote")
            }
            if let desktopName {
                Text("· \(desktopName)")
                    .foregroundStyle(.tertiary)
            }
        }
        .lineLimit(1)
    }
}

struct TaskRow: View {
    let task: InboxTask

    var body: some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 3) {
                Text(task.name)
                    .font(.body.weight(task.summaryStatus == .attention ? .semibold : .regular))
                    .lineLimit(1)
                if let branch = task.branch {
                    Label(branch, systemImage: "arrow.triangle.branch")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .labelStyle(.titleAndIcon)
                        .lineLimit(1)
                        .accessibilityLabel("Branch \(branch)")
                }
                Text(subtitle)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Spacer(minLength: 8)
            StatusBadge(status: task.summaryStatus, hideIdle: true)
        }
        .padding(.vertical, 2)
        .alignmentGuide(.listRowSeparatorLeading) { d in d[.leading] }
    }

    /// The activity of the most relevant tab, else a tab count and recency.
    private var subtitle: String {
        let lead = task.tabs.max { $0.status.priority < $1.status.priority }
        if let lead, lead.status != .idle, let activity = lead.activity, !activity.isEmpty {
            return "\(lead.title): \(activity)"
        }
        let tabs = task.tabs.count == 1 ? "1 tab" : "\(task.tabs.count) tabs"
        guard let last = task.lastInteractedAt else { return tabs }
        return "\(tabs) · \(RelativeTime.text(for: Date(unixMilliseconds: last), now: Date()))"
    }
}
