import Foundation
import Testing
@testable import DevToolKit

/// The phone's Inbox (§8.3): the desktop inbox's groups, triage applied ahead
/// of the desktop's answer (§8.11), and the Snooze presets.
@Suite struct InboxTriageTests {
    static let now = Date(unixMilliseconds: 1_790_000_000_000)
    static let nowMs = now.unixMilliseconds

    func tab(_ id: String, _ status: TabStatus, since: Int64? = nil) -> InboxTab {
        InboxTab(id: id, type: .claudeChat, title: "Claude", status: status, since: since)
    }

    func inbox(_ id: String, _ tasks: [InboxTask]) -> Inbox {
        Inbox(desktop: InboxDesktop(id: id, name: id), generatedAt: 1, projects: [InboxProject(id: "p-\(id)", name: "p", tasks: tasks)])
    }

    @Test func groupsAndOrdersAcrossDesktops() {
        let a = inbox("a", [
            InboxTask(id: "waiting-short", name: "", tabs: [tab("1", .attention, since: Self.nowMs - 1_000)]),
            InboxTask(id: "recent", name: "", eventAt: Self.nowMs - 10, tabs: []),
            InboxTask(id: "settled-old", name: "", settledAt: 100, tabs: []),
            InboxTask(id: "snoozed-attention", name: "", snoozeUntilAttention: true, tabs: [tab("2", .attention)]),
        ])
        let b = inbox("b", [
            InboxTask(id: "waiting-long", name: "", tabs: [tab("3", .working, since: 1), tab("4", .attention, since: Self.nowMs - 9_000)]),
            InboxTask(id: "older", name: "", lastInteractedAt: Self.nowMs - 500, tabs: []),
            InboxTask(id: "settled-new", name: "", settledAt: 200, tabs: []),
            InboxTask(id: "snoozed-soon", name: "", settledAt: 300, snoozedUntil: Self.nowMs + 60_000, tabs: []),
            InboxTask(id: "woke", name: "", snoozedUntil: Self.nowMs - 1, tabs: []),
        ])
        let partition = InboxPartition([("a", a), ("b", b)], now: Self.now)
        #expect(partition.needsYou.map(\.task.id) == ["waiting-long", "waiting-short"])
        #expect(partition.active.map(\.task.id) == ["recent", "older", "woke"])
        #expect(partition.settled.map(\.task.id) == ["settled-new", "settled-old"])
        // A snooze wins over a settle; "until it needs me" sorts last.
        #expect(partition.snoozed.map(\.task.id) == ["snoozed-soon", "snoozed-attention"])
        #expect(partition.needsYou.first?.desktopId == "b")
        #expect(!partition.isEmpty && InboxPartition([], now: Self.now).isEmpty)
        let unread = InboxPartition([("a", inbox("a", [
            InboxTask(id: "u", name: "", unread: true, tabs: []),
            InboxTask(id: "s", name: "", unread: true, settledAt: 1, tabs: []),
            InboxTask(id: "z", name: "", unread: true, snoozeUntilAttention: true, tabs: []),
            InboxTask(id: "r", name: "", tabs: []),
        ]))], now: Self.now)
        #expect(unread.unreadCount == 1)
    }

    @Test func appliesActionsAsTheDesktopWould() {
        let task = InboxTask(id: "t", name: "", unread: true, settledAt: 5, tabs: [])
        #expect(!task.applying(.read, now: Self.now).unread)
        #expect(task.applying(.unsettle, now: Self.now).settledAt == nil)
        let settled = InboxTask(id: "t", name: "", unread: true, snoozedUntil: 9, tabs: []).applying(.settle, now: Self.now)
        #expect(settled.settledAt == Self.nowMs && !settled.unread && settled.snoozedUntil == nil)
        let snoozed = task.applying(.snooze(until: 42), now: Self.now)
        #expect(snoozed.snoozedUntil == 42 && snoozed.settledAt == nil && !snoozed.unread)
        let untilAttention = snoozed.applying(.snoozeUntilAttention, now: Self.now)
        #expect(untilAttention.snoozeUntilAttention && untilAttention.snoozedUntil == nil)
        #expect(!untilAttention.applying(.unsnooze, now: Self.now).isSnoozed(now: Self.now))
        #expect(InboxTask(id: "t", name: "", tabs: []).applying(.unread, now: Self.now).unread)
    }

    @Test func snoozePresetsFollowTheDesktop() throws {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = try #require(TimeZone(identifier: "Europe/Bratislava"))
        func date(_ day: Int, _ hour: Int, _ minute: Int = 0) -> Date {
            calendar.date(from: DateComponents(year: 2026, month: 10, day: day, hour: hour, minute: minute))!
        }
        // Wednesday 7 Oct 2026, 14:30.
        let afternoon = SnoozePreset.presets(now: date(7, 14, 30), calendar: calendar)
        #expect(afternoon.map(\.id) == ["attention", "hour", "evening", "tomorrow", "monday"])
        #expect(afternoon[0].action == .snoozeUntilAttention && afternoon[0].wakesAt == nil)
        #expect(afternoon.map(\.wakesAt).dropFirst() == [date(7, 15, 30), date(7, 18), date(8, 9), date(12, 9)])
        #expect(afternoon[2].action == .snooze(until: date(7, 18).unixMilliseconds))
        // After 18:00 there is no "This evening"; on a Monday, Monday is a week out.
        let mondayNight = SnoozePreset.presets(now: date(12, 19), calendar: calendar)
        #expect(mondayNight.map(\.id) == ["attention", "hour", "tomorrow", "monday"])
        #expect(mondayNight.last?.wakesAt == date(19, 9))
        // Sunday: Monday is tomorrow.
        #expect(SnoozePreset.presets(now: date(11, 10), calendar: calendar).last?.wakesAt == date(12, 9))
    }
}
