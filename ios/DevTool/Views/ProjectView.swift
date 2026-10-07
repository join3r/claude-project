import DevToolKit
import SwiftUI

/// A project's screen (§8.3): its tile and name, then a section per stream
/// with its open tasks. The toolbar's + adds a stream; each stream's + a task in it.
struct ProjectView: View {
    @Environment(AppModel.self) private var model
    let ref: ProjectRef
    @Binding var selection: TaskRef?
    /// Debug `-demoRoute newStream|newTask`: the sheet to open on appear.
    var demoSheet: LaunchOptions.DemoRoute? = nil
    @State private var newTask: NewTaskTarget?
    @State private var newStream: NewStreamTarget?
    @State private var closing: CloseTaskRequest?
    /// A stream just made from the New stream sheet: scrolled to once the inbox has it.
    @State private var createdStream: String?

    var body: some View {
        if let inbox = model.inboxes[ref.desktopId], let project = inbox.projects.first(where: { $0.id == ref.projectId }) {
            TimelineView(.periodic(from: .now, by: 30)) { context in
                list(project, inbox: inbox, now: context.date)
            }
            .navigationTitle(project.name)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                // The header below names the project; the title only backs the next screen's back button.
                ToolbarItem(placement: .principal) { Color.clear.frame(width: 1, height: 1) }
                if model.supports(DesktopFeature.pin, on: ref.desktopId) {
                    let pin = InboxPin.project(project)
                    let pinned = inbox.isPinned(pin)
                    ToolbarItem(placement: .topBarTrailing) {
                        Button(pinned ? "Unpin project" : "Pin project", systemImage: pinned ? "pin.fill" : "pin") {
                            Task { await model.setPin(pin, pinned: !pinned, desktopId: ref.desktopId) }
                        }
                        .disabled(offline)
                    }
                }
                if model.supports(DesktopFeature.streamNew, on: ref.desktopId) {
                    ToolbarItem(placement: .topBarTrailing) {
                        Button("New stream", systemImage: "plus") {
                            newStream = NewStreamTarget(desktopId: ref.desktopId, projectId: project.id)
                        }
                        .disabled(offline)
                    }
                }
            }
            .sheet(item: $newTask) { target in
                NewTaskSheet(target: target)
            }
            .sheet(item: $newStream) { target in
                NewStreamSheet(target: target, streams: project.streams) { createdStream = $0 }
            }
            .task {
                switch demoSheet {
                case .newStream: newStream = NewStreamTarget(desktopId: ref.desktopId, projectId: project.id)
                case .newTask: newTask = NewTaskTarget(desktopId: ref.desktopId, projectId: project.id, streamId: project.streams.last?.id)
                default: break
                }
            }
            .closeTaskFlow($closing) { closed in
                if selection == TaskRef(desktopId: closed.desktopId, taskId: closed.taskId) { selection = nil }
            }
        } else {
            ContentUnavailableView("Project not found", systemImage: "questionmark.folder",
                                   description: Text("It may have been removed or hidden from mobile on the desktop."))
        }
    }

    private var offline: Bool { model.isOffline(ref.desktopId) }

    private func list(_ project: InboxProject, inbox: Inbox, now: Date) -> some View {
        ScrollViewReader { proxy in
            streamList(project, inbox: inbox, now: now)
                .onChange(of: createdStream.flatMap { id in project.streams.contains { $0.id == id } ? id : nil }) { _, id in
                    guard let id else { return }
                    withAnimation { proxy.scrollTo(Self.streamAnchor(id), anchor: .center) }
                    createdStream = nil
                }
        }
    }

    /// The scroll target of a stream's section: its "No open tasks" row
    /// (a new stream is empty).
    private static func streamAnchor(_ streamId: String) -> String { "stream-empty-\(streamId)" }

    private func streamList(_ project: InboxProject, inbox: Inbox, now: Date) -> some View {
        List(selection: $selection) {
            DesktopBanners(desktops: model.desktop(ref.desktopId).map { [$0] } ?? [])
            Section {
                header(project)
                    .listRowBackground(Color.clear)
                    .listRowInsets(EdgeInsets(top: 4, leading: 20, bottom: 4, trailing: 20))
            }
            .listSectionSpacing(.compact)
            ForEach(streams(project)) { stream in
                streamSection(stream, project: project, inbox: inbox, now: now)
            }
        }
        .listStyle(.insetGrouped)
        .refreshable { await model.refresh([ref.desktopId]) }
    }

    private func header(_ project: InboxProject) -> some View {
        HStack(spacing: 14) {
            ProjectTileView(tile: project.tile, size: 52)
            VStack(alignment: .leading, spacing: 2) {
                Text(project.name)
                    .font(.title.weight(.bold))
                    .lineLimit(2)
                Text(subtitle(project))
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isHeader)
    }

    /// The inbox carries no folder path; say where it runs and how much is open.
    private func subtitle(_ project: InboxProject) -> String {
        var parts: [String] = []
        if project.remote { parts.append("Remote") }
        if let name = model.desktop(ref.desktopId)?.name { parts.append(name) }
        let open = project.tasks.count
        parts.append(open == 0 ? "no open tasks" : open == 1 ? "1 open task" : "\(open) open tasks")
        return parts.joined(separator: " · ")
    }

    /// The project's streams in the desktop's order, plus any a task names
    /// that isn't listed (an older cached inbox).
    private func streams(_ project: InboxProject) -> [InboxStream] {
        let known = Set(project.streams.map(\.id))
        let extra = project.streamGroups.map(\.stream).filter { !known.contains($0.id) }
        return project.streams + extra
    }

    private func streamSection(_ stream: InboxStream, project: InboxProject, inbox: Inbox, now: Date) -> some View {
        let tasks = sorted(project.tasks.filter { $0.streamId == stream.id })
        return Section {
            ForEach(tasks) { task in
                taskRow(task, project: project, inbox: inbox, now: now)
            }
            if tasks.isEmpty {
                Text("No open tasks")
                    .foregroundStyle(.secondary)
                    .id(Self.streamAnchor(stream.id))
            }
        } header: {
            streamHeader(stream, project: project, inbox: inbox, status: project.status(of: stream))
        }
    }

    /// Status dot, name, `⎇ branch` or "project folder", pin mark, and + New task.
    private func streamHeader(_ stream: InboxStream, project: InboxProject, inbox: Inbox, status: TabStatus?) -> some View {
        let pin = InboxPin.stream(stream, in: project)
        let pinned = inbox.isPinned(pin)
        return HStack(spacing: 8) {
            StreamDot(status: status)
            Text(stream.name.isEmpty ? "Stream" : stream.name)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(.primary)
                .lineLimit(1)
                .layoutPriority(1)
            Group {
                if let branch = stream.branch {
                    Label(branch, systemImage: "arrow.triangle.branch")
                        .labelStyle(.titleAndIcon)
                        .font(.caption.monospaced())
                        .accessibilityLabel("Branch \(branch)")
                } else {
                    Text("project folder").font(.footnote)
                }
            }
            .foregroundStyle(.secondary)
            .lineLimit(1)
            if pinned {
                Image(systemName: "pin.fill")
                    .imageScale(.small)
                    .foregroundStyle(.orange)
                    .accessibilityLabel("Pinned")
            }
            Spacer(minLength: 0)
            if model.supports(DesktopFeature.taskNew, on: ref.desktopId) {
                Button {
                    newTask = NewTaskTarget(desktopId: ref.desktopId, projectId: project.id, streamId: stream.id)
                } label: {
                    Image(systemName: "plus")
                        .font(.body.weight(.semibold))
                        .frame(width: 36, height: 28)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.borderless)
                .disabled(offline)
                .accessibilityLabel("New task in \(stream.name)")
            }
        }
        .textCase(nil)
        .contextMenu {
            if model.supports(DesktopFeature.pin, on: ref.desktopId) {
                Button(pinned ? "Unpin stream" : "Pin stream", systemImage: pinned ? "pin.slash" : "pin") {
                    Task { await model.setPin(pin, pinned: !pinned, desktopId: ref.desktopId) }
                }
                .disabled(offline)
            }
        }
    }

    private func taskRow(_ task: InboxTask, project: InboxProject, inbox: Inbox, now: Date) -> some View {
        let pin = InboxPin.task(task, in: project)
        let pinned = inbox.isPinned(pin)
        let canPin = model.supports(DesktopFeature.pin, on: ref.desktopId)
        return ProjectTaskRow(task: task, now: now)
            .tag(TaskRef(desktopId: ref.desktopId, taskId: task.id))
            .opacity(offline ? 0.55 : 1)
            .swipeActions(edge: .leading) {
                if canPin && !offline {
                    Button {
                        Task { await model.setPin(pin, pinned: !pinned, desktopId: ref.desktopId) }
                    } label: {
                        Label(pinned ? "Unpin" : "Pin", systemImage: pinned ? "pin.slash" : "pin")
                    }
                    .tint(.orange)
                }
            }
            .swipeActions(edge: .trailing) {
                if model.supports(DesktopFeature.taskClose, on: ref.desktopId) && !offline {
                    Button {
                        closing = CloseTaskRequest(desktopId: ref.desktopId, task: task)
                    } label: {
                        Label("Close", systemImage: "xmark")
                    }
                    .tint(.red)
                }
            }
            .contextMenu {
                if canPin {
                    Button(pinned ? "Unpin task" : "Pin task", systemImage: pinned ? "pin.slash" : "pin") {
                        Task { await model.setPin(pin, pinned: !pinned, desktopId: ref.desktopId) }
                    }
                    .disabled(offline)
                }
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

/// A stream's rolled-up status: orange when a task needs you, blue while one
/// works, grey otherwise, a ring when it has no open task.
struct StreamDot: View {
    let status: TabStatus?

    var body: some View {
        Group {
            if let status {
                Circle().fill(status == .attention || status == .working ? status.color : Color.secondary.opacity(0.6))
            } else {
                Circle().strokeBorder(Color.secondary.opacity(0.6), lineWidth: 1.5)
            }
        }
        .frame(width: 8, height: 8)
        .accessibilityLabel(status?.label ?? "No open tasks")
    }
}

/// A task inside its project's screen: the stream is the section, so the
/// row is the task's name, what it needs or is doing, and its age.
struct ProjectTaskRow: View {
    let task: InboxTask
    let now: Date

    var body: some View {
        let needsYou = task.needsYou(now: now)
        HStack(spacing: 12) {
            Circle()
                .fill(needsYou ? Color.orange : task.unread ? Color.accentColor : Color.secondary.opacity(0.35))
                .frame(width: 8, height: 8)
                .accessibilityHidden(!(needsYou || task.unread))
                .accessibilityLabel(needsYou ? "Needs you" : "Unread")
            VStack(alignment: .leading, spacing: 2) {
                Text(task.name)
                    .font(.body.weight(needsYou || task.unread ? .semibold : .regular))
                    .lineLimit(1)
                Text(TaskText.line(task, now: now))
                    .font(.footnote)
                    .foregroundStyle(TaskText.color(task, now: now))
                    .lineLimit(1)
            }
            Spacer(minLength: 8)
            if task.lastActivityAt > 0 {
                Text(InboxClock.age(now.unixMilliseconds - task.lastActivityAt))
                    .font(.footnote)
                    .monospacedDigit()
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
    }
}
