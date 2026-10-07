import Foundation
import Testing
@testable import DevToolKit

/// `stream.new` and `branches.list` samples in `protocol/vectors/chat-messages.json` (§8.12, §8.13).
@Suite struct StreamNewVectorTests {
    @Test func streamNewParamsAndResults() throws {
        let new = try #require(try Vectors.load("chat-messages.json")["streamNew"])
        #expect(!new["params"].array.isEmpty)
        for sample in new["params"].array {
            let parsed = try StreamNewParams.parse(try JSONValue.parse(sample["json"].str))
            #expect(parsed.json == sample["expected"], "\(sample["json"].str)")
        }
        #expect(!new["results"].array.isEmpty)
        for sample in new["results"].array {
            let parsed = try StreamNewResult.parse(try JSONValue.parse(sample["json"].str))
            #expect(parsed.json == sample["expected"], "\(sample["json"].str)")
        }
        for json in new["invalid"]["params"].array {
            #expect(throws: (any Error).self, "\(json.str)") { _ = try StreamNewParams.parse(try JSONValue.parse(json.str)) }
        }
        for json in new["invalid"]["results"].array {
            #expect(throws: (any Error).self, "\(json.str)") { _ = try StreamNewResult.parse(try JSONValue.parse(json.str)) }
        }
    }

    @Test func branchesListParamsAndResults() throws {
        let list = try #require(try Vectors.load("chat-messages.json")["branchesList"])
        #expect(!list["results"].array.isEmpty)
        for sample in list["results"].array {
            let parsed = try BranchesListResult.parse(try JSONValue.parse(sample["json"].str))
            #expect(parsed.json == sample["expected"], "\(sample["json"].str)")
        }
        for json in list["invalid"]["results"].array {
            #expect(throws: (any Error).self, "\(json.str)") { _ = try BranchesListResult.parse(try JSONValue.parse(json.str)) }
        }
        // `branches.list` params are just a project ID; the phone only builds them.
        for sample in list["params"].array {
            let projectId = try #require(try JSONValue.parse(sample["json"].str)["projectId"]?.stringValue)
            #expect(JSONValue.object(["projectId": .string(projectId)]) == sample["expected"])
        }
    }

    @Test func folderStreamsDropBranchFields() {
        let params = StreamNewParams(projectId: "p", name: "Docs", worktree: false, branch: "docs", baseBranch: "main")
        #expect(params.json == .object(["projectId": "p", "name": "Docs", "worktree": false]))
    }

    @Test func newOpsAreNotTabOps() throws {
        #expect(try ChatParams.parse(op: TaskOp.newStream, .object(["projectId": "p", "name": "x", "worktree": false])) == nil)
        #expect(try ChatParams.parse(op: "chat.new", .object(["taskId": "t1"])) == nil)
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
        #expect(!record.supports(DesktopFeature.streamNew))
        var updated = record
        updated.features = [DesktopFeature.streamNew]
        let decoded = try JSONDecoder().decode(DesktopRecord.self, from: try JSONEncoder().encode(updated))
        #expect(decoded.supports(DesktopFeature.streamNew))
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

/// `task.close` and `tab.close` samples in `protocol/vectors/chat-messages.json` (§8.7, §8.8).
@Suite struct TaskCloseVectorTests {
    @Test func paramsAndResults() throws {
        let file = try Vectors.load("chat-messages.json")
        let taskClose = try #require(file["taskClose"])
        #expect(!taskClose["params"].array.isEmpty && !taskClose["results"].array.isEmpty)
        for sample in taskClose["params"].array {
            let parsed = try TaskCloseParams.parse(try JSONValue.parse(sample["json"].str))
            #expect(parsed.json == sample["expected"], "\(sample["json"].str)")
        }
        for sample in taskClose["results"].array {
            let parsed = try TaskCloseResult.parse(try JSONValue.parse(sample["json"].str))
            #expect(parsed.json == sample["expected"], "\(sample["json"].str)")
        }
        for json in taskClose["invalid"]["params"].array {
            #expect(throws: (any Error).self, "\(json.str)") { _ = try TaskCloseParams.parse(try JSONValue.parse(json.str)) }
        }
        for json in taskClose["invalid"]["results"].array {
            #expect(throws: (any Error).self, "\(json.str)") { _ = try TaskCloseResult.parse(try JSONValue.parse(json.str)) }
        }
        // `tab.close` params are just a tab ID; the phone only builds them.
        let tabClose = try #require(file["tabClose"])
        for sample in tabClose["params"].array {
            let tabId = try #require(try JSONValue.parse(sample["json"].str)["tabId"]?.stringValue)
            #expect(JSONValue.object(["tabId": .string(tabId)]) == sample["expected"])
        }
    }

    @Test func pinSetParams() throws {
        let file = try Vectors.load("chat-messages.json")
        let pinSet = try #require(file["pinSet"])
        #expect(!pinSet["params"].array.isEmpty)
        for sample in pinSet["params"].array {
            let parsed = try PinSetParams.parse(try JSONValue.parse(sample["json"].str))
            #expect(parsed.json == sample["expected"], "\(sample["json"].str)")
        }
        for json in pinSet["invalid"]["params"].array {
            #expect(throws: (any Error).self, "\(json.str)") { _ = try PinSetParams.parse(try JSONValue.parse(json.str)) }
        }
    }

    @Test func taskTriageParams() throws {
        let file = try Vectors.load("chat-messages.json")
        let triage = try #require(file["taskTriage"])
        #expect(!triage["params"].array.isEmpty)
        for sample in triage["params"].array {
            let parsed = try TaskTriageParams.parse(try JSONValue.parse(sample["json"].str))
            #expect(parsed.json == sample["expected"], "\(sample["json"].str)")
        }
        for json in triage["invalid"]["params"].array {
            #expect(throws: (any Error).self, "\(json.str)") { _ = try TaskTriageParams.parse(try JSONValue.parse(json.str)) }
        }
    }

    @Test func blockersAreTheDesktopsQuestions() {
        #expect(TaskCloseBlocker.allCases == [.working, .unsaved])
    }
}

/// `features`, the M4 ops and `reconnectNow()` over `RelayDesktopConnection`.
@Suite(.serialized) struct M4ConnectionTests {
    static let isFeatures: @Sendable (DesktopConnectionEvent) -> Bool = {
        if case .features = $0 { return true }
        return false
    }

    @Test func featuresArriveBeforeOnline() async throws {
        let o = try await ChatConnectionTests.online()
        let events = await o.events.events
        let features = try #require(events.firstIndex { Self.isFeatures($0) })
        let online = try #require(events.firstIndex(of: .state(.online)))
        #expect(features < online)
        #expect(events[features] == .features([DesktopFeature.taskNew]))
        await o.connection.stop()
    }

    @Test func streamNewAndBranchesListWhenListed() async throws {
        let rig = RelayConnectionTests.Rig()
        let desktop = await rig.desktop()
        let features = [DesktopFeature.streamNew, DesktopFeature.branchesList]
        desktop.features = features
        desktop.pairings[rig.phone.deviceId] = rig.phone.x25519.pub
        let connection = rig.factory.connection(for: rig.record(for: desktop))
        let events = EventRecorder(connection)
        await connection.start()
        try await events.waitFor { $0 == .features(Set(features)) }
        try await events.waitFor(RelayConnectionTests.isInbox)

        let listed = try await connection.listBranches(projectId: "p")
        #expect(listed == BranchesListResult(branches: ["dev", "main"], defaultBase: "main"))
        #expect(desktop.requests.last?.op == TaskOp.listBranches)
        #expect(desktop.requests.last?.params == .object(["projectId": "p"]))
        await #expect(throws: DesktopConnectionError.remote(code: AppErrorCode.unsupported, message: "No worktrees")) {
            _ = try await connection.listBranches(projectId: "shell")
        }

        let streamId = try await connection.newStream(projectId: "p", name: "0.6.0", worktree: true, baseBranch: "main")
        #expect(streamId == "s-new-1")
        #expect(desktop.requests.last?.op == TaskOp.newStream)
        #expect(desktop.requests.last?.params == .object(["projectId": "p", "name": "0.6.0", "worktree": true, "baseBranch": "main"]))
        _ = try await connection.newStream(projectId: "p", name: "Docs", worktree: false, branch: "ignored")
        #expect(desktop.requests.last?.params == .object(["projectId": "p", "name": "Docs", "worktree": false]))
        await #expect(throws: DesktopConnectionError.remote(code: AppErrorCode.notFound, message: "No such project")) {
            _ = try await connection.newStream(projectId: "nope", name: "x", worktree: false)
        }
        await connection.stop()
    }

    @Test func taskNewWorksWhenListed() async throws {
        let rig = RelayConnectionTests.Rig()
        let desktop = await rig.desktop()
        desktop.features = [DesktopFeature.taskNew]
        desktop.pairings[rig.phone.deviceId] = rig.phone.x25519.pub
        let connection = rig.factory.connection(for: rig.record(for: desktop))
        let events = EventRecorder(connection)
        await connection.start()
        try await events.waitFor { $0 == .features([DesktopFeature.taskNew]) }
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

    @Test func streamAndCloseOpsWhenListed() async throws {
        let rig = RelayConnectionTests.Rig()
        let desktop = await rig.desktop()
        let features = [DesktopFeature.taskNew, DesktopFeature.taskClose, DesktopFeature.tabClose]
        desktop.features = features
        desktop.pairings[rig.phone.deviceId] = rig.phone.x25519.pub
        let connection = rig.factory.connection(for: rig.record(for: desktop))
        let events = EventRecorder(connection)
        await connection.start()
        try await events.waitFor { $0 == .features(Set(features)) }
        try await events.waitFor(RelayConnectionTests.isInbox)

        _ = try await connection.newTask(projectId: "p", streamId: "s-050", prompt: "Fix the login")
        #expect(desktop.requests.last?.params == .object(["projectId": "p", "streamId": "s-050", "prompt": "Fix the login"]))

        let blocked = try await connection.closeTask(TaskCloseParams(taskId: "t"))
        #expect(blocked == .blocked(.working))
        #expect(desktop.requests.last?.params == .object(["taskId": "t"]))
        let closed = try await connection.closeTask(TaskCloseParams(taskId: "t", stopWorking: true, discardUnsaved: true))
        #expect(closed == .closed)
        #expect(desktop.requests.last?.params == .object(["taskId": "t", "stopWorking": true, "discardUnsaved": true]))

        try await connection.closeTab(tabId: "tab-chat")
        #expect(desktop.requests.last?.op == TaskOp.closeTab)
        #expect(desktop.closedTabs == ["tab-chat"])
        await connection.stop()
    }

    @Test func pinSetWhenListed() async throws {
        let rig = RelayConnectionTests.Rig()
        let desktop = await rig.desktop()
        desktop.features = [DesktopFeature.pin]
        desktop.pairings[rig.phone.deviceId] = rig.phone.x25519.pub
        let connection = rig.factory.connection(for: rig.record(for: desktop))
        let events = EventRecorder(connection)
        await connection.start()
        try await events.waitFor { $0 == .features([DesktopFeature.pin]) }
        try await events.waitFor(RelayConnectionTests.isInbox)

        try await connection.setPin(InboxPin(projectId: "p", taskId: "t"), pinned: true)
        #expect(desktop.requests.last?.op == TaskOp.setPin)
        #expect(desktop.requests.last?.params == .object(["projectId": "p", "taskId": "t", "pinned": true]))
        try await connection.setPin(InboxPin(projectId: "p"), pinned: false)
        #expect(desktop.pinSetParams == [
            PinSetParams(pin: InboxPin(projectId: "p", taskId: "t"), pinned: true),
            PinSetParams(pin: InboxPin(projectId: "p"), pinned: false),
        ])
        await connection.stop()
    }

    @Test func taskTriageWhenListed() async throws {
        let rig = RelayConnectionTests.Rig()
        let desktop = await rig.desktop()
        desktop.features = [DesktopFeature.taskTriage]
        desktop.pairings[rig.phone.deviceId] = rig.phone.x25519.pub
        let connection = rig.factory.connection(for: rig.record(for: desktop))
        let events = EventRecorder(connection)
        await connection.start()
        try await events.waitFor { $0 == .features([DesktopFeature.taskTriage]) }
        try await events.waitFor(RelayConnectionTests.isInbox)

        try await connection.triage(taskId: "t", .snooze(until: 1_790_003_600_000))
        #expect(desktop.requests.last?.op == TaskOp.triage)
        #expect(desktop.requests.last?.params == .object(["taskId": "t", "action": "snooze", "until": .int(1_790_003_600_000)]))
        try await connection.triage(taskId: "t", .snoozeUntilAttention)
        try await connection.triage(taskId: "t", .read)
        #expect(desktop.taskTriageParams == [
            TaskTriageParams(taskId: "t", action: .snooze(until: 1_790_003_600_000)),
            TaskTriageParams(taskId: "t", action: .snoozeUntilAttention),
            TaskTriageParams(taskId: "t", action: .read),
        ])
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
        await #expect(throws: DesktopConnectionError.remote(code: AppErrorCode.unsupported, message: "Unknown op stream.new")) {
            _ = try await connection.newStream(projectId: "p", name: "x", worktree: false)
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

/// `MockDesktopConnection`'s M4 ops and features.
@Suite struct MockM4Tests {
    @Test func listsFeaturesAndMakesStreams() async throws {
        let mock = MockDesktopConnection(desktopId: "d", desktopName: "desk", flipInterval: .seconds(60), streamStep: .milliseconds(1))
        let events = EventRecorder(mock)
        await mock.start()
        try await events.waitFor { $0 == .features([
            DesktopFeature.taskNew, DesktopFeature.chatSettings,
            DesktopFeature.taskClose, DesktopFeature.tabClose, DesktopFeature.chatImage,
            DesktopFeature.pin, DesktopFeature.taskTriage,
            DesktopFeature.streamNew, DesktopFeature.branchesList,
        ]) }
        try await events.waitFor(RelayConnectionTests.isInbox)
        let listed = try await mock.listBranches(projectId: "p-api")
        #expect(listed.defaultBase == "main")
        #expect(listed.branches.first == "main" && listed.branches.contains("0.5.0"))

        let streamId = try await mock.newStream(projectId: "p-api", name: "Chapter 2", worktree: true)
        try await events.waitFor { event in
            guard case .inbox(let inbox) = event else { return false }
            let stream = inbox.projects.first { $0.id == "p-api" }?.streams.last
            return stream == InboxStream(id: streamId, name: "Chapter 2", branch: "chapter-2")
        }
        #expect(try await mock.listBranches(projectId: "p-api").branches.last == "chapter-2")
        let folder = try await mock.newStream(projectId: "p-web", name: "Docs", worktree: false)
        try await events.waitFor { event in
            guard case .inbox(let inbox) = event else { return false }
            return inbox.projects.first { $0.id == "p-web" }?.streams.last == InboxStream(id: folder, name: "Docs")
        }
        await #expect(throws: DesktopConnectionError.remote(code: AppErrorCode.internal, message: "Branch \"0.5.0\" already exists")) {
            _ = try await mock.newStream(projectId: "p-api", name: "0.5.0", worktree: true)
        }
        await #expect(throws: DesktopConnectionError.remote(code: AppErrorCode.notFound, message: "No such project")) {
            _ = try await mock.listBranches(projectId: "missing")
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
            // No stream named: the one last used (0.5.0), after its last task.
            let project = inbox.projects.first { $0.id == "p-api" }
            let task = project?.tasks.first { $0.id == result.taskId }
            return task?.name == "Add rate limiting" && task?.tabs.first?.id == result.tabId
                && task?.streamId == "s-api-050" && project?.tasks(in: project!.streams[1]).last?.id == result.taskId
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
        await #expect(throws: DesktopConnectionError.remote(code: AppErrorCode.notFound, message: "No such stream")) {
            _ = try await mock.newTask(projectId: "p-api", streamId: "archived", prompt: "Go")
        }
        // A named stream becomes the project's last used one.
        let bug = try await mock.newTask(projectId: "p-api", streamId: "s-api-bugs", prompt: "Fix flake")
        try await events.waitFor { event in
            guard case .inbox(let inbox) = event else { return false }
            let project = inbox.projects.first { $0.id == "p-api" }
            return project?.lastStreamId == "s-api-bugs" && project?.tasks.last?.id == bug.taskId
        }
        await mock.stop()
    }
}

/// `MockDesktopConnection`'s closing (§8.7, §8.8).
@Suite struct MockCloseTests {
    @Test func workingTaskAsksBeforeItArchives() async throws {
        let mock = MockDesktopConnection(desktopId: "d", desktopName: "desk", flipInterval: .seconds(60), streamStep: .milliseconds(1))
        let events = EventRecorder(mock)
        await mock.start()
        try await events.waitFor(RelayConnectionTests.isInbox)
        // rate-limiter's Claude Code tab is working.
        let blocked = try await mock.closeTask(TaskCloseParams(taskId: "t-rate"))
        #expect(blocked == .blocked(.working))
        #expect(try await mock.closeTask(TaskCloseParams(taskId: "t-rate", stopWorking: true)) == .closed)
        try await events.waitFor { event in
            guard case .inbox(let inbox) = event else { return false }
            return !inbox.projects.flatMap(\.tasks).contains { $0.id == "t-rate" }
        }
        await mock.stop()
    }

    @Test func closesATabAndKeepsTheTask() async throws {
        let mock = MockDesktopConnection(desktopId: "d", desktopName: "desk", flipInterval: .seconds(60), streamStep: .milliseconds(1))
        let events = EventRecorder(mock)
        await mock.start()
        try await events.waitFor(RelayConnectionTests.isInbox)
        let tabId = "tab-2"
        try await mock.closeTab(tabId: tabId)
        try await events.waitFor { event in
            guard case .inbox(let inbox) = event else { return false }
            let task = inbox.projects.flatMap(\.tasks).first { $0.id == "t-auth" }
            return task != nil && !(task?.tabs.contains { $0.id == tabId } ?? true)
        }
        await #expect(throws: DesktopConnectionError.remote(code: AppErrorCode.notFound, message: "No such tab")) {
            try await mock.closeTab(tabId: tabId)
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
