import DevToolKit
import SwiftUI

/// One project on one desktop: what the project screen is pushed with.
struct ProjectRef: Hashable, Sendable {
    var desktopId: String
    var projectId: String
}

/// A desktop's screen (§8.3): Pinned, then Active projects (those with open
/// tasks, the ones that need you first), then a folded Quiet projects row.
/// With All desktops, each desktop in turn.
struct DesktopView: View {
    @Environment(AppModel.self) private var model
    let scope: SidebarSelection
    @Binding var selection: TaskRef?
    @State private var newTask: NewTaskTarget?
    @State private var closing: CloseTaskRequest?
    /// Desktops whose Quiet projects are open.
    @State private var showQuiet: Set<String> = []

    var body: some View {
        TimelineView(.periodic(from: .now, by: 30)) { context in
            list(now: context.date)
        }
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(scopeDesktops.count == 1 ? .large : .inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                NewTaskToolbarButton(desktopIds: scopeDesktops.map(\.id), newTask: $newTask)
            }
        }
        .sheet(item: $newTask) { target in
            NewTaskSheet(target: target)
        }
        .closeTaskFlow($closing) { closed in
            if selection == TaskRef(desktopId: closed.desktopId, taskId: closed.taskId) { selection = nil }
        }
    }

    private func list(now: Date) -> some View {
        List(selection: $selection) {
            DesktopBanners(desktops: scopeDesktops)
            ForEach(scopeDesktops) { desktop in
                desktopSections(desktop, now: now)
            }
        }
        .listStyle(.insetGrouped)
        .refreshable {
            await model.refresh(scopeDesktops.map(\.id))
        }
    }

    @ViewBuilder
    private func desktopSections(_ desktop: DesktopRecord, now: Date) -> some View {
        let offline = model.isOffline(desktop.id)
        let several = scopeDesktops.count > 1
        if let inbox = model.inboxes[desktop.id] {
            let overview = inbox.projectOverview(now: now)
            Section {
                statusLine(desktop, inbox: inbox, now: now, named: several)
                    .listRowBackground(Color.clear)
                    .listRowInsets(EdgeInsets(top: 0, leading: 20, bottom: 0, trailing: 20))
            }
            .listSectionSpacing(.compact)
            if inbox.projects.isEmpty {
                Section {
                    Text("No projects").foregroundStyle(.secondary)
                }
            }
            let pins = inbox.resolvedPins
            if !pins.isEmpty {
                Section("Pinned") {
                    ForEach(pins) { pin in
                        pinnedRow(pin, desktop: desktop, inbox: inbox, now: now)
                    }
                }
            }
            if !overview.active.isEmpty {
                Section {
                    ForEach(overview.active) { summary in
                        NavigationLink(value: ProjectRef(desktopId: desktop.id, projectId: summary.project.id)) {
                            ActiveProjectRow(summary: summary, now: now)
                        }
                        .opacity(offline ? 0.55 : 1)
                        .contextMenu { projectPinMenu(summary.project, desktop: desktop, inbox: inbox) }
                    }
                } header: {
                    Text("Active")
                } footer: {
                    Text("Projects with open tasks, the ones that need you first.")
                }
            }
            if !overview.quiet.isEmpty {
                quietSection(overview.quiet, desktop: desktop, inbox: inbox)
            }
        } else {
            Section(several ? desktop.name : "") {
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

    /// "Online · 22 projects · 2 need you", under the desktop's title.
    private func statusLine(_ desktop: DesktopRecord, inbox: Inbox, now: Date, named: Bool) -> some View {
        let state = model.state(of: desktop.id)
        let needYou = inbox.projects.flatMap(\.tasks).filter { $0.needsYou(now: now) }.count
        var parts = [state.summary(lastSeen: desktop.lastSeen)]
        parts.append(inbox.projects.count == 1 ? "1 project" : "\(inbox.projects.count) projects")
        if needYou > 0 { parts.append(needYou == 1 ? "1 needs you" : "\(needYou) need you") }
        return VStack(alignment: .leading, spacing: 2) {
            if named {
                Text(desktop.name).font(.title3.weight(.bold)).foregroundStyle(.primary)
            }
            HStack(spacing: 6) {
                Circle().fill(state.dotColor).frame(width: 8, height: 8)
                Text(parts.joined(separator: " · "))
                    .lineLimit(1)
            }
            .font(.subheadline)
            .foregroundStyle(.secondary)
        }
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder
    private func pinnedRow(_ pin: ResolvedPin, desktop: DesktopRecord, inbox: Inbox, now: Date) -> some View {
        let offline = model.isOffline(desktop.id)
        switch pin {
        case .task(let task, let project):
            taskRowActions(PinnedTaskRow(project: project, task: task, now: now), task: task, project: project, desktop: desktop, inbox: inbox)
        case .stream(let stream, let project):
            NavigationLink(value: ProjectRef(desktopId: desktop.id, projectId: project.id)) {
                PinnedPlaceRow(project: project, stream: stream, count: project.tasks(in: stream).count)
            }
            .opacity(offline ? 0.55 : 1)
            .swipeActions(edge: .leading) { unpinButton(InboxPin.stream(stream, in: project), desktop: desktop) }
            .contextMenu {
                if canPin(desktop) {
                    Button("Unpin stream", systemImage: "pin.slash") { togglePin(.stream(stream, in: project), pinned: true, desktop: desktop) }
                        .disabled(offline)
                }
            }
        case .project(let project):
            NavigationLink(value: ProjectRef(desktopId: desktop.id, projectId: project.id)) {
                PinnedPlaceRow(project: project, stream: nil, count: project.tasks.count)
            }
            .opacity(offline ? 0.55 : 1)
            .swipeActions(edge: .leading) { unpinButton(InboxPin.project(project), desktop: desktop) }
            .contextMenu { projectPinMenu(project, desktop: desktop, inbox: inbox) }
        }
    }

    /// Quiet projects (no open task), folded into one row.
    private func quietSection(_ quiet: [InboxProject], desktop: DesktopRecord, inbox: Inbox) -> some View {
        let open = showQuiet.contains(desktop.id)
        return Section {
            Button {
                withAnimation {
                    if open { showQuiet.remove(desktop.id) } else { showQuiet.insert(desktop.id) }
                }
            } label: {
                HStack(spacing: 12) {
                    VStack(alignment: .leading, spacing: 2) {
                        HStack(spacing: 6) {
                            Text("Quiet projects").foregroundStyle(.primary)
                            Text("\(quiet.count)").foregroundStyle(.secondary)
                        }
                        if !open {
                            Text(quiet.map(\.name).joined(separator: ", "))
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                        }
                    }
                    Spacer(minLength: 8)
                    Image(systemName: "chevron.right")
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(.tertiary)
                        .rotationEffect(.degrees(open ? 90 : 0))
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityValue(open ? "Expanded" : "Collapsed")
            if open {
                ForEach(quiet) { project in
                    NavigationLink(value: ProjectRef(desktopId: desktop.id, projectId: project.id)) {
                        HStack(spacing: 12) {
                            ProjectTileView(tile: project.tile, size: 30)
                            Text(project.name)
                                .lineLimit(1)
                        }
                    }
                    .opacity(model.isOffline(desktop.id) ? 0.55 : 1)
                    .contextMenu { projectPinMenu(project, desktop: desktop, inbox: inbox) }
                }
            }
        }
    }

    /// A task row's swipes and menu: pin, close.
    private func taskRowActions(_ row: some View, task: InboxTask, project: InboxProject, desktop: DesktopRecord, inbox: Inbox) -> some View {
        let offline = model.isOffline(desktop.id)
        let pin = InboxPin.task(task, in: project)
        let pinned = inbox.isPinned(pin)
        return row
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
                    Button(pinned ? "Unpin task" : "Pin task", systemImage: pinned ? "pin.slash" : "pin") {
                        togglePin(pin, pinned: pinned, desktop: desktop)
                    }
                    .disabled(offline)
                }
            }
    }

    @ViewBuilder
    private func unpinButton(_ pin: InboxPin, desktop: DesktopRecord) -> some View {
        if canPin(desktop) && !model.isOffline(desktop.id) {
            Button {
                togglePin(pin, pinned: true, desktop: desktop)
            } label: {
                Label("Unpin", systemImage: "pin.slash")
            }
            .tint(.orange)
        }
    }

    @ViewBuilder
    private func projectPinMenu(_ project: InboxProject, desktop: DesktopRecord, inbox: Inbox) -> some View {
        if canPin(desktop) {
            let pin = InboxPin.project(project)
            let pinned = inbox.isPinned(pin)
            Button(pinned ? "Unpin project" : "Pin project", systemImage: pinned ? "pin.slash" : "pin") {
                togglePin(pin, pinned: pinned, desktop: desktop)
            }
            .disabled(model.isOffline(desktop.id))
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
}

/// An Active project: tile, name, and its most urgent task's stream and need,
/// with how many tasks need you.
struct ActiveProjectRow: View {
    let summary: ProjectSummary
    let now: Date

    var body: some View {
        HStack(spacing: 12) {
            ProjectTileView(tile: summary.project.tile, size: 40)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(summary.project.name)
                        .font(.body.weight(.semibold))
                    if summary.project.remote {
                        Image(systemName: "network")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .accessibilityLabel("Remote")
                    }
                }
                .lineLimit(1)
                Text(line)
                    .font(.footnote)
                    .foregroundStyle(summary.needsYou > 0 ? AnyShapeStyle(.orange) : AnyShapeStyle(.secondary))
                    .lineLimit(1)
            }
            Spacer(minLength: 8)
            if summary.needsYou > 0 {
                Text("\(summary.needsYou)")
                    .font(.footnote.weight(.semibold))
                    .monospacedDigit()
                    .foregroundStyle(.white)
                    .padding(.horizontal, 7)
                    .frame(minWidth: 22, minHeight: 22)
                    .background(Color.orange, in: Capsule())
                    .accessibilityLabel("\(summary.needsYou) need you")
            } else if summary.unread {
                UnreadDot()
            }
        }
        .padding(.vertical, 2)
    }

    /// "0.6.0 · Allow Bash? xcodebuild test", "Stream Redesign · 2 tasks · 1 working".
    private var line: String {
        let lead = summary.lead
        let project = summary.project
        let stream = project.streams.first { $0.id == lead.streamId }
        let onMain = stream?.isMain ?? lead.streamName.isEmpty
        let label = onMain ? lead.name : (stream?.name ?? lead.streamName)
        if summary.needsYou > 0 {
            return "\(label) · \(InboxClock.activity(lead) ?? "Needs you")"
        }
        let count = project.tasks.count
        if count > 1 {
            var parts = [label, "\(count) tasks"]
            if summary.working > 0 { parts.append("\(summary.working) working") }
            return parts.joined(separator: " · ")
        }
        let state: String
        switch lead.inboxGroup(now: now) {
        case .snoozed: state = "snoozed"
        case .settled: state = "settled"
        default: state = InboxClock.activity(lead) ?? lead.status.label.lowercased()
        }
        return "\(label) · \(state)"
    }
}

/// A pinned task: tile, **project** stream, the task's name, and a dot when it
/// needs you or is unread.
struct PinnedTaskRow: View {
    let project: InboxProject
    let task: InboxTask
    let now: Date

    var body: some View {
        HStack(spacing: 12) {
            TaskTitleHeader(project: project, task: task, tileSize: 30, projectFont: .subheadline.weight(.bold))
            Spacer(minLength: 8)
            if task.needsYou(now: now) {
                Circle().fill(Color.orange).frame(width: 8, height: 8)
                    .accessibilityLabel("Needs you")
            } else if task.unread {
                UnreadDot()
            }
        }
    }
}

/// A pinned project or stream: tile, **project** › stream, its task count.
struct PinnedPlaceRow: View {
    let project: InboxProject
    let stream: InboxStream?
    let count: Int

    var body: some View {
        HStack(spacing: 12) {
            ProjectTileView(tile: project.tile, size: 30)
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(project.name).font(.subheadline.weight(.bold))
                if let stream {
                    Text("› \(stream.name)")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
            .lineLimit(1)
            Spacer(minLength: 8)
            Text(count == 1 ? "1 task" : "\(count) tasks")
                .font(.footnote)
                .foregroundStyle(.secondary)
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
