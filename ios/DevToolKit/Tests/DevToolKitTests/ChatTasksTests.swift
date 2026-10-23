import Foundation
import Testing
@testable import DevToolKit

/// The chat's task list (§8.20): `tasks` in the view and `chat.task.stop`.
@Suite struct ChatTasksTests {
    @Test func taskStopVectors() throws {
        let stop = try #require(try Vectors.load("chat-messages.json")["taskStop"])
        #expect(!stop["params"].array.isEmpty && !stop["invalid"]["params"].array.isEmpty)
        for sample in stop["params"].array {
            let parsed = try ChatTaskStopParams.parse(try JSONValue.parse(sample["json"].str))
            #expect(parsed.json == sample["expected"], "\(sample["json"].str)")
        }
        for json in stop["invalid"]["params"].array {
            #expect(throws: (any Error).self, "\(json.str)") { _ = try ChatTaskStopParams.parse(try JSONValue.parse(json.str)) }
        }
    }

    @Test func eventVectorsCarryTasks() throws {
        let events = try Vectors.load("chat-messages.json")["events"].array
        let parsed = try events.compactMap { sample -> ChatEvent? in
            guard case .chat(let event)? = try AppMessage.parse(Data(sample["json"].str.utf8)) else { return nil }
            return event
        }
        let withTasks = try #require(parsed.first { $0.status.tasks.count == 3 })
        let workflow = try #require(withTasks.status.tasks.first?.workflow)
        #expect(workflow.phases.map(\.started) == [true, true, false])
        #expect(workflow.agents.map(\.state) == [.done, .failed, .running, .queued])
        #expect(workflow.moreAgents == 12)
        #expect(withTasks.status.tasks.map(\.kind) == [.workflow, .subagent, .shell])

        let unknown = try #require(parsed.first { $0.status.tasks.first?.id == "c1" })
        #expect(unknown.status.tasks[0].kind == .other && unknown.status.tasks[0].status == .running)
        #expect(!unknown.status.tasks[0].background && unknown.status.tasks[0].command == nil)
        #expect(unknown.status.tasks[1].workflow?.agents.first?.state == .running)
        #expect(unknown.status.tasks[1].workflow?.moreAgents == 0)
    }

    @Test func listsWhatThePillListsAndCountsLikeTheDesktop() {
        let now: Int64 = 1_000_000
        let tasks = [
            ChatTask(id: "a1", kind: .subagent, description: "Look", startedAt: now - 5000),
            ChatTask(id: "a2", kind: .subagent, description: "Look again", startedAt: now - 4000),
            ChatTask(id: "s1", kind: .shell, description: "Dev", status: .completed, startedAt: now - 9000, endedAt: now - 59_000),
            ChatTask(id: "s2", kind: .shell, description: "Old", status: .failed, startedAt: now - 99_000, endedAt: now - 60_000),
            ChatTask(id: "s3", kind: .shell, description: "No end", status: .stopped),
        ]
        #expect(ChatTasks.visible(tasks, now: now).map(\.id) == ["a1", "a2", "s1"])
        #expect(ChatTasks.countLabel(Array(tasks.prefix(3))) == "2 agents · 1 shell")
        #expect(ChatTasks.countLabel([ChatTask(id: "w", kind: .workflow, description: "w")]) == "1 workflow")
        #expect(ChatTasks.elapsed(ms: 12_400) == "12s")
        #expect(ChatTasks.elapsed(ms: 65_000) == "1m 5s")
        #expect(ChatTasks.elapsed(ms: 3_720_000) == "1h 2m")
        #expect(ChatTasks.tokens(950) == "950")
        #expect(ChatTasks.tokens(48_400) == "48k")
        #expect(ChatTasks.tokens(1_340_000) == "1.3M")
        #expect(ChatTasks.tokens(2_000_000) == "2M")
    }

    @Test func summarizesAWorkflowAsTheDesktopRowDoes() {
        var workflow = ChatWorkflow(
            phases: [ChatWorkflowPhase(title: "Review", started: true), ChatWorkflowPhase(title: "Verify", started: true), ChatWorkflowPhase(title: "Report")],
            agents: [
                ChatWorkflowAgent(label: "bugs", phase: 0, state: .done),
                ChatWorkflowAgent(label: "perf", phase: 0, state: .failed),
                ChatWorkflowAgent(label: "verify", phase: 1, state: .running),
                ChatWorkflowAgent(label: "verify-2", phase: 1, state: .queued),
                ChatWorkflowAgent(label: "stray", phase: 7, state: .skipped),
            ]
        )
        #expect(workflow.phaseLabel == "Phase 2 of 3 · Verify")
        #expect(workflow.agentsLabel == "2 of 5 agents done · 1 failed")
        #expect(workflow.looseAgents.map(\.label) == ["stray"])
        // Agents left out past the cap were finished ones.
        workflow.moreAgents = 10
        #expect(workflow.agentsLabel == "12 of 15 agents done · 1 failed")
        // Nothing going: the latest phase reached.
        workflow.agents = [ChatWorkflowAgent(label: "bugs", phase: 0, state: .done)]
        workflow.moreAgents = 0
        #expect(workflow.currentPhase == 1)
        #expect(ChatWorkflow(phases: [ChatWorkflowPhase(title: "Only", started: true)]).phaseLabel == "Only")
        #expect(ChatWorkflow().phaseLabel == nil && ChatWorkflow().agentsLabel == nil)
    }

    @Test func mockDesktopListsAndStopsTasks() async throws {
        let mock = MockDesktopConnection(desktopId: "m", desktopName: "mock", streamStep: .milliseconds(5))
        let events = EventRecorder(mock)
        await mock.start()
        try await events.waitFor { if case .features(let features) = $0 { features.contains(DesktopFeature.chatTasks) } else { false } }
        try await events.waitFor { $0 == .state(.online) }
        let open = try await mock.openChat(tabId: "tab-1")
        #expect(open.view.status.tasks.map(\.id) == ["wf-review", "agent-callers", "shell-dev"])
        #expect(open.view.status.tasks.first?.workflow?.phases.count == 3)

        try await mock.stopChatTask(tabId: "tab-1", taskId: "shell-dev")
        let after = try await mock.openChat(tabId: "tab-1")
        let shell = try #require(after.view.status.tasks.first { $0.id == "shell-dev" })
        #expect(shell.status == .stopped && shell.endedAt != nil)
        // Stopping it again does nothing; an unknown task is not found.
        try await mock.stopChatTask(tabId: "tab-1", taskId: "shell-dev")
        await #expect(throws: DesktopConnectionError.self) { try await mock.stopChatTask(tabId: "tab-1", taskId: "nope") }
    }
}
