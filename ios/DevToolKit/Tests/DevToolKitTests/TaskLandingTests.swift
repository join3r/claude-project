import Foundation
import Testing
@testable import DevToolKit

/// Task worktrees on the phone (protocol version 3): a task's `branch` and
/// `landing` (§4.4), `task.close`'s landing answer (§8.7) and `task.land` (§8.15).
@Suite struct TaskLandingTests {
    @Test func taskLandVectors() throws {
        let file = try Vectors.load("chat-messages.json")
        let land = try #require(file["taskLand"])
        #expect(!land["params"].array.isEmpty && !land["results"].array.isEmpty)
        for sample in land["params"].array {
            let parsed = try TaskLandParams.parse(try JSONValue.parse(sample["json"].str))
            #expect(parsed.json == sample["expected"], "\(sample["json"].str)")
        }
        for sample in land["results"].array {
            let parsed = try TaskLandResult.parse(try JSONValue.parse(sample["json"].str))
            #expect(parsed.json == sample["expected"], "\(sample["json"].str)")
        }
        for json in land["invalid"]["params"].array {
            #expect(throws: (any Error).self, "\(json.str)") { _ = try TaskLandParams.parse(try JSONValue.parse(json.str)) }
        }
        for json in land["invalid"]["results"].array {
            #expect(throws: (any Error).self, "\(json.str)") { _ = try TaskLandResult.parse(try JSONValue.parse(json.str)) }
        }
    }

    @Test func closeAnswersWithTheLanding() throws {
        let result = try TaskCloseResult.parse(try JSONValue.parse(#"{"closed":false,"landing":{"state":"conflict","intent":"close","files":["a.ts"],"fileCount":3}}"#))
        #expect(result == .landing(TaskLanding(state: .conflict, intent: .close, files: ["a.ts"], fileCount: 3)))
        guard case .landing(let landing) = result else { return }
        #expect(landing.count == 3)
        #expect(landing.needsYou)
        #expect(landing.label(streamName: "0.5.0") == "Conflicts with 0.5.0 in 3 files")
    }

    @Test func inboxTasksCarryBranchAndLanding() throws {
        let file = try Vectors.load("app-messages.json")
        let sample = try #require(file["appMessages"].array.first { $0["expected"]["result"]["desktop"] != nil })
        guard case .resOk(_, let result)? = try AppMessage.parse(Data(sample["json"].str.utf8)) else {
            Issue.record("expected an inbox.get result")
            return
        }
        let tasks = try Inbox.parse(result).projects[0].tasks
        let login = try #require(tasks.first { $0.id == "t2" })
        #expect(login.branch == "0.5.0--fix-the-login-redirect")
        #expect(login.landing == TaskLanding(state: .conflict, files: ["src/auth.ts", "src/login.ts"], fileCount: 2))
        let deps = try #require(tasks.first { $0.id == "t3" })
        #expect(deps.landing?.state == .blocked)
        #expect(deps.landing?.intent == .land)
        #expect(deps.landing?.label(streamName: "0.5.0") == "0.5.0 has local changes in 1 file")
        #expect(tasks.first { $0.id == "t1" }?.landing == nil)

        // A newer desktop's state is kept, its unknown intent dropped.
        let unknown = try Inbox.parse(try JSONValue.parse(file["inboxWithUnknownFields"]["json"].str))
        #expect(unknown.projects[0].tasks[0].landing == TaskLanding(state: .unknown("queued")))
        #expect(unknown.projects[0].tasks[0].branch == nil)
    }

    @Test func landingSurvivesTheCache() throws {
        let task = InboxTask(id: "t", name: "fix", branch: "rel--fix",
                             landing: TaskLanding(state: .blocked, intent: .land, files: ["a"], fileCount: 1, message: "local changes"), tabs: [])
        let decoded = try JSONDecoder().decode(InboxTask.self, from: try JSONEncoder().encode(task))
        #expect(decoded == task)
        // A cached landing from a newer desktop keeps its state; a broken one is dropped, not the task.
        let newer = #"{"id":"t","name":"x","tabs":[],"landing":{"state":"queued","intent":"squash"}}"#
        #expect(try JSONDecoder().decode(InboxTask.self, from: Data(newer.utf8)).landing == TaskLanding(state: .unknown("queued")))
        let broken = #"{"id":"t","name":"x","tabs":[],"landing":{"files":[]}}"#
        #expect(try JSONDecoder().decode(InboxTask.self, from: Data(broken.utf8)).landing == nil)
    }

    @Test func aStoppedLandingIsYourTurn() {
        let now = Date(unixMilliseconds: 1_790_000_000_000)
        let working = InboxTab(id: "a", type: .claudeChat, title: "Claude", status: .working)
        func task(_ state: TaskLanding.State, status: TabStatus = .working, snoozed: Bool = false) -> InboxTask {
            InboxTask(id: "t", name: "t", status: status, snoozeUntilAttention: snoozed, landing: TaskLanding(state: state), tabs: [working])
        }
        // As the desktop's `partitionInbox`: ahead of working, snooze and settle; behind attention.
        #expect(task(.conflict).inboxGroup(now: now) == .yourTurn)
        #expect(task(.blocked, snoozed: true).inboxGroup(now: now) == .yourTurn)
        #expect(task(.conflict, status: .attention).inboxGroup(now: now) == .needsYou)
        #expect(task(.fixing).inboxGroup(now: now) == .working)
        #expect(task(.landing, status: .idle).inboxGroup(now: now) == .quiet)
    }
}
