import Foundation

extension TabType {
    /// An agent tab: the one a task is about. A task has at most one (§9).
    public var isAgent: Bool {
        switch self {
        case .claudeChat, .claude, .codex, .pi: true
        case .terminal, .unknown: false
        }
    }
}

extension InboxTask {
    /// The tab the task is about: its agent, else (a terminal task) its first tab.
    public var agentTab: InboxTab? {
        tabs.first(where: \.type.isAgent) ?? tabs.first
    }

    /// Terminals and the like beside the agent ("Also open in this task").
    public var otherTabs: [InboxTab] {
        guard let agent = agentTab else { return tabs }
        return tabs.filter { $0.id != agent.id }
    }

    /// Needs the user now: attention, and not snoozed or settled away.
    public func needsYou(now: Date) -> Bool {
        inboxGroup(now: now) == .needsYou
    }
}

/// One project on the phone's desktop screen: how many of its tasks need you,
/// and the task whose stream and need its row shows.
public struct ProjectSummary: Sendable, Equatable, Identifiable {
    public var project: InboxProject
    /// Tasks in the Needs you group.
    public var needsYou: Int
    /// Tasks whose agent is working.
    public var working: Int
    /// Any task unread (and not snoozed or settled).
    public var unread: Bool
    /// The most urgent task: the longest waiting one that needs you, else
    /// one that is working, else the most recently active.
    public var lead: InboxTask

    public var id: String { project.id }

    public init?(_ project: InboxProject, now: Date) {
        let ranked = project.tasks.sorted { a, b in
            let ra = Self.rank(a, now: now), rb = Self.rank(b, now: now)
            if ra != rb { return ra < rb }
            if ra == 0 { return (a.since ?? .max) < (b.since ?? .max) }
            return a.lastActivityAt > b.lastActivityAt
        }
        guard let lead = ranked.first else { return nil }
        self.project = project
        self.lead = lead
        needsYou = project.tasks.filter { $0.needsYou(now: now) }.count
        working = project.tasks.filter { $0.status == .working }.count
        unread = project.tasks.contains { task in
            task.unread && task.inboxGroup(now: now).isOpen
        }
    }

    /// 0 needs you, 1 working, 2 the rest, 3 settled, 4 snoozed.
    static func rank(_ task: InboxTask, now: Date) -> Int {
        switch task.inboxGroup(now: now) {
        case .needsYou: 0
        case .working: 1
        case .yourTurn, .quiet: 2
        case .settled: 3
        case .snoozed: 4
        }
    }

    /// Last time anything happened in any of the project's tasks.
    public var lastActivityAt: Int64 {
        project.tasks.map(\.lastActivityAt).max() ?? 0
    }
}

extension Inbox {
    /// The desktop screen's split (§8.3): Active projects (with open tasks),
    /// the ones that need you first (longest wait first), then by last
    /// activity; and Quiet projects (no open task), in the desktop's order.
    public func projectOverview(now: Date) -> (active: [ProjectSummary], quiet: [InboxProject]) {
        let active = projects.compactMap { ProjectSummary($0, now: now) }
            .enumerated()
            .sorted { a, b in
                let x = a.element, y = b.element
                if (x.needsYou > 0) != (y.needsYou > 0) { return x.needsYou > 0 }
                if x.needsYou > 0 {
                    let wx = x.lead.since ?? .max, wy = y.lead.since ?? .max
                    if wx != wy { return wx < wy }
                } else if x.lastActivityAt != y.lastActivityAt {
                    return x.lastActivityAt > y.lastActivityAt
                }
                return a.offset < b.offset
            }
            .map(\.element)
        return (active, projects.filter { $0.tasks.isEmpty })
    }
}

extension InboxProject {
    /// A stream's rolled-up status: the strongest of its tasks' (attention >
    /// working > exited > idle); nil when it has no open task.
    public func status(of stream: InboxStream) -> TabStatus? {
        tasks(in: stream).map(\.status).max { $0.priority < $1.priority }
    }
}
