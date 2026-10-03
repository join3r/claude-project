import Foundation
import Testing
@testable import DevToolKit

/// `chat.settings` (§8.5) and the `settings` / `usage` status fields (§6.2).
@Suite struct ChatSettingsTests {
    @Test func paramsVectors() throws {
        let settings = try #require(try Vectors.load("chat-messages.json")["settings"])
        #expect(!settings["params"].array.isEmpty)
        for sample in settings["params"].array {
            let parsed = try ChatSettingsParams.parse(try JSONValue.parse(sample["json"].str))
            #expect(parsed.json == sample["expected"], "\(sample["json"].str)")
        }
        let invalid = settings["invalid"]["params"].array
        #expect(!invalid.isEmpty)
        for json in invalid {
            #expect(throws: (any Error).self, "\(json.str)") {
                _ = try ChatSettingsParams.parse(try JSONValue.parse(json.str))
            }
        }
    }

    @Test func settingsIsNotATabOp() throws {
        #expect(try ChatParams.parse(op: ChatOp.settings, .object(["tabId": "t", "mode": "plan"])) == nil)
    }

    @Test func statusCarriesSettingsAndUsage() throws {
        let view = try ChatView.parse(try JSONValue.parse(#"""
        {"tabId":"t","title":"Claude","busy":false,"process":"idle","items":[],"hasEarlier":false,"prompts":[],
         "settings":{"model":"haiku","modelName":"Haiku 4.5","models":[{"value":"haiku","label":"Haiku 4.5","description":null}],"efforts":["low"],"extra":1},
         "usage":{"contextTokens":1000,"costCents":5,"fiveHour":{"used":40,"resetsAt":1790003600000},"sevenDay":null}}
        """#))
        #expect(view.status.settings == ChatSettings(model: "haiku", modelName: "Haiku 4.5",
                                                     models: [ChatModelOption(value: "haiku", label: "Haiku 4.5")], efforts: ["low"]))
        #expect(view.status.usage == ChatUsage(contextTokens: 1000, costCents: 5, fiveHour: ChatLimitWindow(used: 40, resetsAt: 1_790_003_600_000)))
        #expect(try ChatView.parse(view.json) == view)

        let old = try ChatView.parse(try JSONValue.parse(#"{"tabId":"t","title":"C","busy":false,"process":"idle","items":[],"hasEarlier":false,"prompts":[]}"#))
        #expect(old.status.settings == nil && old.status.usage == nil)
    }

    @Test func mockDesktopAppliesSettings() async throws {
        let mock = MockDesktopConnection(desktopId: "d", desktopName: "desk", flipInterval: .seconds(60), streamStep: .milliseconds(1))
        let events = EventRecorder(mock)
        await mock.start()
        try await events.waitFor(RelayConnectionTests.isInbox)
        let tabId = try await mock.newChat(taskId: "t-auth")
        let opened = try await mock.openChat(tabId: tabId)
        #expect(opened.view.status.settings?.models.isEmpty == false)
        let stream = await mock.chatEvents()
        try await mock.updateChatSettings(tabId: tabId, mode: "plan", model: "haiku", effort: "high")
        var iterator = stream.makeAsyncIterator()
        var status: ChatStatus?
        while let event = await iterator.next() {
            if case .chat(let chat) = event, chat.tabId == tabId { status = chat.status; break }
        }
        #expect(status?.permissionMode == "plan")
        #expect(status?.settings?.model == "haiku")
        #expect(status?.settings?.modelName == "Haiku 4.5")
        #expect(status?.settings?.effort == "high")
        await #expect(throws: DesktopConnectionError.self) {
            try await mock.updateChatSettings(tabId: tabId, mode: "yolo")
        }
        await mock.stop()
    }
}
