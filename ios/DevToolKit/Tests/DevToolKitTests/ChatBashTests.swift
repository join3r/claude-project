import Foundation
import Testing
@testable import DevToolKit

/// `!command` in the composer (§8.17): `chat.bash`.
@Suite struct ChatBashTests {
    @Test func bashVectors() throws {
        let bash = try #require(try Vectors.load("chat-messages.json")["bash"])
        #expect(!bash["params"].array.isEmpty && !bash["invalid"]["params"].array.isEmpty)
        for sample in bash["params"].array {
            let parsed = try ChatBashParams.parse(try JSONValue.parse(sample["json"].str))
            #expect(parsed.json == sample["expected"], "\(sample["json"].str)")
        }
        for json in bash["invalid"]["params"].array {
            #expect(throws: (any Error).self, "\(json.str.prefix(80))") { _ = try ChatBashParams.parse(try JSONValue.parse(json.str)) }
        }
    }

    @Test func bashModeMatchesTheDesktop() {
        #expect(ChatBashMode.isOn("!ls"))
        #expect(ChatBashMode.isOn("  \n! git status"))
        #expect(!ChatBashMode.isOn("ls !"))
        #expect(!ChatBashMode.isOn(""))
        #expect(ChatBashMode.command(in: "  ! git status  ") == "git status")
        #expect(ChatBashMode.command(in: "!ls -la\n  pwd") == "ls -la\n  pwd")
        #expect(ChatBashMode.command(in: "!") == "")
        #expect(ChatBashMode.command(in: "  !   ") == "")
        #expect(ChatBashMode.command(in: "say hi!") == nil)
        #expect(ChatBashMode.command(in: "/btw why") == nil)
    }

    @Test func mockDesktopRunsBashAsAToolRow() async throws {
        let mock = MockDesktopConnection(desktopId: "m", desktopName: "mock", streamStep: .milliseconds(5))
        let events = EventRecorder(mock)
        await mock.start()
        try await events.waitFor { if case .features(let features) = $0 { features.contains(DesktopFeature.chatBash) } else { false } }
        try await events.waitFor { $0 == .state(.online) }
        try await mock.runBash(tabId: "tab-1", command: "git status")
        let open = try await mock.openChat(tabId: "tab-1")
        let row = try #require(open.view.items.last)
        guard case .tool(let tool) = row.content else { Issue.record("not a tool row"); return }
        #expect(tool.name == "Bash" && tool.summary == "! git status")
        #expect(tool.status == .running || tool.status == .done)
        await #expect(throws: DesktopConnectionError.self) { try await mock.runBash(tabId: "tab-1", command: "  ") }
    }
}
