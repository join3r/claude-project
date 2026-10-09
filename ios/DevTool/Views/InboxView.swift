import DevToolKit
import SwiftUI

/// Every task of every paired desktop in the desktop inbox's groups (§8.3):
/// Needs you and Ready open; Working, Snoozed and Done for now folded
/// into one-line summaries. The toolbar switches to cards by project.
struct InboxView: View {
    @Environment(AppModel.self) private var model
    @Binding var selection: TaskRef?
    @State private var showWorking = false
    @State private var showSettled = false
    @State private var showSnoozed = false
    /// The row whose Snooze swipe is asking for a preset.
    @State private var snoozing: InboxEntry?
    @AppStorage(InboxSettings.groupedKey) private var grouped = false
    @State private var newTask: NewTaskTarget?
    @State private var closing: CloseTaskRequest?

    var body: some View {
        // Wait times and snooze expiry are worked out against the clock; the
        // desktop's inbox ticks every 15 s for the same reason.
        TimelineView(.periodic(from: .now, by: 15)) { context in
            list(now: context.date)
        }
        .navigationTitle("Inbox")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    withAnimation { grouped.toggle() }
                } label: {
                    Label(grouped ? "Show as list" : "Group by project",
                          systemImage: grouped ? "list.bullet" : "rectangle.stack")
                }
            }
            ToolbarItem(placement: .topBarTrailing) {
                NewTaskToolbarButton(desktopIds: model.desktops.map(\.id), newTask: $newTask)
            }
        }
        .sheet(item: $newTask) { target in
            NewTaskSheet(target: target)
        }
        .closeTaskFlow($closing) { closed in
            if selection == TaskRef(desktopId: closed.desktopId, taskId: closed.taskId) { selection = nil }
        }
        .confirmationDialog(
            snoozing.map { "Snooze “\($0.task.name)”" } ?? "",
            isPresented: Binding(get: { snoozing != nil }, set: { if !$0 { snoozing = nil } }),
            titleVisibility: .visible,
            presenting: snoozing
        ) { entry in
            ForEach(SnoozePreset.presets(now: Date())) { preset in
                Button(preset.menuTitle) { triage(preset.action, entry) }
            }
            Button("Cancel", role: .cancel) {}
        }
    }

    private func list(now: Date) -> some View {
        let partition = model.inboxPartition(now: now)
        return List(selection: $selection) {
            DesktopBanners(desktops: model.desktops)
            if partition.isEmpty {
                emptyState
            }
            if grouped {
                byProject(partition, now: now)
            } else {
                flat(partition, now: now)
            }
            folded(partition, now: now)
        }
        .listStyle(.insetGrouped)
        .listSectionSpacing(.compact)
        .refreshable {
            await model.refresh(model.desktops.map(\.id))
        }
    }

    @ViewBuilder
    private func flat(_ partition: InboxPartition, now: Date) -> some View {
        if !partition.needsYou.isEmpty {
            Section {
                ForEach(partition.needsYou) { row($0, group: .needsYou, now: now) }
            } header: {
                GroupHeader(title: "Needs you", count: partition.needsYou.count, tint: .orange)
            }
        }
        if !partition.ready.isEmpty {
            Section {
                ForEach(partition.ready) { row($0, group: $0.task.inboxGroup(now: now), now: now) }
            } header: {
                GroupHeader(title: "Ready", count: partition.ready.count, tint: .primary)
            }
        }
    }

    /// One card per project (per desktop): Needs you and Ready tasks, the stream as a label on each row.
    @ViewBuilder
    private func byProject(_ partition: InboxPartition, now: Date) -> some View {
        let groups = partition.byProject
        ForEach(Array(groups.enumerated()), id: \.element.id) { index, group in
            Section {
                ProjectCardHeader(
                    group: group,
                    desktopName: model.desktops.count > 1 ? model.desktop(group.desktopId)?.name : nil,
                    isServer: model.isServer(group.desktopId),
                    now: now
                )
                ForEach(group.entries) { entry in
                    row(entry, group: entry.task.inboxGroup(now: now), now: now, inProject: true)
                }
            } header: {
                if index == 0 {
                    Text(byProjectCaption(partition))
                        .font(.subheadline)
                        .foregroundStyle(Color(.secondaryLabel))
                        .textCase(nil)
                }
            }
        }
    }

    /// "By project · 2 need you".
    private func byProjectCaption(_ partition: InboxPartition) -> String {
        let count = partition.needsYou.count
        return count == 0 ? "By project" : "By project · \(count) need\(count == 1 ? "s" : "") you"
    }

    /// Working, Snoozed and Done for now: a row each with a one-line summary,
    /// opening in place.
    @ViewBuilder
    private func folded(_ partition: InboxPartition, now: Date) -> some View {
        if !partition.working.isEmpty || !partition.settled.isEmpty || !partition.snoozed.isEmpty {
            Section {
                if !partition.working.isEmpty {
                    FoldedGroupRow(kind: .working, entries: partition.working, expanded: $showWorking)
                    if showWorking {
                        ForEach(partition.working) { row($0, group: .working, now: now) }
                    }
                }
                if !partition.snoozed.isEmpty {
                    FoldedGroupRow(kind: .snoozed, entries: partition.snoozed, expanded: $showSnoozed)
                    if showSnoozed {
                        ForEach(partition.snoozed) { row($0, group: .snoozed, now: now) }
                    }
                }
                if !partition.settled.isEmpty {
                    FoldedGroupRow(kind: .settled, entries: partition.settled, expanded: $showSettled)
                    if showSettled {
                        ForEach(partition.settled) { row($0, group: .settled, now: now) }
                    }
                }
            }
        }
    }

    @ViewBuilder
    private var emptyState: some View {
        if model.desktops.contains(where: { model.inboxes[$0.id] == nil && !model.isOffline($0.id) }) {
            HStack(spacing: 10) {
                ProgressView()
                Text("Connecting…")
                    .foregroundStyle(.secondary)
            }
        } else {
            ContentUnavailableView("Nothing in the inbox", systemImage: "tray", description: Text("Tasks from your desktops show up here."))
                .listRowBackground(Color.clear)
        }
    }

    /// A task row: selects the task. Swipe right to mark it read or unread,
    /// left to settle or snooze it; long-press for the rest.
    private func row(_ entry: InboxEntry, group: InboxGroup, now: Date, inProject: Bool = false) -> some View {
        let ref = TaskRef(desktopId: entry.desktopId, taskId: entry.task.id)
        let offline = model.isOffline(entry.desktopId)
        let canTriage = model.supports(DesktopFeature.taskTriage, on: entry.desktopId) && !offline
        let unread = entry.task.unread
        return InboxRow(
            entry: entry,
            group: group,
            inProject: inProject,
            desktopName: !inProject && model.desktops.count > 1 ? model.desktop(entry.desktopId)?.name : nil,
            isServer: model.isServer(entry.desktopId),
            now: now
        )
        .tag(ref)
        // The agent has the ball: nothing for you to do yet, so the row recedes.
        .opacity(offline || group == .working ? 0.5 : 1)
        .swipeActions(edge: .leading) {
            if canTriage {
                Button {
                    triage(unread ? .read : .unread, entry)
                } label: {
                    Label(unread ? "Read" : "Unread", systemImage: unread ? "envelope.open" : "envelope.badge")
                }
                .tint(.blue)
            }
        }
        .swipeActions(edge: .trailing) {
            if canTriage {
                switch group {
                case .settled:
                    Button {
                        triage(.unsettle, entry)
                    } label: {
                        Label("Back to Inbox", systemImage: "arrow.uturn.backward")
                    }
                    .tint(.gray)
                    snoozeButton(entry)
                case .snoozed:
                    Button {
                        triage(.unsnooze, entry)
                    } label: {
                        Label("Unsnooze", systemImage: "bell")
                    }
                    .tint(.indigo)
                    settleButton(entry)
                case .needsYou, .yourTurn, .working, .quiet:
                    settleButton(entry)
                    snoozeButton(entry)
                }
            }
        }
        .contextMenu {
            if model.supports(DesktopFeature.taskTriage, on: entry.desktopId) {
                TriageMenuItems(ref: ref, task: entry.task, now: now)
                    .disabled(offline)
            }
            if model.supports(DesktopFeature.taskClose, on: entry.desktopId) {
                Button(role: .destructive) {
                    closing = CloseTaskRequest(desktopId: entry.desktopId, task: entry.task)
                } label: {
                    Label("Close task", systemImage: "xmark.circle")
                }
                .disabled(offline)
            }
            if model.supports(DesktopFeature.pin, on: entry.desktopId) {
                let pin = InboxPin.task(entry.task, in: entry.project)
                let pinned = model.inboxes[entry.desktopId]?.isPinned(pin) ?? false
                Button {
                    Task { await model.setPin(pin, pinned: !pinned, desktopId: entry.desktopId) }
                } label: {
                    Label(pinned ? "Unpin task" : "Pin task", systemImage: pinned ? "pin.slash" : "pin")
                }
                .disabled(offline)
            }
        }
    }

    private func settleButton(_ entry: InboxEntry) -> some View {
        Button {
            triage(.settle, entry)
        } label: {
            Label("Done for now", systemImage: "checkmark")
        }
        .tint(.green)
    }

    private func snoozeButton(_ entry: InboxEntry) -> some View {
        Button {
            snoozing = entry
        } label: {
            Label("Snooze", systemImage: "moon.zzz")
        }
        .tint(.indigo)
    }

    private func triage(_ action: TaskTriageParams.Action, _ entry: InboxEntry) {
        let ref = TaskRef(desktopId: entry.desktopId, taskId: entry.task.id)
        Task { await model.triage(action, task: ref) }
    }
}

/// The inbox actions for one task (§8.11), for a context menu or a toolbar menu.
struct TriageMenuItems: View {
    @Environment(AppModel.self) private var model
    let ref: TaskRef
    let task: InboxTask
    let now: Date

    var body: some View {
        let group = task.inboxGroup(now: now)
        Button(task.unread ? "Mark as read" : "Mark as unread", systemImage: task.unread ? "envelope.open" : "envelope.badge") {
            run(task.unread ? .read : .unread)
        }
        if group == .settled {
            Button("Back to Inbox", systemImage: "arrow.uturn.backward") { run(.unsettle) }
        } else {
            Button("Done for now", systemImage: "checkmark") { run(.settle) }
        }
        if group == .snoozed {
            Button("Unsnooze", systemImage: "bell") { run(.unsnooze) }
        }
        Menu {
            ForEach(SnoozePreset.presets(now: now)) { preset in
                Button(preset.menuTitle) { run(preset.action) }
            }
        } label: {
            Label("Snooze", systemImage: "moon.zzz")
        }
    }

    private func run(_ action: TaskTriageParams.Action) {
        Task { await model.triage(action, task: ref) }
    }
}

/// An Inbox task, project first (Design › Rules): tile, **project** stream
/// (left out on `main`), age; the task's name; what it needs. In a project's
/// card (`inProject`) the tile and project go and the stream is a label.
struct InboxRow: View {
    let entry: InboxEntry
    let group: InboxGroup
    var inProject = false
    /// Set when more than one desktop is paired.
    let desktopName: String?
    /// The desktop is a DevTool server: its rack goes by `desktopName`.
    var isServer = false
    let now: Date

    var body: some View {
        Group {
            if inProject {
                projectCardRow
            } else {
                flatRow
            }
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
    }

    private var flatRow: some View {
        HStack(alignment: .top, spacing: 12) {
            ProjectTileView(tile: entry.project.tile, size: 36)
            VStack(alignment: .leading, spacing: 2) {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    dot
                    Text(entry.project.name)
                        .font(.body.weight(.bold))
                        .layoutPriority(1)
                    if let place = streamAndDesktop {
                        Text(place)
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                        if isServer && desktopName != nil { ServerGlyph() }
                    }
                    Spacer(minLength: 4)
                    ageText
                }
                .lineLimit(1)
                Text(entry.task.name)
                    .font(.subheadline)
                    .lineLimit(1)
                needLine
            }
        }
        .alignmentGuide(.listRowSeparatorLeading) { d in d[.leading] + 48 }
    }

    private var projectCardRow: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                dot
                if let stream = streamName {
                    Text(stream)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 1)
                        .background(Color(.tertiarySystemFill), in: RoundedRectangle(cornerRadius: 5, style: .continuous))
                } else {
                    taskName
                }
                Spacer(minLength: 4)
                ageText
            }
            .lineLimit(1)
            if streamName != nil { taskName }
            needLine
        }
    }

    private var taskName: some View {
        Text(entry.task.name)
            .font(.body.weight(entry.task.unread ? .semibold : .regular))
            .lineLimit(1)
    }

    @ViewBuilder
    private var ageText: some View {
        if let age {
            Text(age)
                .font(.footnote)
                .monospacedDigit()
                .foregroundStyle(.secondary)
        }
    }

    private var needLine: some View {
        HStack(spacing: 4) {
            if group != .snoozed, entry.task.status != .attention, let landing = entry.task.landing {
                LandingGlyph(landing: landing)
            }
            Text(need)
        }
        .font(.subheadline)
        .foregroundStyle(group == .needsYou || entry.task.landing?.needsYou == true ? AnyShapeStyle(.orange) : AnyShapeStyle(.secondary))
        .lineLimit(1)
    }

    /// Unread wins; a read task you owe a reply gets a ring, so Your turn
    /// stands out inside Ready. A working task drops its dot, as on the
    /// desktop: the agent has the ball.
    @ViewBuilder
    private var dot: some View {
        if entry.task.unread && group != .working {
            UnreadDot().alignmentGuide(.firstTextBaseline) { $0[.bottom] }
        } else if group == .yourTurn {
            YourTurnDot().alignmentGuide(.firstTextBaseline) { $0[.bottom] }
        }
    }

    /// How long it has waited when it needs you, else since anything happened.
    private var age: String? {
        let task = entry.task
        let at = (group == .needsYou ? task.since : nil) ?? task.lastActivityAt
        return at > 0 ? InboxClock.age(now.unixMilliseconds - at) : nil
    }

    private var need: String {
        group == .snoozed ? InboxClock.snoozed(entry.task, now: now) : TaskText.line(entry.task, now: now)
    }

    /// The stream, unless it is `main`.
    private var streamName: String? {
        let task = entry.task
        let stream = entry.project.streams.first { $0.id == task.streamId }
        if stream?.isMain == true { return nil }
        let name = stream?.name ?? task.streamName
        return name.isEmpty ? nil : name
    }

    private var streamAndDesktop: String? {
        let parts = [streamName, desktopName].compactMap { $0 }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }
}

/// A project card's header in the grouped Inbox: tile, name, and a dot when
/// a task needs you (orange) or is unread (blue).
struct ProjectCardHeader: View {
    let group: InboxProjectGroup
    let desktopName: String?
    /// The desktop is a DevTool server: its rack goes by `desktopName`.
    var isServer = false
    let now: Date

    var body: some View {
        HStack(spacing: 10) {
            ProjectTileView(tile: group.project.tile, size: 28)
            Text(group.project.name)
                .font(.headline)
                .lineLimit(1)
            if let desktopName {
                Text(desktopName)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                if isServer { ServerGlyph() }
            }
            Spacer(minLength: 0)
            if let dot {
                Circle().fill(dot).frame(width: 8, height: 8)
            }
        }
        .listRowBackground(Color(.secondarySystemGroupedBackground).opacity(0.6))
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isHeader)
    }

    private var dot: Color? {
        if group.entries.contains(where: { $0.task.inboxGroup(now: now) == .needsYou }) { return .orange }
        if group.entries.contains(where: \.task.unread) { return .accentColor }
        return nil
    }
}

/// Working, Snoozed or Done for now folded to one row: its name, count and a
/// one-line summary ("claude-project · DevTool Streams Redesign, …"). Tap to
/// open the group in place.
struct FoldedGroupRow: View {
    enum Kind {
        case working, settled, snoozed

        var title: String {
            switch self {
            case .working: "Working"
            case .settled: "Done for now"
            case .snoozed: "Snoozed"
            }
        }
    }

    let kind: Kind
    let entries: [InboxEntry]
    @Binding var expanded: Bool

    var body: some View {
        Button {
            withAnimation { expanded.toggle() }
        } label: {
            HStack(spacing: 10) {
                icon
                    .frame(width: 14)
                if kind == .working {
                    VStack(alignment: .leading, spacing: 1) {
                        titleLine
                        Text(InboxPartition.summary(entries))
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                } else {
                    (Text(kind.title) + Text("  \(entries.count) · \(InboxPartition.summary(entries))").foregroundStyle(.secondary))
                        .lineLimit(1)
                }
                Spacer(minLength: 0)
                Image(systemName: "chevron.right")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(.tertiary)
                    .rotationEffect(.degrees(expanded ? 90 : 0))
            }
            .frame(minHeight: kind == .working ? 44 : 32)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(kind.title), \(entries.count)")
        .accessibilityValue(expanded ? "Expanded" : "Collapsed")
    }

    private var titleLine: some View {
        Text(kind.title) + Text("  \(entries.count)").foregroundStyle(.secondary)
    }

    @ViewBuilder
    private var icon: some View {
        switch kind {
        case .working:
            Circle().fill(Color.accentColor.opacity(0.6)).frame(width: 8, height: 8)
        case .settled:
            Image(systemName: "checkmark").font(.footnote.weight(.semibold)).foregroundStyle(.secondary)
        case .snoozed:
            Image(systemName: "moon.zzz").font(.footnote).foregroundStyle(.secondary)
        }
    }
}

/// Phone-only Inbox preferences (the phone merges several desktops, so it
/// does not follow any one desktop's setting).
enum InboxSettings {
    /// Cards by project instead of the flat groups.
    static let groupedKey = "inboxGroupedByProject"

    /// "Move working tasks to the end": Working is its own folded group now.
    static func dropRetiredKeys() {
        UserDefaults.standard.removeObject(forKey: "inboxWorkingLast")
    }
}

/// The blue dot of an unread task.
struct UnreadDot: View {
    var body: some View {
        Circle()
            .fill(Color.accentColor)
            .frame(width: 8, height: 8)
            .accessibilityLabel("Unread")
    }
}

/// The ring of a read task still waiting on your reply: Your turn inside Ready.
struct YourTurnDot: View {
    var body: some View {
        Circle()
            .strokeBorder(Color.accentColor, lineWidth: 1.5)
            .frame(width: 8, height: 8)
            .accessibilityLabel("Your turn")
    }
}

/// A group's section header with its count.
struct GroupHeader: View {
    let title: String
    let count: Int
    var tint: Color?

    var body: some View {
        HStack(spacing: 6) {
            Text(title)
                .foregroundStyle(tint.map { AnyShapeStyle($0) } ?? AnyShapeStyle(.secondary))
            Text("\(count)")
                .foregroundStyle(.secondary)
            Spacer()
        }
        .font(.subheadline.weight(.semibold))
        .foregroundStyle(.secondary)
        .accessibilityElement(children: .combine)
    }
}

extension SnoozePreset {
    /// "Tomorrow · 09:00": the clock wherever the label doesn't already say when.
    var menuTitle: String {
        guard let wakesAt, id != "hour" else { return label }
        return "\(label) · \(wakesAt.formatted(date: .omitted, time: .shortened))"
    }
}

/// The desktop inbox's clock text (`formatWaitTime`).
enum InboxClock {
    /// "45s", "4m", "2h", "3d".
    static func wait(_ ms: Int64) -> String {
        let seconds = max(0, ms / 1000)
        if seconds < 60 { return "\(seconds)s" }
        let minutes = seconds / 60
        if minutes < 60 { return "\(minutes)m" }
        let hours = minutes / 60
        if hours < 24 { return "\(hours)h" }
        return "\(hours / 24)d"
    }

    /// The right-hand age of a row: "now" under a minute.
    static func age(_ ms: Int64) -> String {
        ms < 60_000 ? "now" : wait(ms)
    }

    /// A snoozed row's line: when it wakes.
    static func snoozed(_ task: InboxTask, now: Date) -> String {
        if task.snoozeUntilAttention { return "Snoozed until it needs you" }
        if let until = task.snoozedUntil { return "Snoozed for \(wait(until - now.unixMilliseconds))" }
        return "Snoozed"
    }

    /// What the task is doing: the desktop picks it from the tab that sets the
    /// task's status, so an extra terminal's activity never stands for the task.
    static func activity(_ task: InboxTask) -> String? {
        guard let activity = task.activity, !activity.isEmpty else { return nil }
        return activity
    }
}
