import Foundation
import Testing
@testable import DevToolKit

@Suite struct ProjectOverviewTests {
    let now = Date(timeIntervalSince1970: 1_790_000_000)
    var nowMs: Int64 { now.unixMilliseconds }

    @Test func agentTabIsTheAgentElseTheFirstTab() {
        let chat = InboxTab(id: "c", type: .claudeChat, title: "Claude", status: .idle)
        let zsh = InboxTab(id: "z", type: .terminal, title: "zsh", status: .idle)
        let task = InboxTask(id: "t", name: "t", tabs: [zsh, chat])
        #expect(task.agentTab == chat)
        #expect(task.otherTabs == [zsh])

        let terminal = InboxTask(id: "u", name: "u", tabs: [zsh])
        #expect(terminal.agentTab == zsh)
        #expect(terminal.otherTabs.isEmpty)

        let empty = InboxTask(id: "e", name: "e", tabs: [])
        #expect(empty.agentTab == nil)
        #expect(empty.otherTabs.isEmpty)
    }

    @Test func activeProjectsNeedYouFirstThenByActivity() {
        func task(_ id: String, _ status: TabStatus, since: Int64? = nil, last: Int64 = 0, settled: Bool = false) -> InboxTask {
            InboxTask(id: id, name: id, status: status, since: since, lastInteractedAt: last,
                      settledAt: settled ? last : nil, tabs: [])
        }
        let inbox = Inbox(
            desktop: InboxDesktop(id: "d", name: "d"), generatedAt: nowMs,
            projects: [
                InboxProject(id: "quiet", name: "quiet", tasks: []),
                InboxProject(id: "recent", name: "recent", tasks: [task("r", .idle, last: nowMs - 1_000)]),
                InboxProject(id: "older", name: "older", tasks: [task("o", .working, last: nowMs - 60_000)]),
                InboxProject(id: "waitShort", name: "waitShort", tasks: [
                    task("w1", .idle, last: nowMs),
                    task("w2", .attention, since: nowMs - 10_000, last: nowMs - 20_000),
                ]),
                InboxProject(id: "waitLong", name: "waitLong", tasks: [task("l", .attention, since: nowMs - 90_000)]),
                InboxProject(id: "quiet2", name: "quiet2", tasks: []),
            ]
        )
        let overview = inbox.projectOverview(now: now)
        #expect(overview.active.map(\.id) == ["waitLong", "waitShort", "recent", "older"])
        #expect(overview.quiet.map(\.id) == ["quiet", "quiet2"])
        let short = overview.active[1]
        #expect(short.needsYou == 1)
        #expect(short.lead.id == "w2")
    }

    @Test func leadPrefersWorkingOverSettled() throws {
        let project = InboxProject(id: "p", name: "p", tasks: [
            InboxTask(id: "s", name: "s", status: .idle, lastInteractedAt: nowMs, settledAt: nowMs, tabs: []),
            InboxTask(id: "w", name: "w", status: .working, lastInteractedAt: nowMs - 100_000, unread: true, tabs: []),
        ])
        let summary = try #require(ProjectSummary(project, now: now))
        #expect(summary.lead.id == "w")
        #expect(summary.working == 1)
        #expect(summary.needsYou == 0)
        #expect(summary.unread)
    }

    @Test func streamStatusRollsUp() {
        let a = InboxStream(id: "a", name: "a", isMain: true)
        let b = InboxStream(id: "b", name: "b")
        let c = InboxStream(id: "c", name: "c")
        let project = InboxProject(id: "p", name: "p", streams: [a, b, c], tasks: [
            InboxTask(id: "1", name: "1", streamId: "a", status: .idle, tabs: []),
            InboxTask(id: "2", name: "2", streamId: "a", status: .working, tabs: []),
            InboxTask(id: "3", name: "3", streamId: "b", status: .attention, tabs: []),
        ])
        #expect(project.status(of: a) == .working)
        #expect(project.status(of: b) == .attention)
        #expect(project.status(of: c) == nil)
    }
}
