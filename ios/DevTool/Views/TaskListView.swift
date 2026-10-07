import DevToolKit
import SwiftUI

/// Projects → streams → tasks for one desktop, or all desktops merged.
struct TaskListView: View {
    @Environment(AppModel.self) private var model
    let scope: SidebarSelection
    @Binding var selection: TaskRef?
    @State private var newTask: NewTaskTarget?
    @State private var closing: CloseTaskRequest?

    var body: some View {
        List(selection: $selection) {
            DesktopBanners(desktops: scopeDesktops)
            ForEach(scopeDesktops) { desktop in
                desktopSections(desktop)
            }
        }
        .listStyle(.insetGrouped)
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                NewTaskToolbarButton(desktopIds: scopeDesktops.map(\.id), newTask: $newTask)
            }
        }
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
            let pins = inbox.resolvedPins
            if !pins.isEmpty {
                Section {
                    ForEach(pins) { pin in
                        switch pin {
                        case .task(let task, let project):
                            taskRow(task, project: project, desktop: desktop, inbox: inbox, showProject: true)
                        case .stream(let stream, let project):
                            pinnedStream(stream, project: project, desktop: desktop, inbox: inbox)
                        case .project(let project):
                            pinnedProject(project, desktop: desktop, inbox: inbox)
                        }
                    }
                } header: {
                    Text(showDesktop ? "Pinned · \(desktop.name)" : "Pinned")
                }
            }
            ForEach(inbox.projects) { project in
                Section {
                    projectTasks(project, desktop: desktop, inbox: inbox)
                    if project.tasks.isEmpty {
                        Text("No tasks").foregroundStyle(.secondary)
                    }
                    if model.supports(DesktopFeature.taskNew, on: desktop.id) {
                        Button {
                            newTask = NewTaskTarget(desktopId: desktop.id, projectId: project.id)
                        } label: {
                            Label("New task", systemImage: "plus")
                        }
                        .disabled(offline)
                    }
                } header: {
                    HStack {
                        ProjectHeader(project: project, desktopName: showDesktop ? desktop.name : nil)
                        Spacer(minLength: 8)
                        if canPin(desktop) {
                            let pin = InboxPin.project(project)
                            let pinned = inbox.isPinned(pin)
                            Button {
                                togglePin(pin, pinned: pinned, desktop: desktop)
                            } label: {
                                Image(systemName: pinned ? "pin.fill" : "pin")
                                    .foregroundStyle(pinned ? AnyShapeStyle(.orange) : AnyShapeStyle(.secondary))
                            }
                            .buttonStyle(.borderless)
                            .disabled(offline)
                            .accessibilityLabel(pinned ? "Unpin \(project.name)" : "Pin \(project.name)")
                        }
                    }
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

    /// A project's tasks grouped by stream (§8.3), each group under a stream
    /// header row. A project with nothing outside `main` lists its tasks
    /// without one.
    @ViewBuilder
    private func projectTasks(_ project: InboxProject, desktop: DesktopRecord, inbox: Inbox) -> some View {
        let groups = project.streamGroups
        let headers = groups.count > 1 || groups.contains { !$0.stream.isMain && !$0.stream.name.isEmpty }
        ForEach(groups, id: \.stream.id) { group in
            if headers && !group.stream.name.isEmpty {
                streamHeader(group.stream, project: project, desktop: desktop, inbox: inbox)
            }
            ForEach(sorted(group.tasks)) { task in
                taskRow(task, project: project, desktop: desktop, inbox: inbox, showProject: false)
            }
        }
    }

    /// A stream's header row inside its project: name and branch, with Pin
    /// and New task here.
    private func streamHeader(_ stream: InboxStream, project: InboxProject, desktop: DesktopRecord, inbox: Inbox) -> some View {
        let offline = model.isOffline(desktop.id)
        let pin = InboxPin.stream(stream, in: project)
        let pinned = inbox.isPinned(pin)
        return HStack(spacing: 6) {
            StreamLabel(stream: stream)
                .font(.footnote.weight(.semibold))
                .foregroundStyle(.secondary)
            if pinned {
                Image(systemName: "pin.fill")
                    .imageScale(.small)
                    .foregroundStyle(.orange)
                    .accessibilityLabel("Pinned")
            }
            Spacer(minLength: 0)
        }
        .listRowSeparator(.hidden, edges: .top)
        .opacity(offline ? 0.55 : 1)
        .accessibilityAddTraits(.isHeader)
        .swipeActions(edge: .leading) {
            if canPin(desktop) && !offline {
                Button {
                    togglePin(pin, pinned: pinned, desktop: desktop)
                } label: {
                    Label(pinned ? "Unpin" : "Pin", systemImage: pinned ? "pin.slash" : "pin")
                }
                .tint(.orange)
            }
        }
        .contextMenu {
            streamMenu(stream, project: project, desktop: desktop, pin: pin, pinned: pinned)
        }
    }

    @ViewBuilder
    private func streamMenu(_ stream: InboxStream, project: InboxProject, desktop: DesktopRecord, pin: InboxPin, pinned: Bool) -> some View {
        let offline = model.isOffline(desktop.id)
        if model.supports(DesktopFeature.taskNew, on: desktop.id) {
            Button {
                newTask = NewTaskTarget(desktopId: desktop.id, projectId: project.id, streamId: stream.id)
            } label: {
                Label("New task in \(stream.name)", systemImage: "plus")
            }
            .disabled(offline)
        }
        if canPin(desktop) {
            Button {
                togglePin(pin, pinned: pinned, desktop: desktop)
            } label: {
                Label(pinned ? "Unpin stream" : "Pin stream", systemImage: pinned ? "pin.slash" : "pin")
            }
            .disabled(offline)
        }
    }

    /// A task row: selects the task, swipes to pin or close it.
    private func taskRow(_ task: InboxTask, project: InboxProject, desktop: DesktopRecord, inbox: Inbox, showProject: Bool) -> some View {
        let offline = model.isOffline(desktop.id)
        let pin = InboxPin.task(task, in: project)
        let pinned = inbox.isPinned(pin)
        return TaskRow(task: task, project: showProject ? project : nil)
            .tag(TaskRef(desktopId: desktop.id, taskId: task.id))
            .opacity(offline ? 0.55 : 1)
            .swipeActions(edge: .leading) {
                if canPin(desktop) && !offline {
                    Button {
                        togglePin(pin, pinned: pinned, desktop: desktop)
                    } label: {
                        Label(pinned ? "Unpin" : "Pin", systemImage: pinned ? "pin.slash" : "pin")
                    }
                    .tint(.orange)
                }
            }
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
            .contextMenu {
                if canPin(desktop) {
                    Button {
                        togglePin(pin, pinned: pinned, desktop: desktop)
                    } label: {
                        Label(pinned ? "Unpin task" : "Pin task", systemImage: pinned ? "pin.slash" : "pin")
                    }
                    .disabled(offline)
                }
            }
    }

    /// A pinned stream (`Project › Stream`), opened in place to its tasks as
    /// the desktop's Pinned list does.
    private func pinnedStream(_ stream: InboxStream, project: InboxProject, desktop: DesktopRecord, inbox: Inbox) -> some View {
        let offline = model.isOffline(desktop.id)
        let pin = InboxPin.stream(stream, in: project)
        let tasks = sorted(project.tasks(in: stream))
        return DisclosureGroup {
            ForEach(tasks) { task in
                taskRow(task, project: project, desktop: desktop, inbox: inbox, showProject: false)
            }
            if tasks.isEmpty {
                Text("No tasks").foregroundStyle(.secondary)
            }
        } label: {
            HStack(spacing: 4) {
                ProjectHeader(project: project, desktopName: nil)
                    .layoutPriority(-1)
                Text("›").foregroundStyle(.tertiary)
                StreamLabel(stream: stream)
            }
            .lineLimit(1)
            .opacity(offline ? 0.55 : 1)
        }
        .swipeActions(edge: .leading) {
            if canPin(desktop) && !offline {
                Button {
                    togglePin(pin, pinned: true, desktop: desktop)
                } label: {
                    Label("Unpin", systemImage: "pin.slash")
                }
                .tint(.orange)
            }
        }
        .contextMenu {
            streamMenu(stream, project: project, desktop: desktop, pin: pin, pinned: true)
        }
    }

    /// A pinned project, opened in place to its tasks as the desktop's Pinned list does.
    private func pinnedProject(_ project: InboxProject, desktop: DesktopRecord, inbox: Inbox) -> some View {
        let offline = model.isOffline(desktop.id)
        let pin = InboxPin.project(project)
        return DisclosureGroup {
            projectTasks(project, desktop: desktop, inbox: inbox)
            if project.tasks.isEmpty {
                Text("No tasks").foregroundStyle(.secondary)
            }
        } label: {
            ProjectHeader(project: project, desktopName: nil)
                .opacity(offline ? 0.55 : 1)
        }
        .swipeActions(edge: .leading) {
            if canPin(desktop) && !offline {
                Button {
                    togglePin(pin, pinned: true, desktop: desktop)
                } label: {
                    Label("Unpin", systemImage: "pin.slash")
                }
                .tint(.orange)
            }
        }
        .contextMenu {
            if canPin(desktop) {
                Button {
                    togglePin(pin, pinned: true, desktop: desktop)
                } label: {
                    Label("Unpin project", systemImage: "pin.slash")
                }
                .disabled(offline)
            }
        }
    }

    private func canPin(_ desktop: DesktopRecord) -> Bool {
        model.supports(DesktopFeature.pin, on: desktop.id)
    }

    private func togglePin(_ pin: InboxPin, pinned: Bool, desktop: DesktopRecord) {
        Task { await model.setPin(pin, pinned: !pinned, desktopId: desktop.id) }
    }

    private var scopeDesktops: [DesktopRecord] {
        switch scope {
        case .all, .inbox: model.desktops
        case .desktop(let id): model.desktops.filter { $0.id == id }
        }
    }

    private var title: String {
        switch scope {
        case .all: "All desktops"
        case .inbox: "Inbox"
        case .desktop(let id): model.desktop(id)?.name ?? "Desktop"
        }
    }

    /// Tasks that need you first (newest attention first), then by last interaction.
    private func sorted(_ tasks: [InboxTask]) -> [InboxTask] {
        tasks.sorted { a, b in
            let aAttention = a.status == .attention
            let bAttention = b.status == .attention
            if aAttention != bAttention { return aAttention }
            if a.sortTimestamp != b.sortTimestamp { return a.sortTimestamp > b.sortTimestamp }
            return a.name.localizedStandardCompare(b.name) == .orderedAscending
        }
    }
}

/// Connection problems, then "offline · last seen" banners, for the desktops a list shows.
struct DesktopBanners: View {
    @Environment(AppModel.self) private var model
    let desktops: [DesktopRecord]

    var body: some View {
        let problems = desktops.filter { model.state(of: $0.id).problem != nil }
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
        let offline = desktops.filter { model.isOffline($0.id) && model.state(of: $0.id).problem == nil }
        if !offline.isEmpty {
            Section {
                ForEach(offline) { desktop in
                    OfflineBanner(
                        title: desktops.count == 1 ? "Desktop" : desktop.name,
                        lastSeen: lastSeen(desktop)
                    )
                }
            }
            .listRowInsets(EdgeInsets())
            .listRowBackground(Color.clear)
            .listSectionSpacing(.compact)
        }
    }

    private func lastSeen(_ desktop: DesktopRecord) -> Date? {
        if case .offline(let seen?) = model.state(of: desktop.id) { return seen }
        return desktop.lastSeen
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

/// A stream's name, with its branch when it has a worktree.
struct StreamLabel: View {
    let stream: InboxStream

    var body: some View {
        HStack(spacing: 6) {
            Text(stream.name)
            if let branch = stream.branch {
                // A branch named like its stream (the default) shows as the icon only.
                Label(branch, systemImage: "arrow.triangle.branch")
                    .labelStyle(StreamBranchLabelStyle(iconOnly: branch == stream.name))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .accessibilityLabel("Branch \(branch)")
            }
        }
        .lineLimit(1)
    }
}

private struct StreamBranchLabelStyle: LabelStyle {
    let iconOnly: Bool

    func makeBody(configuration: Configuration) -> some View {
        HStack(spacing: 3) {
            configuration.icon
            if !iconOnly { configuration.title }
        }
    }
}

struct TaskRow: View {
    let task: InboxTask
    /// Set where the row is out of its project's section (the Pinned list):
    /// it then shows `Project · Stream`.
    var project: InboxProject? = nil

    var body: some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    if task.unread { UnreadDot() }
                    Text(task.name)
                        .font(.body.weight(task.status == .attention || task.unread ? .semibold : .regular))
                        .lineLimit(1)
                }
                Text(project.map { "\(place($0)) · \(subtitle)" } ?? subtitle)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Spacer(minLength: 8)
            StatusBadge(status: task.status, hideIdle: true)
        }
        .padding(.vertical, 2)
        .alignmentGuide(.listRowSeparatorLeading) { d in d[.leading] }
    }

    /// `Project · Stream`.
    private func place(_ project: InboxProject) -> String {
        let name = project.emoji.map { $0.isEmpty ? project.name : "\($0) \(project.name)" } ?? project.name
        return task.streamName.isEmpty ? name : "\(name) · \(task.streamName)"
    }

    /// What the task is doing, else a tab count and recency.
    private var subtitle: String {
        if task.status != .idle, let activity = InboxClock.activity(task) {
            return activity
        }
        let tabs = task.tabs.count == 1 ? "1 tab" : "\(task.tabs.count) tabs"
        guard let last = task.lastInteractedAt else { return tabs }
        return "\(tabs) · \(RelativeTime.text(for: Date(unixMilliseconds: last), now: Date()))"
    }
}
