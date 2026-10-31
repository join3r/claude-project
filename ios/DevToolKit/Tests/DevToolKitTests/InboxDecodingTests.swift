import Foundation
import Testing
@testable import DevToolKit

@Suite struct InboxDecodingTests {
    func decode(_ json: String) throws -> Inbox {
        try JSONDecoder().decode(Inbox.self, from: Data(json.utf8))
    }

    static let limitsJSON = """
    {
      "desktop": { "id": "d1", "name": "mbp" }, "generatedAt": 1, "projects": [],
      "limits": [
        { "account": "me@personal.dev", "plan": "max",
          "fiveHour": { "used": 42, "resetsAt": 1793412000000 }, "sevenDay": { "used": 61, "resetsAt": 1793700000000 } },
        { "account": "ops@company.dev", "sevenDay": { "used": 34 } },
        { "account": "", "plan": "pro" },
        { "plan": "pro" },
        { "account": "bad@x.dev", "fiveHour": { "used": "lots" } },
        "junk"
      ]
    }
    """

    /// §4.4 `limits`: order kept, a malformed account dropped, both decoders alike.
    @Test func decodesPlanLimits() throws {
        let expected = [
            InboxPlanLimit(account: "me@personal.dev", plan: "max",
                           fiveHour: ChatLimitWindow(used: 42, resetsAt: 1_793_412_000_000),
                           sevenDay: ChatLimitWindow(used: 61, resetsAt: 1_793_700_000_000)),
            InboxPlanLimit(account: "ops@company.dev", sevenDay: ChatLimitWindow(used: 34)),
        ]
        #expect(try decode(Self.limitsJSON).limits == expected)
        let wire = try Inbox.parse(try JSONValue.parse(Self.limitsJSON))
        #expect(wire.limits == expected)
        #expect(try Inbox.parse(wire.json).limits == expected)

        let none = #"{ "desktop": { "id": "d", "name": "n" }, "generatedAt": 1, "projects": [] }"#
        #expect(try decode(none).limits == nil)
        #expect(try Inbox.parse(try JSONValue.parse(none)).limits == nil)
        let notArray = #"{ "desktop": { "id": "d", "name": "n" }, "generatedAt": 1, "projects": [], "limits": 5 }"#
        #expect(try decode(notArray).limits == nil)
        #expect(try Inbox.parse(try JSONValue.parse(notArray)).limits == nil)
    }

    @Test func planLimitNamesAndResets() {
        let a = InboxPlanLimit(account: "me@personal.dev"), b = InboxPlanLimit(account: "ops@company.dev")
        let c = InboxPlanLimit(account: "me@company.dev")
        #expect(a.shortName(among: [a, b]) == "me")
        #expect(a.shortName(among: [a, b, c]) == "me@personal.dev")
        #expect(b.shortName(among: [a, b, c]) == "ops")

        let now = Date(unixMilliseconds: 1_000_000)
        let past = ChatLimitWindow(used: 80, resetsAt: 999_000), future = ChatLimitWindow(used: 80, resetsAt: 2_000_000)
        #expect(past.current(now: now) == ChatLimitWindow(used: 0) && past.hasReset(now: now))
        #expect(future.current(now: now) == future && !future.hasReset(now: now))
        #expect(ChatLimitWindow(used: 5).current(now: now) == ChatLimitWindow(used: 5))
        #expect(InboxPlanLimit(account: "x", fiveHour: future, sevenDay: ChatLimitWindow(used: 1, resetsAt: 3_000_000)).nextReset(now: now) == 2_000_000)
        #expect(InboxPlanLimit(account: "x", sevenDay: future).nextReset(now: now) == 2_000_000)
        #expect(InboxPlanLimit(account: "x", fiveHour: past, sevenDay: future).nextReset(now: now) == nil)
    }

    @Test func mergesAccountsAcrossDesktops() {
        func inbox(_ at: Int64, _ limits: [InboxPlanLimit]?) -> Inbox {
            Inbox(desktop: InboxDesktop(id: "d\(at)", name: "n"), generatedAt: at, projects: [], limits: limits)
        }
        let a = InboxPlanLimit(account: "a@x", fiveHour: ChatLimitWindow(used: 10))
        let b = InboxPlanLimit(account: "b@x"), c = InboxPlanLimit(account: "c@x")
        let newerA = InboxPlanLimit(account: "a@x", fiveHour: ChatLimitWindow(used: 20))
        #expect(InboxPlanLimit.merged([inbox(1, [a, b]), inbox(2, nil), inbox(3, [c, newerA])]) == [newerA, b, c])
        #expect(InboxPlanLimit.merged([inbox(3, [newerA]), inbox(1, [a])]) == [newerA])
        #expect(InboxPlanLimit.merged([inbox(1, nil)]).isEmpty)
    }

    /// The wire parser reads each task's `diff` too; malformed counts drop only the counts.
    @Test func wireTaskDiff() throws {
        let inbox = try Inbox.parse(try JSONValue.parse(#"""
        { "desktop": { "id": "d", "name": "n" }, "generatedAt": 1, "projects": [{ "id": "p", "name": "p", "remote": false,
          "streams": [{ "id": "s1", "name": "main", "main": true }], "tasks": [
            { "id": "t1", "name": "a", "streamId": "s1", "streamName": "main", "status": "idle", "diff": { "added": 1240, "deleted": 14 }, "tabs": [] },
            { "id": "t2", "name": "b", "streamId": "s1", "streamName": "main", "status": "idle", "diff": "junk", "tabs": [] }
        ] }] }
        """#))
        let tasks = inbox.projects[0].tasks
        #expect(tasks[0].diff == InboxTaskDiff(added: 1240, deleted: 14))
        #expect(tasks[1].diff == nil)
        #expect(try Inbox.parse(inbox.json).projects[0].tasks[0].diff == tasks[0].diff)
    }

    @Test func decodesTaskDiff() throws {
        let inbox = try decode("""
        {
          "desktop": { "id": "d1", "name": "mbp" }, "generatedAt": 1,
          "projects": [{
            "id": "p1", "name": "p", "remote": false, "streams": [{ "id": "s1", "name": "main", "main": true }],
            "tasks": [
              { "id": "t1", "name": "a", "streamId": "s1", "streamName": "main", "status": "idle", "diff": { "added": 1240, "deleted": 14 }, "tabs": [] },
              { "id": "t2", "name": "b", "streamId": "s1", "streamName": "main", "status": "idle", "diff": "junk", "tabs": [] }
            ]
          }]
        }
        """)
        let tasks = try #require(inbox.projects.first).tasks
        #expect(tasks[0].diff == InboxTaskDiff(added: 1240, deleted: 14))
        #expect(tasks[1].diff == nil)
        #expect(InboxTaskDiff.format(1240) == "1.2k")
        #expect(InboxTaskDiff.format(2000) == "2k")
        #expect(InboxTaskDiff.format(999) == "999")
    }

    @Test func decodesSpecExample() throws {
        let inbox = try decode("""
        {
          "desktop": { "id": "d1", "name": "join3r-mbp" },
          "generatedAt": 1790000000000,
          "projects": [{
            "id": "p1", "name": "api-server", "emoji": "🚀", "remote": false,
            "streams": [{ "id": "s1", "name": "main", "isMain": true }, { "id": "s2", "name": "0.5.0", "branch": "0.5.0" }],
            "lastStreamId": "s2",
            "tasks": [{
              "id": "t1", "name": "fix-auth", "streamId": "s2", "streamName": "0.5.0",
              "status": "working", "since": 1790000000000, "activity": "Running Bash",
              "lastInteractedAt": 1790000000000,
              "attentionAt": 1790000000000,
              "tabs": [{
                "id": "tab1", "type": "claude-chat", "title": "Claude",
                "status": "working", "since": 1790000000000, "activity": "Running Bash", "topic": "Fix the login redirect"
              }]
            }]
          }]
        }
        """)
        #expect(inbox.desktop.name == "join3r-mbp")
        #expect(inbox.generatedAt == 1_790_000_000_000)
        let project = try #require(inbox.projects.first)
        #expect(project.emoji == "🚀")
        #expect(project.remote == false)
        #expect(project.streams == [InboxStream(id: "s1", name: "main", isMain: true), InboxStream(id: "s2", name: "0.5.0", branch: "0.5.0")])
        #expect(project.defaultStream?.id == "s2")
        let task = try #require(project.tasks.first)
        #expect(task.streamId == "s2" && task.streamName == "0.5.0")
        #expect(task.status == .working && task.since == 1_790_000_000_000 && task.activity == "Running Bash")
        let tab = try #require(project.tasks.first?.tabs.first)
        #expect(tab.type == .claudeChat)
        #expect(tab.status == .working)
        #expect(tab.activity == "Running Bash" && tab.topic == "Fix the login redirect")
        #expect(tab.since == 1_790_000_000_000)
    }

    @Test func decodesTriageFields() throws {
        let inbox = try decode("""
        {
          "desktop": { "id": "d1", "name": "desk" }, "generatedAt": 1,
          "projects": [{ "id": "p1", "name": "a", "tasks": [
            { "id": "t1", "name": "x", "eventAt": 5, "unread": true, "settledAt": 7, "tabs": [] },
            { "id": "t2", "name": "y", "snoozedUntil": 9, "tabs": [] },
            { "id": "t3", "name": "z", "unread": "yes", "snoozeUntilAttention": true, "tabs": [] }
          ] }]
        }
        """)
        let tasks = try #require(inbox.projects.first?.tasks)
        // An older desktop's `settledAt` (Done for now) is ignored.
        #expect(tasks[0].eventAt == 5 && tasks[0].unread)
        #expect(tasks[1].snoozedUntil == 9 && !tasks[1].unread && !tasks[1].snoozeUntilAttention)
        #expect(!tasks[2].unread && tasks[2].snoozeUntilAttention)
    }

    @Test func resolvesPinsInOrderSkippingUnknownOnes() throws {
        let inbox = try decode("""
        {
          "desktop": { "id": "d1", "name": "desk" }, "generatedAt": 1,
          "projects": [
            { "id": "p1", "name": "a", "streams": [{ "id": "s1", "name": "main" }, { "id": "s2", "name": "bugs" }],
              "tasks": [{ "id": "t1", "name": "x", "streamId": "s1", "tabs": [] }] },
            { "id": "p2", "name": "b", "tasks": [] }
          ],
          "pinned": [{ "projectId": "p2" }, { "projectId": "gone" }, { "projectId": "p1", "streamId": "s1", "taskId": "t1" },
                     { "projectId": "p1", "taskId": "gone" }, { "projectId": "p1", "streamId": "s2" }, { "projectId": "p1", "streamId": "gone" }]
        }
        """)
        #expect(inbox.resolvedPins.map(\.id) == ["project:p2", "task:p1:t1", "stream:p1:s2"])
        #expect(inbox.isPinned(InboxPin(projectId: "p1", streamId: "other", taskId: "t1")))
        #expect(inbox.isPinned(InboxPin(projectId: "p1", streamId: "s2")))
        #expect(!inbox.isPinned(InboxPin(projectId: "p1", streamId: "s1")))
        #expect(!inbox.isPinned(InboxPin(projectId: "p1")))
    }

    @Test func toleratesUnknownValuesAndFields() throws {
        let inbox = try decode("""
        {
          "desktop": { "id": "d1", "name": "x", "os": "darwin" },
          "generatedAt": 1, "newTopLevel": [1, 2, 3],
          "projects": [{
            "id": "p1", "name": "a", "color": "#fff",
            "tasks": [{
              "id": "t1", "name": "b", "branch": "main",
              "tabs": [
                { "id": "1", "type": "browser", "title": "B", "status": "sleeping", "extra": {} },
                { "id": "2", "type": "terminal", "title": "T", "status": null },
                { "id": "3", "type": "pi", "title": "P" }
              ]
            }]
          }]
        }
        """)
        let tabs = inbox.projects[0].tasks[0].tabs
        #expect(tabs[0].type == .unknown("browser"))
        #expect(tabs[0].status == .unknown("sleeping"))
        #expect(tabs[1].status == .idle)
        #expect(tabs[2].status == .idle)
        #expect(tabs[2].type == .pi)
        #expect(inbox.projects[0].emoji == nil)
        #expect(inbox.projects[0].remote == false)
        #expect(inbox.projects[0].tasks[0].attentionAt == nil)
    }

    @Test func decodesStreamRuns() throws {
        let inbox = try decode(#"""
        { "desktop": { "id": "d", "name": "n" }, "projects": [{ "id": "p", "name": "n", "streams": [
          { "id": "a", "name": "main", "runCommand": "npm run dev", "run": { "status": "running", "startedAt": 5 } },
          { "id": "b", "name": "x", "runCommand": "make", "run": { "status": "exited", "startedAt": 5, "endedAt": 9, "exitCode": -15 } },
          { "id": "c", "name": "y", "run": { "status": "stopped", "startedAt": 5, "endedAt": 7 } },
          { "id": "d", "name": "z", "runCommand": "make", "run": { "status": "paused", "startedAt": 5 } },
          { "id": "e", "name": "w" }
        ] }] }
        """#)
        let streams = inbox.projects[0].streams
        #expect(streams[0].runCommand == "npm run dev" && streams[0].run == InboxStreamRun(status: .running, startedAt: 5))
        #expect(streams[1].run == InboxStreamRun(status: .exited, startedAt: 5, endedAt: 9, exitCode: -15))
        #expect(streams[2].runCommand == nil && streams[2].run?.status == .stopped)
        // An unknown status drops the run, not the stream.
        #expect(streams[3].runCommand == "make" && streams[3].run == nil)
        #expect(streams[4].runCommand == nil && streams[4].run == nil)
        // The cache round trip keeps them.
        let again = try JSONDecoder().decode(Inbox.self, from: JSONEncoder().encode(inbox))
        #expect(again == inbox)
    }

    @Test func missingArraysDecodeEmpty() throws {
        let inbox = try decode(#"{ "desktop": { "id": "d", "name": "n" }, "projects": [{ "id": "p", "name": "n", "tasks": [{ "id": "t", "name": "n" }] }] }"#)
        #expect(inbox.generatedAt == 0)
        #expect(inbox.projects[0].tasks[0].tabs.isEmpty)
    }

    @Test func missingFolderCountsOnlyAsTrue() throws {
        let inbox = try decode(#"{ "desktop": { "id": "d", "name": "n" }, "projects": [{ "id": "a", "name": "a", "missingFolder": true }, { "id": "b", "name": "b", "missingFolder": "yes" }, { "id": "c", "name": "c" }] }"#)
        #expect(inbox.projects.map(\.missingFolder) == [true, false, false])
        let parsed = try Inbox.parse(try JSONValue.parse(#"{ "desktop": { "id": "d", "name": "n" }, "generatedAt": 1, "projects": [{ "id": "a", "name": "a", "remote": false, "streams": [], "tasks": [], "missingFolder": true }] }"#))
        #expect(parsed.projects[0].missingFolder)
        guard case .array(let projects)? = parsed.json.objectValue?["projects"] else { Issue.record("no projects"); return }
        #expect(projects.first?.objectValue?["missingFolder"] == .bool(true))
    }

    @Test func roundTripsUnknownEnumsAsRawStrings() throws {
        let tab = InboxTab(id: "1", type: .unknown("browser"), title: "B", status: .unknown("sleeping"))
        let data = try JSONEncoder().encode(tab)
        let object = try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        #expect(object["type"] as? String == "browser")
        #expect(object["status"] as? String == "sleeping")
        #expect(try JSONDecoder().decode(InboxTab.self, from: data) == tab)
    }

    /// An inbox cached by a version 1 build has no task status: it is read
    /// from the tabs until the desktop sends a fresh inbox.
    @Test func cachedVersion1TaskTakesItsStatusFromItsTabs() throws {
        func task(_ statuses: [TabStatus]) throws -> InboxTask {
            let tabs = statuses.enumerated().map { InboxTab(id: "\($0.offset)", type: .terminal, title: "", status: $0.element) }
            let v1 = try JSONEncoder().encode(["id": "t", "name": "t"])
            var object = try #require(try JSONSerialization.jsonObject(with: v1) as? [String: Any])
            object["tabs"] = try JSONSerialization.jsonObject(with: try JSONEncoder().encode(tabs))
            return try JSONDecoder().decode(InboxTask.self, from: try JSONSerialization.data(withJSONObject: object))
        }
        #expect(try task([.idle, .working, .attention]).status == .attention)
        #expect(try task([.exited, .working]).status == .working)
        #expect(try task([.exited, .idle]).status == .exited)
        #expect(try task([]).status == .idle)
        #expect(try task([.working]).streamId == "")
    }

    @Test func groupsTasksByStreamAndPicksTheDefaultStream() {
        let main = InboxStream(id: "m", name: "main", isMain: true)
        let rel = InboxStream(id: "r", name: "0.5.0", branch: "0.5.0")
        let empty = InboxStream(id: "e", name: "bugfixes")
        func task(_ id: String, _ stream: InboxStream) -> InboxTask {
            InboxTask(id: id, name: id, streamId: stream.id, streamName: stream.name, tabs: [])
        }
        let orphan = InboxTask(id: "o", name: "o", streamId: "gone", streamName: "old", tabs: [])
        var project = InboxProject(id: "p", name: "p", streams: [main, rel, empty],
                                   tasks: [task("a", main), task("b", rel), task("c", rel), orphan])
        let groups = project.streamGroups
        #expect(groups.map(\.stream.id) == ["m", "r", "gone"])
        #expect(groups.map { $0.tasks.map(\.id) } == [["a"], ["b", "c"], ["o"]])
        #expect(groups[2].stream.name == "old")
        #expect(project.defaultStream == main)
        project.lastStreamId = "e"
        #expect(project.defaultStream == empty)
        project.lastStreamId = "archived"
        #expect(project.defaultStream == main)
    }

    @Test func mockInboxRoundTrips() throws {
        let inbox = MockInbox.sample(desktopId: "d", desktopName: "n", now: Date(timeIntervalSince1970: 1_790_000_000))
        let data = try JSONEncoder().encode(inbox)
        #expect(try JSONDecoder().decode(Inbox.self, from: data) == inbox)
    }
}

@Suite struct MockConnectionTests {
    @Test func pairingFlowEmitsPendingThenAcceptedThenInbox() async throws {
        let connection = MockDesktopConnection(
            desktopId: "d", desktopName: "desk",
            behavior: .pairing(acceptAfter: .milliseconds(50)),
            flipInterval: .milliseconds(20)
        )
        await connection.start()
        var sawPending = false, sawAccepted = false, inboxCount = 0
        for await event in connection.events {
            switch event {
            case .pairing(.pending): sawPending = true
            case .pairing(.accepted(let name)): sawAccepted = true; #expect(name == "desk")
            case .inbox: inboxCount += 1
            default: break
            }
            if inboxCount >= 3 { break }
        }
        #expect(sawPending && sawAccepted)
        try await connection.refresh()
        await connection.stop()
    }

    @Test func offlineRefreshThrows() async {
        let connection = MockDesktopConnection(desktopId: "d", desktopName: "desk", behavior: .offline(lastSeen: Date()))
        await connection.start()
        for await event in connection.events {
            if case .state(.offline) = event { break }
        }
        await #expect(throws: DesktopConnectionError.desktopOffline) {
            try await connection.refresh()
        }
        await connection.stop()
    }
}
