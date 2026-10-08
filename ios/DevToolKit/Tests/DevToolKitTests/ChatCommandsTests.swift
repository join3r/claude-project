import Foundation
import Testing
@testable import DevToolKit

/// The composer's `/` menu (§8.14): `chat.commands`, `chat.btw` and `chat.permissions`.
@Suite struct ChatCommandsTests {
    @Test func commandsVectors() throws {
        let commands = try #require(try Vectors.load("chat-messages.json")["commands"])
        #expect(!commands["params"].array.isEmpty && !commands["results"].array.isEmpty)
        for sample in commands["params"].array {
            let parsed = try ChatTabParams.parse(try JSONValue.parse(sample["json"].str))
            #expect(parsed.json == sample["expected"], "\(sample["json"].str)")
        }
        for sample in commands["results"].array {
            let parsed = try ChatCommandsResult.parse(try JSONValue.parse(sample["json"].str))
            #expect(parsed.json == sample["expected"], "\(sample["json"].str)")
        }
        for json in commands["invalid"]["params"].array {
            #expect(throws: (any Error).self, "\(json.str)") { _ = try ChatTabParams.parse(try JSONValue.parse(json.str)) }
        }
        for json in commands["invalid"]["results"].array {
            #expect(throws: (any Error).self, "\(json.str)") { _ = try ChatCommandsResult.parse(try JSONValue.parse(json.str)) }
        }
    }

    @Test func btwVectors() throws {
        let btw = try #require(try Vectors.load("chat-messages.json")["btw"])
        #expect(!btw["params"].array.isEmpty && !btw["results"].array.isEmpty)
        for sample in btw["params"].array {
            let parsed = try ChatBtwParams.parse(try JSONValue.parse(sample["json"].str))
            #expect(parsed.json == sample["expected"], "\(sample["json"].str)")
        }
        for sample in btw["results"].array {
            let parsed = try ChatBtwResult.parse(try JSONValue.parse(sample["json"].str))
            #expect(parsed.json == sample["expected"], "\(sample["json"].str)")
        }
        for json in btw["invalid"]["params"].array {
            #expect(throws: (any Error).self, "\(json.str.prefix(80))") { _ = try ChatBtwParams.parse(try JSONValue.parse(json.str)) }
        }
        for json in btw["invalid"]["results"].array {
            #expect(throws: (any Error).self, "\(json.str)") { _ = try ChatBtwResult.parse(try JSONValue.parse(json.str)) }
        }
    }

    @Test func permissionsVectors() throws {
        let permissions = try #require(try Vectors.load("chat-messages.json")["permissions"])
        #expect(!permissions["results"].array.isEmpty && !permissions["updateParams"].array.isEmpty)
        for sample in permissions["params"].array {
            let parsed = try ChatTabParams.parse(try JSONValue.parse(sample["json"].str))
            #expect(parsed.json == sample["expected"], "\(sample["json"].str)")
        }
        for sample in permissions["results"].array {
            let parsed = try ChatPermissionsResult.parse(try JSONValue.parse(sample["json"].str))
            #expect(parsed.json == sample["expected"], "\(sample["json"].str)")
        }
        for sample in permissions["updateParams"].array {
            let parsed = try ChatPermissionsUpdateParams.parse(try JSONValue.parse(sample["json"].str))
            #expect(parsed.json == sample["expected"], "\(sample["json"].str)")
        }
        for json in permissions["invalid"]["params"].array {
            #expect(throws: (any Error).self, "\(json.str)") { _ = try ChatTabParams.parse(try JSONValue.parse(json.str)) }
        }
        for json in permissions["invalid"]["results"].array {
            #expect(throws: (any Error).self, "\(json.str)") { _ = try ChatPermissionsResult.parse(try JSONValue.parse(json.str)) }
        }
        for json in permissions["invalid"]["updateParams"].array {
            #expect(throws: (any Error).self, "\(json.str.prefix(80))") { _ = try ChatPermissionsUpdateParams.parse(try JSONValue.parse(json.str)) }
        }
    }

    @Test func newOpsAreNotTabOps() throws {
        for op in [ChatOp.commands, ChatOp.btw, ChatOp.permissions, ChatOp.permissionsUpdate] {
            #expect(try ChatParams.parse(op: op, .object(["tabId": "t"])) == nil)
        }
    }

    @Test func menuQueryNeedsASlashAndOneWord() {
        #expect(ChatCommandMenu.query("/") == "")
        #expect(ChatCommandMenu.query("/com") == "com")
        #expect(ChatCommandMenu.query("/compact now") == nil)
        #expect(ChatCommandMenu.query(" /com") == nil)
        #expect(ChatCommandMenu.query("hi /com") == nil)
        #expect(ChatCommandMenu.query("") == nil)
    }

    @Test func menuRanksLikeTheDesktop() {
        let commands = ["review", "security-review", "release-notes", "Resume", "clear", "compact", "context"].map { ChatCommand(name: $0) }
        func names(_ query: String) -> [String] { ChatCommandMenu.matches(commands, query: query).map(\.name) }
        // One character: prefixes only.
        #expect(names("r") == ["release-notes", "Resume", "review"])
        // Two or more: prefixes first, then names containing it.
        #expect(names("re") == ["release-notes", "Resume", "review", "security-review"])
        #expect(names("view") == ["review", "security-review"])
        #expect(names("co") == ["compact", "context"])
        #expect(names("").count == commands.count)
        #expect(names("zz").isEmpty)
        let many = (0..<80).map { ChatCommand(name: "cmd\($0)") }
        #expect(ChatCommandMenu.matches(many, query: "c").count == 50)
    }

    @Test func sideQuestionsAndCommandsInText() {
        #expect(ChatCommandMenu.sideQuestion(in: "/btw why is it slow?") == "why is it slow?")
        #expect(ChatCommandMenu.sideQuestion(in: "  /btw\n  two\nlines  ") == "two\nlines")
        #expect(ChatCommandMenu.sideQuestion(in: "/btw") == "")
        #expect(ChatCommandMenu.sideQuestion(in: "/btw   ") == "")
        #expect(ChatCommandMenu.sideQuestion(in: "/btwx why") == nil)
        #expect(ChatCommandMenu.sideQuestion(in: "btw why") == nil)
        #expect(ChatCommandMenu.command(in: " /permissions ") == "permissions")
        #expect(ChatCommandMenu.command(in: "/config theme") == "config")
        #expect(ChatCommandMenu.command(in: "/ x") == nil)
        #expect(ChatCommandMenu.command(in: "hello") == nil)
    }

    @Test func mockServesTheMenuSideQuestionsAndRules() async throws {
        let mock = MockDesktopConnection(desktopId: "m", desktopName: "mock", streamStep: .milliseconds(5))
        let events = EventRecorder(mock)
        await mock.start()
        try await events.waitFor { $0.isFeatures(containing: DesktopFeature.chatCommands) }
        try await events.waitFor { $0 == .state(.online) }

        let commands = try await mock.chatCommands(tabId: "tab-1")
        #expect(commands.first?.name == "btw")
        #expect(commands.contains { $0.terminalOnly })
        #expect(commands.contains { $0.argumentHint != nil && $0.name != "btw" })

        let answer = try await mock.askSideQuestion(tabId: "tab-1", question: "why?")
        #expect(answer.response?.contains("why?") == true)
        #expect(!answer.synthetic)

        let sources = try await mock.chatPermissions(tabId: "tab-1")
        #expect(sources.map(\.kind) == [.localSettings, .projectSettings, .userSettings])
        let added = try await mock.updateChatPermission(.init(tabId: "tab-1", kind: .projectSettings, behavior: .deny, rule: " WebSearch ", action: .add))
        #expect(added[1].deny == ["WebSearch"])
        let removed = try await mock.updateChatPermission(.init(tabId: "tab-1", kind: .projectSettings, behavior: .deny, rule: "WebSearch", action: .remove))
        #expect(removed[1].deny.isEmpty)
        await #expect(throws: DesktopConnectionError.self) { _ = try await mock.chatCommands(tabId: "nope") }
    }
}

private extension DesktopConnectionEvent {
    func isFeatures(containing feature: String) -> Bool {
        if case .features(let features) = self { return features.contains(feature) }
        return false
    }
}
