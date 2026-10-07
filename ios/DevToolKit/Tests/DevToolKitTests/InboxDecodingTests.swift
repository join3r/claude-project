import Foundation
import Testing
@testable import DevToolKit

@Suite struct InboxDecodingTests {
    func decode(_ json: String) throws -> Inbox {
        try JSONDecoder().decode(Inbox.self, from: Data(json.utf8))
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
                "status": "working", "since": 1790000000000, "activity": "Running Bash"
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
        #expect(tab.activity == "Running Bash")
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
        #expect(tasks[0].eventAt == 5 && tasks[0].unread && tasks[0].settledAt == 7)
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

    @Test func missingArraysDecodeEmpty() throws {
        let inbox = try decode(#"{ "desktop": { "id": "d", "name": "n" }, "projects": [{ "id": "p", "name": "n", "tasks": [{ "id": "t", "name": "n" }] }] }"#)
        #expect(inbox.generatedAt == 0)
        #expect(inbox.projects[0].tasks[0].tabs.isEmpty)
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
