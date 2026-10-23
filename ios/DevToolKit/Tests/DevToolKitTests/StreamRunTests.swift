import Foundation
import Testing
@testable import DevToolKit

/// `stream.run` and `stream.logs` (§8.19): the vectors in
/// `protocol/vectors/chat-messages.json`, the inbox's run fields, and the mock.
@Suite struct StreamRunTests {
    @Test func streamRunParams() throws {
        let file = try #require(try Vectors.load("chat-messages.json")["streamRun"])
        #expect(!file["params"].array.isEmpty)
        for sample in file["params"].array {
            let parsed = try StreamRunParams.parse(try JSONValue.parse(sample["json"].str))
            #expect(parsed.json == sample["expected"], "\(sample["json"].str)")
        }
        for json in file["invalid"]["params"].array {
            #expect(throws: (any Error).self, "\(json.str)") { _ = try StreamRunParams.parse(try JSONValue.parse(json.str)) }
        }
    }

    @Test func streamLogsParamsAndResults() throws {
        let file = try #require(try Vectors.load("chat-messages.json")["streamLogs"])
        #expect(!file["params"].array.isEmpty && !file["results"].array.isEmpty)
        for sample in file["params"].array {
            let parsed = try StreamLogsParams.parse(try JSONValue.parse(sample["json"].str))
            #expect(parsed.json == sample["expected"], "\(sample["json"].str)")
        }
        for sample in file["results"].array {
            let parsed = try StreamLogsResult.parse(try JSONValue.parse(sample["json"].str))
            #expect(parsed.json == sample["expected"], "\(sample["json"].str)")
        }
        for json in file["invalid"]["params"].array {
            #expect(throws: (any Error).self, "\(json.str)") { _ = try StreamLogsParams.parse(try JSONValue.parse(json.str)) }
        }
        for json in file["invalid"]["results"].array {
            #expect(throws: (any Error).self, "\(json.str)") { _ = try StreamLogsResult.parse(try JSONValue.parse(json.str)) }
        }
        #expect(try StreamLogsResult.parse(try JSONValue.parse(#"{"text":"ready\n","truncated":true}"#)) == StreamLogsResult(text: "ready\n", truncated: true))
    }

    /// The wire parser: a run it can't read is dropped, the inbox still parses.
    @Test func wireInboxRunsAreLenient() throws {
        let inbox = try Inbox.parse(try JSONValue.parse(#"""
        { "desktop": { "id": "d", "name": "n" }, "generatedAt": 1, "projects": [{ "id": "p", "name": "n", "remote": false, "tasks": [], "streams": [
          { "id": "a", "name": "main", "main": true, "runCommand": "npm run dev", "run": { "status": "running", "startedAt": 5 } },
          { "id": "b", "name": "x", "run": { "status": "exited", "startedAt": 5, "endedAt": 9, "exitCode": -15, "pid": 3 } },
          { "id": "c", "name": "y", "runCommand": "make", "run": { "status": "crashed", "startedAt": 5 } },
          { "id": "d", "name": "z", "runCommand": null, "run": null },
          { "id": "e", "name": "w", "run": { "status": "running", "startedAt": "soon" } }
        ] }] }
        """#))
        let streams = inbox.projects[0].streams
        #expect(streams[0].runCommand == "npm run dev" && streams[0].run == InboxStreamRun(status: .running, startedAt: 5))
        #expect(streams[1].run == InboxStreamRun(status: .exited, startedAt: 5, endedAt: 9, exitCode: -15))
        #expect(streams[2].runCommand == "make" && streams[2].run == nil)
        #expect(streams[3].runCommand == nil && streams[3].run == nil)
        #expect(streams[4].run == nil)
        guard case .array(let projects)? = inbox.json.objectValue?["projects"],
              case .array(let out)? = projects.first?.objectValue?["streams"] else {
            Issue.record("no streams"); return
        }
        #expect(out[1].objectValue?["run"] == .object(["status": .string("exited"), "startedAt": .int(5), "endedAt": .int(9), "exitCode": .int(-15)]))
    }

    @Test func exitCodeOnlyWithExited() {
        #expect(InboxStreamRun(status: .stopped, startedAt: 1, endedAt: 2, exitCode: 0).exitCode == nil)
        #expect(InboxStreamRun(status: .exited, startedAt: 1, endedAt: 2, exitCode: 0).exitCode == 0)
    }

    @Test func mockRunsStopsRestartsAndLogs() async throws {
        let mock = MockDesktopConnection(desktopId: "d", desktopName: "desk", flipInterval: .seconds(60), streamStep: .milliseconds(1))
        let events = EventRecorder(mock)
        await mock.start()
        try await events.waitFor(RelayConnectionTests.isInbox)
        func stream(_ id: String, _ predicate: @escaping @Sendable (InboxStream) -> Bool) async throws {
            try await events.waitFor { event in
                guard case .inbox(let inbox) = event else { return false }
                return inbox.projects.flatMap(\.streams).first { $0.id == id }.map(predicate) ?? false
            }
        }

        let logs = try await mock.runLogs(projectId: "p-api", streamId: "s-api-main")
        #expect(logs.text.hasPrefix("$ npm run dev") && !logs.truncated)
        // A running run keeps printing.
        #expect(try await mock.runLogs(projectId: "p-api", streamId: "s-api-main").text.count > logs.text.count)

        try await mock.controlRun(projectId: "p-api", streamId: "s-api-main", action: .stop)
        try await stream("s-api-main") { $0.run?.status == .stopped && $0.run?.endedAt != nil }
        try await mock.controlRun(projectId: "p-api", streamId: "s-api-main", action: .start)
        try await stream("s-api-main") { $0.run?.status == .running && $0.run?.endedAt == nil }
        try await mock.controlRun(projectId: "p-api", streamId: "s-api-050", action: .restart)
        try await stream("s-api-050") { $0.run?.isRunning == true && $0.run?.exitCode == nil }

        // Never ran: empty output.
        #expect(try await mock.runLogs(projectId: "p-web", streamId: "s-web-main").text.isEmpty)
        await #expect(throws: DesktopConnectionError.remote(code: AppErrorCode.internal, message: "No run command is set for this project or stream")) {
            try await mock.controlRun(projectId: "p-api", streamId: "s-api-bugs", action: .start)
        }
        await #expect(throws: DesktopConnectionError.remote(code: AppErrorCode.notFound, message: "No such stream")) {
            _ = try await mock.runLogs(projectId: "p-api", streamId: "missing")
        }
        await mock.stop()
    }
    /// The Inbox's Apps group: running and crashed runs only, crashes first.
    @Test func inboxAppsListsRunningAndCrashedRuns() {
        func stream(_ id: String, _ run: InboxStreamRun?) -> InboxStream {
            InboxStream(id: id, name: id, isMain: id == "main", runCommand: "make", run: run)
        }
        let a = InboxProject(id: "a", name: "a", streams: [
            stream("main", InboxStreamRun(status: .running, startedAt: 10)),
            stream("clean", InboxStreamRun(status: .exited, startedAt: 1, endedAt: 2, exitCode: 0)),
            stream("stopped", InboxStreamRun(status: .stopped, startedAt: 1, endedAt: 2)),
            stream("never", nil),
            stream("crash-old", InboxStreamRun(status: .exited, startedAt: 1, endedAt: 3, exitCode: 1)),
        ], tasks: [])
        let b = InboxProject(id: "b", name: "b", streams: [
            stream("main", InboxStreamRun(status: .running, startedAt: 20)),
            stream("killed", InboxStreamRun(status: .exited, startedAt: 1, endedAt: 5, exitCode: -15)),
            stream("unknown", InboxStreamRun(status: .exited, startedAt: 1, endedAt: 4)),
        ], tasks: [])
        let c = InboxProject(id: "c", name: "c", streams: [stream("main", InboxStreamRun(status: .running, startedAt: 10))], tasks: [])
        let d1 = Inbox(desktop: InboxDesktop(id: "d1", name: "one"), generatedAt: 0, projects: [a, b])
        let d2 = Inbox(desktop: InboxDesktop(id: "d2", name: "two"), generatedAt: 0, projects: [c])
        let apps = InboxAppRun.list([("d1", d1), ("d2", d2)])
        #expect(apps.map(\.id) == [
            "d1:b:killed", "d1:b:unknown", "d1:a:crash-old",
            "d1:b:main", "d1:a:main", "d2:c:main",
        ])
        #expect(apps[0].project.name == "b" && apps[0].stream.id == "killed" && apps[0].run.crashed)
        #expect(InboxAppRun.list([]).isEmpty)
        #expect(!InboxStreamRun(status: .exited, startedAt: 1, endedAt: 2, exitCode: 0).isInboxApp)
        #expect(!InboxStreamRun(status: .stopped, startedAt: 1, endedAt: 2).isInboxApp)
    }
}
