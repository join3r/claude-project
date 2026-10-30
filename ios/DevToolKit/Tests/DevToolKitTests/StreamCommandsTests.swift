import Foundation
import Testing
@testable import DevToolKit

/// `stream.commands.get`, `.set` and `.suggest` (§8.21): the vectors in
/// `protocol/vectors/chat-messages.json`, the sheet's merge, and the mock.
@Suite struct StreamCommandsTests {
    @Test func vectors() throws {
        let file = try #require(try Vectors.load("chat-messages.json")["streamCommands"])
        #expect(!file["params"].array.isEmpty && !file["results"].array.isEmpty && !file["setParams"].array.isEmpty)
        for sample in file["params"].array {
            #expect(try StreamCommandsParams.parse(try JSONValue.parse(sample["json"].str)).json == sample["expected"], "\(sample["json"].str)")
        }
        for sample in file["results"].array {
            #expect(try StreamCommandsResult.parse(try JSONValue.parse(sample["json"].str)).json == sample["expected"], "\(sample["json"].str)")
        }
        for sample in file["setParams"].array {
            #expect(try StreamCommandsSetParams.parse(try JSONValue.parse(sample["json"].str)).json == sample["expected"], "\(sample["json"].str)")
        }
        for sample in file["suggestResults"].array {
            #expect(try StreamCommandsSuggestResult.parse(try JSONValue.parse(sample["json"].str)).json == sample["expected"], "\(sample["json"].str)")
        }
        for json in file["invalid"]["params"].array {
            #expect(throws: (any Error).self, "\(json.str)") { _ = try StreamCommandsParams.parse(try JSONValue.parse(json.str)) }
        }
        for json in file["invalid"]["results"].array {
            #expect(throws: (any Error).self, "\(json.str)") { _ = try StreamCommandsResult.parse(try JSONValue.parse(json.str)) }
        }
        for json in file["invalid"]["setParams"].array {
            #expect(throws: (any Error).self, "\(json.str)") { _ = try StreamCommandsSetParams.parse(try JSONValue.parse(json.str)) }
        }
        for json in file["invalid"]["suggestResults"].array {
            #expect(throws: (any Error).self, "\(json.str)") { _ = try StreamCommandsSuggestResult.parse(try JSONValue.parse(json.str)) }
        }
    }

    /// The desktop editor's `mergeSuggestedCommands`, on the phone.
    @Test func mergeSetsSameNamedRowsAndAddsTheRest() {
        var n = 0
        let rows = [
            RunCommandDraft(key: "a", savedId: "c-run", name: "Run", command: "npm start"),
            RunCommandDraft(key: "b", savedId: "c-install", name: "install", command: "npm ci"),
            RunCommandDraft(key: "blank"),
        ]
        let (next, changed) = RunCommandDrafts.merge(rows, suggested: [
            SuggestedCommand(name: "run", command: "npm run dev"),
            SuggestedCommand(name: "install", command: "npm ci"),
            SuggestedCommand(name: "test", command: "npm test"),
            SuggestedCommand(name: "lint", command: "npm run lint"),
        ], inherited: [InboxRunCommand(id: "p", name: "Lint", command: "npm run lint")], newKey: { n += 1; return "new\(n)" })
        #expect(next.map(\.key) == ["a", "b", "new1"])
        #expect(next[0].command == "npm run dev" && next[0].savedId == "c-run" && next[0].name == "Run")
        #expect(next[2] == RunCommandDraft(key: "new1", name: "test", command: "npm test"))
        #expect(changed == ["a", "new1"])
        // Nothing new: nothing changes but the blank row.
        let same = RunCommandDrafts.merge(rows, suggested: [SuggestedCommand(name: "install", command: "npm ci")])
        #expect(same.changed.isEmpty && same.next.count == 2)
    }

    @Test func draftsProblemAndEntries() {
        let ok = [RunCommandDraft(savedId: "c1", name: " run ", command: " make dev "), RunCommandDraft()]
        #expect(RunCommandDrafts.problem(ok) == nil)
        #expect(RunCommandDrafts.entries(ok) == [StreamCommandEntry(id: "c1", name: "run", command: "make dev")])
        #expect(RunCommandDrafts.problem([RunCommandDraft(name: "run")]) == "Each command needs a name and a command line.")
        #expect(RunCommandDrafts.problem([RunCommandDraft(name: "run", command: "a"), RunCommandDraft(name: "RUN", command: "b")]) == "Two commands are named “RUN”.")
        #expect(RunCommandDrafts.problem([RunCommandDraft(name: String(repeating: "x", count: 61), command: "a")]) != nil)
        #expect(RunCommandDrafts.problem((0...20).map { RunCommandDraft(name: "c\($0)", command: "true") }) == "At most 20 commands.")
        // An older desktop's single command (empty id) is sent without one.
        #expect(RunCommandDraft(InboxRunCommand(id: "", name: "run", command: "make")).savedId == nil)
    }

    @Test func mockGetsSetsAndSuggests() async throws {
        let mock = MockDesktopConnection(desktopId: "d", desktopName: "desk", flipInterval: .seconds(60), streamStep: .milliseconds(1),
                                         suggestDelay: .milliseconds(1))
        let events = EventRecorder(mock)
        await mock.start()
        try await events.waitFor(RelayConnectionTests.isInbox)

        let project = try await mock.streamCommands(projectId: "p-api")
        #expect(project.commands.map(\.id) == ["c-run", "c-install", "c-staging"] && project.inherited.isEmpty)
        let stream = try await mock.streamCommands(projectId: "p-api", streamId: "s-api-050")
        #expect(stream.commands.map(\.command) == ["npm run dev -- --port 3001", "npm run dev -- --mode staging --port 3001"])
        #expect(stream.inherited.map(\.id) == ["c-run", "c-install", "c-staging"])

        // The project's run changes and a test command joins; 0.5.0 keeps its own run.
        try await mock.setStreamCommands(projectId: "p-api", commands: [
            StreamCommandEntry(id: "c-run", name: "run", command: "pnpm dev"), StreamCommandEntry(name: "test", command: "pnpm test"),
        ])
        try await events.waitFor { event in
            guard case .inbox(let inbox) = event, let api = inbox.projects.first(where: { $0.id == "p-api" }) else { return false }
            let main = api.streams.first { $0.isMain }, s050 = api.streams.first { $0.id == "s-api-050" }
            return main?.commands.map(\.command) == ["pnpm dev", "pnpm test"]
                && s050?.commands.map(\.command) == ["npm run dev -- --port 3001", "pnpm test", "npm run dev -- --mode staging --port 3001"]
                && main?.commands.first?.id == "c-run"
        }

        #expect(try await mock.suggestStreamCommands(projectId: "p-api").map(\.name) == ["install", "run", "test"])
        await #expect(throws: DesktopConnectionError.remote(code: AppErrorCode.unsupported, message: "Suggest with Claude isn't available for SSH projects yet.")) {
            _ = try await mock.suggestStreamCommands(projectId: "p-infra")
        }
        await #expect(throws: DesktopConnectionError.remote(code: AppErrorCode.notFound, message: "No such stream")) {
            _ = try await mock.streamCommands(projectId: "p-api", streamId: "missing")
        }
        await #expect(throws: (any Error).self) {
            try await mock.setStreamCommands(projectId: "p-api", commands: [StreamCommandEntry(name: "run", command: "a"), StreamCommandEntry(name: "Run", command: "b")])
        }
        await mock.stop()
    }
}
