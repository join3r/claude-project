import DevToolKit
import SwiftUI

/// Every task of every paired desktop in the desktop inbox's groups (§8.3):
/// Needs you, the rest by last activity, then Settled and Snoozed, collapsed.
struct InboxView: View {
    @Environment(AppModel.self) private var model
    @Binding var selection: TaskRef?
    @State private var showSettled = false
    @State private var showSnoozed = false
    /// The row whose Snooze swipe is asking for a preset.
    @State private var snoozing: InboxEntry?

    var body: some View {
        // Wait times and snooze expiry are worked out against the clock; the
        // desktop's inbox ticks every 15 s for the same reason.
        TimelineView(.periodic(from: .now, by: 15)) { context in
            list(now: context.date)
        }
        .navigationTitle("Inbox")
        .navigationBarTitleDisplayMode(.inline)
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
            if !partition.needsYou.isEmpty {
                Section {
                    ForEach(partition.needsYou) { row($0, group: .needsYou, now: now) }
                } header: {
                    GroupHeader(title: "Needs you", count: partition.needsYou.count)
                }
            }
            if !partition.active.isEmpty {
                Section {
                    ForEach(partition.active) { row($0, group: .active, now: now) }
                }
            }
            if !partition.settled.isEmpty {
                Section {
                    if showSettled {
                        ForEach(partition.settled) { row($0, group: .settled, now: now) }
                    }
                } header: {
                    GroupHeader(title: "Settled", count: partition.settled.count, expanded: $showSettled)
                }
            }
            if !partition.snoozed.isEmpty {
                Section {
                    if showSnoozed {
                        ForEach(partition.snoozed) { row($0, group: .snoozed, now: now) }
                    }
                } header: {
                    GroupHeader(title: "Snoozed", count: partition.snoozed.count, expanded: $showSnoozed)
                } footer: {
                    if !showSnoozed {
                        Text(partition.snoozed.count == 1 ? "1 task hidden until it wakes" : "\(partition.snoozed.count) tasks hidden until they wake")
                    }
                }
            }
        }
        .listStyle(.insetGrouped)
        .refreshable {
            await model.refresh(model.desktops.map(\.id))
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
    private func row(_ entry: InboxEntry, group: InboxGroup, now: Date) -> some View {
        let ref = TaskRef(desktopId: entry.desktopId, taskId: entry.task.id)
        let offline = model.isOffline(entry.desktopId)
        let canTriage = model.supports(DesktopFeature.taskTriage, on: entry.desktopId) && !offline
        let unread = entry.task.unread
        return InboxRow(
            entry: entry,
            group: group,
            desktopName: model.desktops.count > 1 ? model.desktop(entry.desktopId)?.name : nil,
            now: now
        )
        .tag(ref)
        .opacity(offline ? 0.55 : 1)
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
                        Label("Unsettle", systemImage: "arrow.uturn.backward")
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
                case .needsYou, .active:
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
            if model.supports(DesktopFeature.pin, on: entry.desktopId) {
                let pinned = model.inboxes[entry.desktopId]?.isPinned(projectId: entry.project.id, taskId: entry.task.id) ?? false
                Button {
                    Task { await model.setPin(InboxPin(projectId: entry.project.id, taskId: entry.task.id), pinned: !pinned, desktopId: entry.desktopId) }
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
            Label("Settle", systemImage: "checkmark")
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
            Button("Unsettle", systemImage: "arrow.uturn.backward") { run(.unsettle) }
        } else {
            Button("Settle", systemImage: "checkmark") { run(.settle) }
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

struct InboxRow: View {
    let entry: InboxEntry
    let group: InboxGroup
    /// Set when more than one desktop is paired.
    let desktopName: String?
    let now: Date

    var body: some View {
        let task = entry.task
        let status = task.summaryStatus
        let activity = task.lastActivityAt
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            UnreadDot()
                .opacity(task.unread ? 1 : 0)
                .accessibilityHidden(!task.unread)
            VStack(alignment: .leading, spacing: 3) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(task.name)
                        .font(.body.weight(task.unread ? .semibold : .regular))
                        .lineLimit(1)
                    Spacer(minLength: 0)
                    if activity > 0 {
                        Text(InboxClock.age(now.unixMilliseconds - activity))
                            .font(.caption)
                            .monospacedDigit()
                            .foregroundStyle(.secondary)
                    }
                }
                Text(place)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                HStack(spacing: 4) {
                    if group != .snoozed, status == .attention || status == .working {
                        Image(systemName: status.symbol)
                            .foregroundStyle(status.color)
                    }
                    Text(InboxClock.subtitle(task, group: group, now: now))
                        .foregroundStyle(status == .attention && group == .needsYou ? AnyShapeStyle(.orange) : AnyShapeStyle(.secondary))
                        .lineLimit(1)
                }
                .font(.caption)
            }
        }
        .padding(.vertical, 2)
        .alignmentGuide(.listRowSeparatorLeading) { d in d[.leading] }
        .accessibilityElement(children: .combine)
    }

    /// "🚀 api-server · join3r-mbp", the desktop only when several are paired.
    private var place: String {
        var parts: [String] = []
        if let emoji = entry.project.emoji, !emoji.isEmpty {
            parts.append("\(emoji) \(entry.project.name)")
        } else {
            parts.append(entry.project.name)
        }
        if let branch = entry.task.branch { parts.append(branch) }
        if let desktopName { parts.append(desktopName) }
        return parts.joined(separator: " · ")
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

/// A group's section header with its count. With `expanded` it opens and
/// closes the section, as the desktop's Settled and Snoozed groups do.
struct GroupHeader: View {
    let title: String
    let count: Int
    var expanded: Binding<Bool>?

    var body: some View {
        if let expanded {
            Button {
                withAnimation { expanded.wrappedValue.toggle() }
            } label: {
                label(chevron: expanded.wrappedValue)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("\(title), \(count)")
            .accessibilityValue(expanded.wrappedValue ? "Expanded" : "Collapsed")
        } else {
            label(chevron: nil)
                .accessibilityElement(children: .combine)
        }
    }

    private func label(chevron open: Bool?) -> some View {
        HStack(spacing: 6) {
            if let open {
                Image(systemName: "chevron.right")
                    .imageScale(.small)
                    .rotationEffect(.degrees(open ? 90 : 0))
            }
            Text(title)
            Text("\(count)")
                .foregroundStyle(.tertiary)
            Spacer()
        }
        .font(.subheadline.weight(.semibold))
        .foregroundStyle(.secondary)
    }
}

extension SnoozePreset {
    /// "Tomorrow · 09:00": the clock wherever the label doesn't already say when.
    var menuTitle: String {
        guard let wakesAt, id != "hour" else { return label }
        return "\(label) · \(wakesAt.formatted(date: .omitted, time: .shortened))"
    }
}

/// The desktop inbox's row text (`rowSubtitle`, `formatWaitTime`).
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

    /// What the task is doing or asking, how long it has waited, or when it wakes.
    static func subtitle(_ task: InboxTask, group: InboxGroup, now: Date) -> String {
        let nowMs = now.unixMilliseconds
        if group == .snoozed {
            if task.snoozeUntilAttention { return "Snoozed until it needs you" }
            if let until = task.snoozedUntil { return "Snoozed for \(wait(until - nowMs))" }
            return "Snoozed"
        }
        let status = task.summaryStatus
        let line = activity(task)
        switch status {
        case .attention:
            let label = line ?? "Needs you"
            return task.statusSince.map { "\(label) · waiting \(wait(nowMs - $0))" } ?? label
        case .working:
            let label = line ?? "Working"
            return task.statusSince.map { "\(label) · \(wait(nowMs - $0))" } ?? label
        case .exited:
            return "Exited"
        default:
            if let line { return line }
            let last = task.lastActivityAt
            guard last > 0 else { return "No activity yet" }
            return nowMs - last < 60_000 ? "Last activity just now" : "Last activity \(wait(nowMs - last)) ago"
        }
    }

    /// The activity of the tab you would act on: the one that needs you, else
    /// the one working, else any.
    private static func activity(_ task: InboxTask) -> String? {
        task.tabs
            .filter { !($0.activity ?? "").isEmpty }
            .max { $0.status.priority < $1.status.priority }?
            .activity
    }
}
