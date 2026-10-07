import Foundation

/// One row of the phone's Inbox (§8.3): a task, with the desktop and project it belongs to.
public struct InboxEntry: Sendable, Equatable, Identifiable {
    public var desktopId: String
    public var project: InboxProject
    public var task: InboxTask

    public init(desktopId: String, project: InboxProject, task: InboxTask) {
        self.desktopId = desktopId
        self.project = project
        self.task = task
    }

    public var id: String { "\(desktopId):\(task.id)" }
}

/// Which of the desktop inbox's groups a task is in. A snooze wins over a
/// settle, so an explicitly snoozed task stays hidden.
public enum InboxGroup: Sendable, Equatable {
    case needsYou
    case active
    case settled
    case snoozed
}

extension InboxTask {
    public func inboxGroup(now: Date) -> InboxGroup {
        if isSnoozed(now: now) { return .snoozed }
        if settledAt != nil { return .settled }
        if status == .attention { return .needsYou }
        return .active
    }
}

/// The desktop inbox's groups (its `partitionInbox`), over every paired desktop.
public struct InboxPartition: Sendable, Equatable {
    /// A tab needs the user; longest wait first.
    public var needsYou: [InboxEntry] = []
    /// Everything else, by last activity.
    public var active: [InboxEntry] = []
    /// Newest settle first.
    public var settled: [InboxEntry] = []
    /// Soonest wake first; "until it needs me" last.
    public var snoozed: [InboxEntry] = []

    public init() {}

    /// `workingLast` sinks tasks whose agent is working below the rest of
    /// Active, as the desktop's "Move working tasks to the end of the Inbox".
    public init(_ inboxes: [(desktopId: String, inbox: Inbox)], now: Date, workingLast: Bool = false) {
        var needsYou: [(InboxEntry, Int)] = []
        var active: [(InboxEntry, Int)] = []
        var settled: [(InboxEntry, Int)] = []
        var snoozed: [(InboxEntry, Int)] = []
        var index = 0
        for (desktopId, inbox) in inboxes {
            for project in inbox.projects {
                for task in project.tasks {
                    let entry = (InboxEntry(desktopId: desktopId, project: project, task: task), index)
                    index += 1
                    switch task.inboxGroup(now: now) {
                    case .needsYou: needsYou.append(entry)
                    case .active: active.append(entry)
                    case .settled: settled.append(entry)
                    case .snoozed: snoozed.append(entry)
                    }
                }
            }
        }
        let nowMs = now.unixMilliseconds
        // Equal keys keep the desktops' own order, as the desktop's stable sort does.
        func sorted(_ entries: [(InboxEntry, Int)], by key: (InboxTask) -> Int64, descending: Bool) -> [InboxEntry] {
            entries.sorted { a, b in
                let ka = key(a.0.task), kb = key(b.0.task)
                if ka != kb { return descending ? ka > kb : ka < kb }
                return a.1 < b.1
            }.map(\.0)
        }
        self.needsYou = sorted(needsYou, by: { $0.since ?? nowMs }, descending: false)
        self.active = sorted(active, by: \.lastActivityAt, descending: true)
        if workingLast {
            // Partitioning keeps the recency order within each half.
            let working = self.active.filter { $0.task.status == .working }
            self.active = self.active.filter { $0.task.status != .working } + working
        }
        self.settled = sorted(settled, by: { $0.settledAt ?? 0 }, descending: true)
        self.snoozed = sorted(snoozed, by: { $0.snoozeUntilAttention ? Int64.max : ($0.snoozedUntil ?? Int64.max) }, descending: false)
    }

    public var isEmpty: Bool {
        needsYou.isEmpty && active.isEmpty && settled.isEmpty && snoozed.isEmpty
    }

    /// The Inbox badge, as the desktop's: unread tasks that are neither snoozed nor settled.
    public var unreadCount: Int {
        (needsYou + active).filter(\.task.unread).count
    }
}

extension InboxTask {
    /// The task as the desktop will send it back after `action` (§8.11), for
    /// showing the change before the next inbox confirms it.
    public func applying(_ action: TaskTriageParams.Action, now: Date) -> InboxTask {
        var task = self
        switch action {
        case .read:
            task.unread = false
        case .unread:
            task.unread = true
        case .settle:
            task.settledAt = now.unixMilliseconds
            task.unread = false
            task.snoozedUntil = nil
            task.snoozeUntilAttention = false
        case .unsettle:
            task.settledAt = nil
        case .snooze(let until):
            task.snoozedUntil = until
            task.snoozeUntilAttention = false
            task.settledAt = nil
            task.unread = false
        case .snoozeUntilAttention:
            task.snoozeUntilAttention = true
            task.snoozedUntil = nil
            task.settledAt = nil
            task.unread = false
        case .unsnooze:
            task.snoozedUntil = nil
            task.snoozeUntilAttention = false
        }
        return task
    }
}

/// The desktop inbox's Snooze menu (its `snoozePresets`), in the phone's time zone.
public struct SnoozePreset: Sendable, Equatable, Identifiable {
    public var id: String
    public var label: String
    public var action: TaskTriageParams.Action
    /// When the task wakes; nil for "until it needs me".
    public var wakesAt: Date?

    public static func presets(now: Date, calendar: Calendar = .current) -> [SnoozePreset] {
        func at(dayOffset: Int, hour: Int) -> Date {
            let day = calendar.date(byAdding: .day, value: dayOffset, to: calendar.startOfDay(for: now)) ?? now
            return calendar.date(bySettingHour: hour, minute: 0, second: 0, of: day) ?? day
        }
        func preset(_ id: String, _ label: String, _ date: Date) -> SnoozePreset {
            SnoozePreset(id: id, label: label, action: .snooze(until: date.unixMilliseconds), wakesAt: date)
        }

        var presets = [
            SnoozePreset(id: "attention", label: "Until it needs me", action: .snoozeUntilAttention, wakesAt: nil),
            preset("hour", "1 hour", now.addingTimeInterval(3600)),
        ]
        let evening = at(dayOffset: 0, hour: 18)
        if evening > now { presets.append(preset("evening", "This evening", evening)) }
        presets.append(preset("tomorrow", "Tomorrow", at(dayOffset: 1, hour: 9)))
        // Next Monday; on a Monday, the one a week out.
        let weekday = calendar.component(.weekday, from: now) - 1 // Sunday = 0, as JS getDay()
        let daysToMonday = (8 - weekday) % 7 == 0 ? 7 : (8 - weekday) % 7
        presets.append(preset("monday", "Monday", at(dayOffset: daysToMonday, hour: 9)))
        return presets
    }
}
