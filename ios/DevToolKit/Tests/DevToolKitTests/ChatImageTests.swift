import Foundation
import Testing
@testable import DevToolKit

/// `chat.image` (§8.9) and tool items' `images` count (§6.2).
@Suite struct ChatImageTests {
    @Test func vectors() throws {
        let image = try #require(try Vectors.load("chat-messages.json")["image"])
        #expect(!image["params"].array.isEmpty && !image["results"].array.isEmpty)
        for sample in image["params"].array {
            let parsed = try ChatImageParams.parse(try JSONValue.parse(sample["json"].str))
            #expect(parsed.json == sample["expected"], "\(sample["json"].str)")
        }
        for sample in image["results"].array {
            let parsed = try ChatImageResult.parse(try JSONValue.parse(sample["json"].str))
            #expect(parsed.json == sample["expected"], "\(sample["json"].str)")
        }
        for json in image["invalid"]["params"].array {
            #expect(throws: (any Error).self, "\(json.str)") { _ = try ChatImageParams.parse(try JSONValue.parse(json.str)) }
        }
        for json in image["invalid"]["results"].array {
            #expect(throws: (any Error).self, "\(json.str)") { _ = try ChatImageResult.parse(try JSONValue.parse(json.str)) }
        }
    }

    @Test func imageIsNotATabOp() throws {
        #expect(try ChatParams.parse(op: ChatOp.image, .object(["tabId": "t", "itemId": "i", "index": 0])) == nil)
    }

    @Test func toolItemsCountImages() throws {
        let item = try ChatItem.parse(try JSONValue.parse(
            #"{"kind":"tool","id":"s","name":"Read","summary":"Read shot.png","status":"done","hasDetail":true,"images":2}"#))
        guard case .tool(let tool) = item.content else { Issue.record("not a tool"); return }
        #expect(tool.images == 2)
        #expect(try ChatItem.parse(item.json) == item)

        let none = try ChatItem.parse(try JSONValue.parse(
            #"{"kind":"tool","id":"s","name":"Read","summary":"","status":"done","hasDetail":true,"images":0}"#))
        guard case .tool(let plain) = none.content else { Issue.record("not a tool"); return }
        #expect(plain.images == nil)
    }

    @Test func mockServesImagesAtTheAskedSize() async throws {
        let mock = MockDesktopConnection(desktopId: "m", desktopName: "mock", streamStep: .milliseconds(5))
        let events = EventRecorder(mock)
        await mock.start()
        try await events.waitFor { $0 == .state(.online) }
        let result = try await mock.chatImage(tabId: "tab-1", itemId: "t2s", index: 1, maxSide: 200)
        #expect(result.mediaType == "image/png")
        #expect(result.data.starts(with: [0x89, 0x50, 0x4E, 0x47]))
        await #expect(throws: DesktopConnectionError.self) {
            _ = try await mock.chatImage(tabId: "tab-1", itemId: "t2s", index: 2, maxSide: 200)
        }
    }
}
