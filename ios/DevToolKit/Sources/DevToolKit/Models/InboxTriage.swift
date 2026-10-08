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

/// Which of the desktop inbox's groups a task is in (its `partitionInbox`).
/// A snooze wins over a settle, and both win over the live split, so a task
/// put away stays put away while its agent runs.
public enum InboxGroup: Sendable, Equatable, CaseIterable {
    /// Blocked on you: a question, a permission prompt, a terminal bell.
    case needsYou
    /// The agent finished and you haven't answered.
    case yourTurn
    /// The agent is running: nothing for you to do yet.
    case working
    /// Nothing pending either way: you had the last word, or nothing has happened yet.
    case quiet
    case settled
    case snoozed

    /// Still in the inbox: neither settled nor snoozed.
    public var isOpen: Bool {
        switch self {
        case .needsYou, .yourTurn, .working, .quiet: true
        case .settled, .snoozed: false
        }
    }
}

extension InboxTask {
    /// Waiting on you rather than the agent (the desktop's `isYourTurn`): it
    /// needs you, or its last event came after your last word.
    public var isYourTurn: Bool {
        if status == .working { return false }
        if status == .attention { return true }
        guard let eventAt else { return false }
        return eventAt > (lastInteractedAt ?? 0)
    }

    /// A live agent wins over snooze and settle, as on the desktop.
    public func inboxGroup(now: Date) -> InboxGroup {
        if status == .attention { return .needsYou }
        if status == .working { return .working }
        if isSnoozed(now: now) { return .snoozed }
        if settledAt != nil { return .settled }
        return isYourTurn ? .yourTurn : .quiet
    }
}

/// The desktop inbox's groups (its `partitionInbox`), over every paired desktop.
public struct InboxPartition: Sendable, Equatable {
    /// Longest wait first.
    public var needsYou: [InboxEntry] = []
    /// Most recent activity first.
    public var yourTurn: [InboxEntry] = []
    /// Most recent activity first; shown folded.
    public var working: [InboxEntry] = []
    /// Most recent activity first.
    public var quiet: [InboxEntry] = []
    /// Newest settle first.
    public var settled: [InboxEntry] = []
    /// Soonest wake first; "until it needs me" last.
    public var snoozed: [InboxEntry] = []

    public init() {}

    public init(_ inboxes: [(desktopId: String, inbox: Inbox)], now: Date) {
        var groups: [InboxGroup: [(InboxEntry, Int)]] = [:]
        var index = 0
        for (desktopId, inbox) in inboxes {
            for project in inbox.projects {
                for task in project.tasks {
                    groups[task.inboxGroup(now: now), default: []]
                        .append((InboxEntry(desktopId: desktopId, project: project, task: task), index))
                    index += 1
                }
            }
        }
        let nowMs = now.unixMilliseconds
        // Equal keys keep the desktops' own order, as the desktop's stable sort does.
        func sorted(_ group: InboxGroup, by key: (InboxTask) -> Int64, descending: Bool) -> [InboxEntry] {
            (groups[group] ?? []).sorted { a, b in
                let ka = key(a.0.task), kb = key(b.0.task)
                if ka != kb { return descending ? ka > kb : ka < kb }
                return a.1 < b.1
            }.map(\.0)
        }
        needsYou = sorted(.needsYou, by: { $0.since ?? nowMs }, descending: false)
        yourTurn = sorted(.yourTurn, by: \.lastActivityAt, descending: true)
        working = sorted(.working, by: \.lastActivityAt, descending: true)
        quiet = sorted(.quiet, by: \.lastActivityAt, descending: true)
        settled = sorted(.settled, by: { $0.settledAt ?? 0 }, descending: true)
        snoozed = sorted(.snoozed, by: { $0.snoozeUntilAttention ? Int64.max : ($0.snoozedUntil ?? Int64.max) }, descending: false)
    }

    public var isEmpty: Bool {
        needsYou.isEmpty && yourTurn.isEmpty && working.isEmpty && quiet.isEmpty && settled.isEmpty && snoozed.isEmpty
    }

    /// The Inbox badge, as the desktop's: unread tasks that are neither snoozed nor settled.
    public var unreadCount: Int {
        (needsYou + yourTurn + working + quiet).filter(\.task.unread).count
    }

    /// The open, unfolded groups gathered by project for the grouped layout
    /// (the desktop's `groupInboxByProject`): Needs you, Your turn and Quiet.
    /// A project sits where its most urgent task sits in the flat list and
    /// keeps that order inside. Working, Snoozed and Done for now stay folded rows.
    public var byProject: [InboxProjectGroup] {
        InboxProjectGroup.group(needsYou + yourTurn + quiet)
    }

    /// The one-line summary of a folded group: "claude-project · DevTool
    /// Streams Redesign, thumb · IOS application" (project · task, the
    /// group's order).
    public static func summary(_ entries: [InboxEntry]) -> String {
        entries.map { "\($0.project.name) · \($0.task.name)" }.joined(separator: ", ")
    }
}

/// One project's card in the grouped Inbox.
public struct InboxProjectGroup: Sendable, Equatable, Identifiable {
    public var desktopId: String
    public var project: InboxProject
    public var entries: [InboxEntry]

    public var id: String { "\(desktopId):\(project.id)" }

    public init(desktopId: String, project: InboxProject, entries: [InboxEntry]) {
        self.desktopId = desktopId
        self.project = project
        self.entries = entries
    }

    /// `entries` by project (per desktop), in order of first appearance.
    public static func group(_ entries: [InboxEntry]) -> [InboxProjectGroup] {
        var groups: [InboxProjectGroup] = []
        var index: [String: Int] = [:]
        for entry in entries {
            let key = "\(entry.desktopId):\(entry.project.id)"
            if let i = index[key] {
                groups[i].entries.append(entry)
            } else {
                index[key] = groups.count
                groups.append(InboxProjectGroup(desktopId: entry.desktopId, project: entry.project, entries: [entry]))
            }
        }
        return groups
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
