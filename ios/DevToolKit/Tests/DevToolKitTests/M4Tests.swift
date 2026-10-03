import Foundation
import Testing
@testable import DevToolKit

/// `chat.new` samples in `protocol/vectors/chat-messages.json` (§8.2).
@Suite struct ChatNewVectorTests {
    @Test func paramsAndResults() throws {
        let new = try #require(try Vectors.load("chat-messages.json")["new"])
        #expect(!new["params"].array.isEmpty)
        for sample in new["params"].array {
            let parsed = try ChatNewParams.parse(try JSONValue.parse(sample["json"].str))
            #expect(parsed.json == sample["expected"], "\(sample["json"].str)")
        }
        #expect(!new["results"].array.isEmpty)
        for sample in new["results"].array {
            let parsed = try ChatNewResult.parse(try JSONValue.parse(sample["json"].str))
            #expect(parsed.json == sample["expected"], "\(sample["json"].str)")
        }
    }

    @Test func invalid() throws {
        let invalid = try #require(try Vectors.load("chat-messages.json")["new"]?["invalid"])
        #expect(!invalid["params"].array.isEmpty && !invalid["results"].array.isEmpty)
        for json in invalid["params"].array {
            #expect(throws: (any Error).self, "\(json.str)") {
                _ = try ChatNewParams.parse(try JSONValue.parse(json.str))
            }
        }
        for json in invalid["results"].array {
            #expect(throws: (any Error).self, "\(json.str)") {
                _ = try ChatNewResult.parse(try JSONValue.parse(json.str))
            }
        }
    }

    @Test func chatNewIsNotATabOp() throws {
        #expect(try ChatParams.parse(op: ChatOp.new, .object(["taskId": "t1"])) == nil)
    }

    @Test func featuresKeepUnknownStrings() throws {
        let hello = try DesktopHello.parse(Data(#"{"v":1,"min":1,"app":"devtool/0.4.0","features":["chat.new","later.thing",7],"desktopName":"d","result":"ok"}"#.utf8))
        #expect(hello.features == ["chat.new", "later.thing"])
        let old = try DesktopHello.parse(Data(#"{"v":1,"min":1,"app":"devtool/0.3.2","desktopName":"d","result":"ok"}"#.utf8))
        #expect(old.features.isEmpty)
    }

    @Test func desktopRecordFeaturesAreOptional() throws {
        let old = #"{"id":"a","name":"n","relayURL":"wss://r","desktopX25519PublicKey":"x","desktopEd25519PublicKey":"e","keysReference":"k","pairedAt":0}"#
        let record = try JSONDecoder().decode(DesktopRecord.self, from: Data(old.utf8))
        #expect(record.features == nil)
        #expect(!record.supports(DesktopFeature.chatNew))
        var updated = record
        updated.features = [DesktopFeature.chatNew]
        let decoded = try JSONDecoder().decode(DesktopRecord.self, from: try JSONEncoder().encode(updated))
        #expect(decoded.supports(DesktopFeature.chatNew))
    }
}

/// `task.new` samples in `protocol/vectors/chat-messages.json` (§8.4).
@Suite struct TaskNewVectorTests {
    @Test func paramsAndResults() throws {
        let taskNew = try #require(try Vectors.load("chat-messages.json")["taskNew"])
        #expect(!taskNew["params"].array.isEmpty)
        for sample in taskNew["params"].array {
            let parsed = try TaskNewParams.parse(try JSONValue.parse(sample["json"].str))
            #expect(parsed.json == sample["expected"], "\(sample["json"].str)")
        }
        #expect(!taskNew["results"].array.isEmpty)
        for sample in taskNew["results"].array {
            let parsed = try TaskNewResult.parse(try JSONValue.parse(sample["json"].str))
            #expect(parsed.json == sample["expected"], "\(sample["json"].str)")
        }
    }

    @Test func invalid() throws {
        let invalid = try #require(try Vectors.load("chat-messages.json")["taskNew"]?["invalid"])
        #expect(!invalid["params"].array.isEmpty && !invalid["results"].array.isEmpty)
        for json in invalid["params"].array {
            #expect(throws: (any Error).self, "\(json.str)") {
                _ = try TaskNewParams.parse(try JSONValue.parse(json.str))
            }
        }
        for json in invalid["results"].array {
            #expect(throws: (any Error).self, "\(json.str)") {
                _ = try TaskNewResult.parse(try JSONValue.parse(json.str))
            }
        }
    }

    @Test func promptIsCappedLikeChatSend() throws {
        let over = String(repeating: "x", count: ChatOp.maxSendLength + 1)
        #expect(throws: ProtocolError.self) {
            _ = try TaskNewParams.parse(.object(["projectId": "p", "prompt": .string(over)]))
        }
        #expect(try ChatParams.parse(op: TaskOp.new, .object(["projectId": "p", "prompt": "Go"])) == nil)
    }
}

/// `features`, `chat.new` and `reconnectNow()` over `RelayDesktopConnection`.
@Suite(.serialized) struct M4ConnectionTests {
    static let isFeatures: @Sendable (DesktopConnectionEvent) -> Bool = {
        if case .features = $0 { return true }
        return false
    }

    @Test func featuresArriveBeforeOnlineAndChatNewWorks() async throws {
        let o = try await ChatConnectionTests.online()
        let events = await o.events.events
        let features = try #require(events.firstIndex { Self.isFeatures($0) })
        let online = try #require(events.firstIndex(of: .state(.online)))
        #expect(features < online)
        #expect(events[features] == .features([DesktopFeature.chatNew]))

        let tabId = try await o.connection.newChat(taskId: "t")
        #expect(tabId == "tab-new-1")
        #expect(o.desktop.requests.last?.op == ChatOp.new)
        #expect(o.desktop.requests.last?.params == .object(["taskId": "t"]))
        await #expect(throws: DesktopConnectionError.remote(code: AppErrorCode.notFound, message: "No such task")) {
            _ = try await o.connection.newChat(taskId: "nope")
        }
        await o.connection.stop()
    }

    @Test func taskNewWorksWhenListed() async throws {
        let rig = RelayConnectionTests.Rig()
        let desktop = await rig.desktop()
        desktop.features = [DesktopFeature.chatNew, DesktopFeature.taskNew]
        desktop.pairings[rig.phone.deviceId] = rig.phone.x25519.pub
        let connection = rig.factory.connection(for: rig.record(for: desktop))
        let events = EventRecorder(connection)
        await connection.start()
        try await events.waitFor { $0 == .features([DesktopFeature.chatNew, DesktopFeature.taskNew]) }
        try await events.waitFor(RelayConnectionTests.isInbox)

        let result = try await connection.newTask(projectId: "p", prompt: "Fix the login", mode: "plan")
        #expect(result == TaskNewResult(taskId: "task-new", tabId: "tab-new-1"))
        #expect(desktop.requests.last?.op == TaskOp.new)
        #expect(desktop.requests.last?.params == .object(["projectId": "p", "prompt": "Fix the login", "mode": "plan"]))
        await #expect(throws: DesktopConnectionError.remote(code: AppErrorCode.notFound, message: "No such project")) {
            _ = try await connection.newTask(projectId: "nope", prompt: "Go")
        }
        await connection.stop()
    }

    @Test func olderDesktopListsNoFeatures() async throws {
        let rig = RelayConnectionTests.Rig()
        let desktop = await rig.desktop()
        desktop.features = []
        desktop.pairings[rig.phone.deviceId] = rig.phone.x25519.pub
        let connection = rig.factory.connection(for: rig.record(for: desktop))
        let events = EventRecorder(connection)
        await connection.start()
        try await events.waitFor { $0 == .features([]) }
        try await events.waitFor(RelayConnectionTests.isInbox)
        await #expect(throws: DesktopConnectionError.remote(code: AppErrorCode.unsupported, message: "Unknown op chat.new")) {
            _ = try await connection.newChat(taskId: "t")
        }
        await connection.stop()
    }

    /// With a long backoff, a dropped relay socket comes back only when
    /// `reconnectNow()` cuts the wait short.
    @Test func reconnectNowSkipsTheBackoff() async throws {
        let relay = FakeRelay()
        let phone = DeviceIdentity.generate()
        let timing = RelayTiming(pingInterval: .seconds(30), initialBackoff: .seconds(20), maxBackoff: .seconds(30), handshakeTimeout: .seconds(5))
        let factory = RelayDesktopConnectionFactory(identity: phone, deviceName: "Test iPhone", appVersion: "ios/0.1.0",
                                                    connector: relay, timing: timing)
        let desktop = FakeRelay.Desktop(name: "desk")
        await relay.add(desktop)
        desktop.pairings[phone.deviceId] = phone.x25519.pub
        let connection = factory.connection(for: DesktopRecord(invite: desktop.invite, keysReference: "test"))
        let events = EventRecorder(connection)
        await connection.start()
        var i = try await events.waitFor(RelayConnectionTests.isInbox)
        #expect(await relay.connectionCount == 1)

        await relay.dropAll()
        i = try await events.waitFor(after: i, RelayConnectionTests.isState(.connecting))
        // Still sleeping out the 20 s backoff.
        try await Task.sleep(for: .milliseconds(150))
        #expect(await relay.connectionCount == 1)

        let clock = ContinuousClock()
        let started = clock.now
        await connection.reconnectNow()
        i = try await events.waitFor(after: i, timeout: .seconds(3), RelayConnectionTests.isState(.online))
        try await events.waitFor(after: i, RelayConnectionTests.isInbox)
        #expect(clock.now - started < .seconds(3))
        #expect(await relay.connectionCount == 2)

        // Online already: it only pings, no new socket.
        await connection.reconnectNow()
        try await Task.sleep(for: .milliseconds(100))
        #expect(await relay.connectionCount == 2)
        await connection.stop()
    }
}

/// `MockDesktopConnection`'s `chat.new` and features.
@Suite struct MockChatNewTests {
    @Test func addsAClaudeChatTab() async throws {
        let mock = MockDesktopConnection(desktopId: "d", desktopName: "desk", flipInterval: .seconds(60), streamStep: .milliseconds(1))
        let events = EventRecorder(mock)
        await mock.start()
        try await events.waitFor { $0 == .features([DesktopFeature.chatNew, DesktopFeature.taskNew, DesktopFeature.chatSettings]) }
        try await events.waitFor(RelayConnectionTests.isInbox)
        let tabId = try await mock.newChat(taskId: "t-auth")
        try await events.waitFor { event in
            guard case .inbox(let inbox) = event else { return false }
            let task = inbox.projects.flatMap(\.tasks).first { $0.id == "t-auth" }
            return task?.tabs.last?.id == tabId && task?.tabs.last?.type == .claudeChat
        }
        let opened = try await mock.openChat(tabId: tabId)
        #expect(opened.view.items.isEmpty)
        await #expect(throws: DesktopConnectionError.remote(code: AppErrorCode.notFound, message: "No such task")) {
            _ = try await mock.newChat(taskId: "missing")
        }
        await mock.stop()
    }

    @Test func addsATaskWhoseChatStartsOnThePrompt() async throws {
        let mock = MockDesktopConnection(desktopId: "d", desktopName: "desk", flipInterval: .seconds(60), streamStep: .milliseconds(1))
        let events = EventRecorder(mock)
        await mock.start()
        try await events.waitFor(RelayConnectionTests.isInbox)
        let result = try await mock.newTask(projectId: "p-api", prompt: "Add rate limiting\nto the login route", mode: "plan")
        try await events.waitFor { event in
            guard case .inbox(let inbox) = event else { return false }
            let task = inbox.projects.first { $0.id == "p-api" }?.tasks.last
            return task?.id == result.taskId && task?.name == "Add rate limiting" && task?.tabs.first?.id == result.tabId
        }
        let opened = try await mock.openChat(tabId: result.tabId)
        guard case .user(let text, _, _, _)? = opened.view.items.first?.content else {
            Issue.record("expected the prompt as the first item")
            return
        }
        #expect(text == "Add rate limiting\nto the login route")
        await #expect(throws: DesktopConnectionError.remote(code: AppErrorCode.notFound, message: "No such project")) {
            _ = try await mock.newTask(projectId: "missing", prompt: "Go")
        }
        await mock.stop()
    }
}

/// `CachedChat` and the chat cache stores (§8.3).
@Suite struct ChatCacheTests {
    static func view(tabId: String = "tab-1", items count: Int, hasEarlier: Bool = false) -> ChatView {
        ChatView(tabId: tabId, title: "Claude", status: ChatStatus(busy: true, process: .running, model: "m"),
                 items: (1...max(count, 1)).prefix(count).map { ChatItem(id: "i\($0)", .text(markdown: "Item \($0)", streaming: false)) },
                 hasEarlier: hasEarlier,
                 prompts: [ChatPrompt(id: "p", .permission(ChatPermission(toolName: "Bash", title: "Run", summary: "ls", canAlwaysAllow: false)))])
    }

    @Test func keepsTheLastWindow() {
        let long = CachedChat(desktopId: "d", view: Self.view(items: 75))
        #expect(long.view.items.count == CachedChat.window)
        #expect(long.view.items.first?.id == "i16")
        #expect(long.view.items.last?.id == "i75")
        #expect(long.view.hasEarlier)

        let short = CachedChat(desktopId: "d", view: Self.view(items: 3))
        #expect(short.view.items.count == 3)
        #expect(!short.view.hasEarlier)
    }

    @Test func roundTripsThroughJSON() throws {
        let chat = CachedChat(desktopId: "d", view: Self.view(items: 5, hasEarlier: true), savedAt: Date(unixMilliseconds: 1_790_000_000_123))
        let parsed = try CachedChat.parse(try JSONValue.parse(chat.json.jsonData))
        #expect(parsed == chat)
    }

    @Test func fileStore() throws {
        let directory = FileManager.default.temporaryDirectory.appending(path: "chat-cache-\(UUID().uuidString)", directoryHint: .isDirectory)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = FileChatCacheStore(directory: directory)
        #expect(store.load(desktopId: "d1", tabId: "tab-1") == nil)

        let a = CachedChat(desktopId: "d1", view: Self.view(tabId: "tab-1", items: 2), savedAt: Date(unixMilliseconds: 1))
        let b = CachedChat(desktopId: "d1", view: Self.view(tabId: "tab-2", items: 4), savedAt: Date(unixMilliseconds: 2))
        let c = CachedChat(desktopId: "d2", view: Self.view(tabId: "tab-1", items: 1), savedAt: Date(unixMilliseconds: 3))
        for chat in [a, b, c] { store.save(chat) }
        #expect(store.load(desktopId: "d1", tabId: "tab-1") == a)
        #expect(store.load(desktopId: "d1", tabId: "tab-2") == b)
        #expect(store.load(desktopId: "d2", tabId: "tab-1") == c)
        #expect(FileManager.default.fileExists(atPath: directory.appending(path: "d1/tab-2.json").path))

        // Overwrite.
        let a2 = CachedChat(desktopId: "d1", view: Self.view(tabId: "tab-1", items: 7), savedAt: Date(unixMilliseconds: 4))
        store.save(a2)
        #expect(store.load(desktopId: "d1", tabId: "tab-1") == a2)

        store.prune(desktopId: "d1", keeping: ["tab-2", "tab-9"])
        #expect(store.load(desktopId: "d1", tabId: "tab-1") == nil)
        #expect(store.load(desktopId: "d1", tabId: "tab-2") == b)
        #expect(store.load(desktopId: "d2", tabId: "tab-1") == c)

        store.deleteAll(desktopId: "d1")
        #expect(store.load(desktopId: "d1", tabId: "tab-2") == nil)
        #expect(store.load(desktopId: "d2", tabId: "tab-1") == c)

        // Path-unsafe IDs stay inside the directory.
        let odd = CachedChat(desktopId: "../x", view: Self.view(tabId: "a/../b", items: 1), savedAt: Date(unixMilliseconds: 5))
        store.save(odd)
        #expect(store.load(desktopId: "../x", tabId: "a/../b") == odd)
        #expect(!FileManager.default.fileExists(atPath: directory.deletingLastPathComponent().appending(path: "x").path))
    }

    @Test func inMemoryStore() {
        let a = CachedChat(desktopId: "d", view: Self.view(tabId: "tab-1", items: 1))
        let b = CachedChat(desktopId: "d", view: Self.view(tabId: "tab-2", items: 1))
        let store = InMemoryChatCacheStore([a])
        store.save(b)
        #expect(store.load(desktopId: "d", tabId: "tab-1") == a)
        store.prune(desktopId: "d", keeping: ["tab-2"])
        #expect(store.load(desktopId: "d", tabId: "tab-1") == nil)
        #expect(store.load(desktopId: "d", tabId: "tab-2") == b)
        store.deleteAll(desktopId: "d")
        #expect(store.load(desktopId: "d", tabId: "tab-2") == nil)
    }
}
