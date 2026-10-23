import Foundation

// What Claude runs beside the turn (§8.20): the chat view's `tasks`, and
// `chat.task.stop`, behind feature `chat.tasks`.

public enum ChatTaskKind: String, Sendable, Hashable, CaseIterable {
    case subagent, shell, workflow, monitor, mcp, other

    /// Unknown kinds read as `other`.
    init(wire: String) { self = ChatTaskKind(rawValue: wire) ?? .other }

    /// "agent" / "agents", as the desktop pill counts them.
    public func noun(_ count: Int) -> String {
        let (one, many) = switch self {
        case .subagent: ("agent", "agents")
        case .shell: ("shell", "shells")
        case .workflow: ("workflow", "workflows")
        case .monitor: ("monitor", "monitors")
        case .mcp: ("MCP task", "MCP tasks")
        case .other: ("task", "tasks")
        }
        return count == 1 ? one : many
    }
}

public enum ChatTaskStatus: String, Sendable, Hashable {
    case running, completed, failed, stopped

    /// Unknown statuses read as `running`.
    init(wire: String) { self = ChatTaskStatus(rawValue: wire) ?? .running }
}

public enum ChatWorkflowAgentState: String, Sendable, Hashable {
    case queued, running, done, failed, skipped

    /// Unknown states read as `running`.
    init(wire: String) { self = ChatWorkflowAgentState(rawValue: wire) ?? .running }
}

public struct ChatWorkflowPhase: Sendable, Equatable {
    public var title: String
    public var detail: String?
    /// Reached by the run; a declared phase ahead of it is false.
    public var started: Bool

    public init(title: String, detail: String? = nil, started: Bool = false) {
        self.title = title
        self.detail = detail
        self.started = started
    }
}

public struct ChatWorkflowAgent: Sendable, Equatable {
    public var label: String
    /// Index into the workflow's `phases`.
    public var phase: Int?
    public var state: ChatWorkflowAgentState
    /// Unix ms.
    public var startedAt: Int64?
    public var durationMs: Int64?
    public var tokens: Int64?
    public var lastTool: String?
    /// Above 1 when the script retried it.
    public var attempt: Int?

    public init(label: String, phase: Int? = nil, state: ChatWorkflowAgentState, startedAt: Int64? = nil,
                durationMs: Int64? = nil, tokens: Int64? = nil, lastTool: String? = nil, attempt: Int? = nil) {
        self.label = label
        self.phase = phase
        self.state = state
        self.startedAt = startedAt
        self.durationMs = durationMs
        self.tokens = tokens
        self.lastTool = lastTool
        self.attempt = attempt
    }
}

public struct ChatWorkflow: Sendable, Equatable {
    public var phases: [ChatWorkflowPhase]
    public var agents: [ChatWorkflowAgent]
    /// Agents the desktop left out past its cap (finished ones first).
    public var moreAgents: Int

    public init(phases: [ChatWorkflowPhase] = [], agents: [ChatWorkflowAgent] = [], moreAgents: Int = 0) {
        self.phases = phases
        self.agents = agents
        self.moreAgents = moreAgents
    }

    public struct Counts: Sendable, Equatable {
        public var total = 0
        public var done = 0
        public var failed = 0
        public var running = 0
        public var queued = 0
    }

    /// Done counts skipped agents too. `moreAgents` were all left out as finished.
    public static func counts(_ agents: [ChatWorkflowAgent], more: Int = 0) -> Counts {
        var counts = Counts(total: agents.count + more, done: more)
        for agent in agents {
            switch agent.state {
            case .done, .skipped: counts.done += 1
            case .failed: counts.failed += 1
            case .running: counts.running += 1
            case .queued: counts.queued += 1
            }
        }
        return counts
    }

    public var counts: Counts { Self.counts(agents, more: moreAgents) }

    /// The agents of phase `index`.
    public func agents(inPhase index: Int) -> [ChatWorkflowAgent] {
        agents.filter { $0.phase == index }
    }

    /// Agents with no phase, or one outside `phases`.
    public var looseAgents: [ChatWorkflowAgent] {
        agents.filter { agent in agent.phase.map { $0 < 0 || $0 >= phases.count } ?? true }
    }

    /// The phase the run is in: the latest with agents still going, else the latest reached.
    public var currentPhase: Int? {
        let started = phases.indices.filter { phases[$0].started }
        let busy = started.filter { index in agents(inPhase: index).contains { $0.state == .running || $0.state == .queued } }
        return busy.last ?? started.last
    }

    /// "Phase 2 of 3 · Verify", or the title alone for a one-phase run.
    public var phaseLabel: String? {
        guard let index = currentPhase else { return nil }
        return phases.count > 1 ? "Phase \(index + 1) of \(phases.count) · \(phases[index].title)" : phases[index].title
    }

    /// "5 of 12 agents done · 1 failed".
    public var agentsLabel: String? {
        let counts = counts
        guard counts.total > 0 else { return nil }
        var label = "\(counts.done) of \(counts.total) \(counts.total == 1 ? "agent" : "agents") done"
        if counts.failed > 0 { label += " · \(counts.failed) failed" }
        return label
    }
}

/// One row of the task list (§8.20).
public struct ChatTask: Sendable, Equatable, Identifiable {
    public var id: String
    public var kind: ChatTaskKind
    public var description: String
    public var status: ChatTaskStatus
    /// Unix ms.
    public var startedAt: Int64?
    public var endedAt: Int64?
    public var background: Bool
    public var command: String?
    public var agentType: String?
    /// One line: the task's own summary, or the tool it is running.
    public var detail: String?
    public var toolUses: Int64?
    public var tokens: Int64?
    public var workflow: ChatWorkflow?

    public init(id: String, kind: ChatTaskKind, description: String, status: ChatTaskStatus = .running,
                startedAt: Int64? = nil, endedAt: Int64? = nil, background: Bool = false, command: String? = nil,
                agentType: String? = nil, detail: String? = nil, toolUses: Int64? = nil, tokens: Int64? = nil,
                workflow: ChatWorkflow? = nil) {
        self.id = id
        self.kind = kind
        self.description = description
        self.status = status
        self.startedAt = startedAt
        self.endedAt = endedAt
        self.background = background
        self.command = command
        self.agentType = agentType
        self.detail = detail
        self.toolUses = toolUses
        self.tokens = tokens
        self.workflow = workflow
    }

    public var running: Bool { status == .running }
}

/// The task pill's rules, as the desktop's TaskIndicator.
public enum ChatTasks {
    /// How long a finished task stays listed, after its `endedAt`.
    public static let lingerMs: Int64 = 60_000

    /// Running tasks, and finished ones still inside the linger at `now` (unix ms).
    public static func visible(_ tasks: [ChatTask], now: Int64) -> [ChatTask] {
        tasks.filter { task in
            task.running || task.endedAt.map { now - $0 < lingerMs } ?? false
        }
    }

    /// "2 agents · 1 shell", in the desktop's kind order.
    public static func countLabel(_ tasks: [ChatTask]) -> String {
        ChatTaskKind.allCases.compactMap { kind in
            let count = tasks.filter { $0.kind == kind }.count
            return count > 0 ? "\(count) \(kind.noun(count))" : nil
        }.joined(separator: " · ")
    }

    /// "12s", "4m 5s", "1h 2m".
    public static func elapsed(ms: Int64) -> String {
        let seconds = max(0, ms / 1000)
        if seconds < 60 { return "\(seconds)s" }
        let minutes = seconds / 60
        if minutes < 60 { return "\(minutes)m \(seconds % 60)s" }
        return "\(minutes / 60)h \(minutes % 60)m"
    }

    /// "950", "48k", "1.3M", "2M", as the desktop's formatTokens.
    public static func tokens(_ count: Int64) -> String {
        if count >= 1_000_000 {
            return count % 1_000_000 == 0 ? "\(count / 1_000_000)M" : String(format: "%.1fM", Double(count) / 1_000_000)
        }
        if count >= 1000 { return "\(Int((Double(count) / 1000).rounded()))k" }
        return "\(count)"
    }
}

/// `chat.task.stop` params.
public struct ChatTaskStopParams: Sendable, Equatable {
    public var tabId: String
    public var taskId: String

    public init(tabId: String, taskId: String) {
        self.tabId = tabId
        self.taskId = taskId
    }
}

// MARK: - Parsing

extension ChatWorkflow {
    static func parse(_ value: JSONValue?) throws(ProtocolError) -> ChatWorkflow {
        let f = try Fields(value, "workflow")
        let phases = try f.array("phases").map { (v) throws(ProtocolError) -> ChatWorkflowPhase in
            let p = try Fields(v, "phase")
            return ChatWorkflowPhase(title: try p.str("title"), detail: try p.optStr("detail"), started: p.flag("started"))
        }
        let agents = try f.array("agents").map { (v) throws(ProtocolError) -> ChatWorkflowAgent in
            let a = try Fields(v, "agent")
            return ChatWorkflowAgent(
                label: try a.str("label"),
                phase: try a.optInt("phase").map { Int($0) },
                state: ChatWorkflowAgentState(wire: try a.str("state")),
                startedAt: try a.optInt("startedAt"),
                durationMs: try a.optInt("durationMs"),
                tokens: try a.optInt("tokens"),
                lastTool: try a.optStr("lastTool"),
                attempt: try a.optInt("attempt").map { Int($0) }
            )
        }
        return ChatWorkflow(phases: phases, agents: agents, moreAgents: Int(try f.optInt("moreAgents") ?? 0))
    }

    var json: JSONValue {
        var o: JSONObject = [
            "phases": .array(phases.map { phase in
                var p: JSONObject = ["title": .string(phase.title)]
                if let detail = phase.detail { p["detail"] = .string(detail) }
                if phase.started { p["started"] = .bool(true) }
                return .object(p)
            }),
            "agents": .array(agents.map { agent in
                var a: JSONObject = ["label": .string(agent.label), "state": .string(agent.state.rawValue)]
                if let phase = agent.phase { a["phase"] = .int(Int64(phase)) }
                if let startedAt = agent.startedAt { a["startedAt"] = .int(startedAt) }
                if let durationMs = agent.durationMs { a["durationMs"] = .int(durationMs) }
                if let tokens = agent.tokens { a["tokens"] = .int(tokens) }
                if let lastTool = agent.lastTool { a["lastTool"] = .string(lastTool) }
                if let attempt = agent.attempt { a["attempt"] = .int(Int64(attempt)) }
                return .object(a)
            }),
        ]
        if moreAgents > 0 { o["moreAgents"] = .int(Int64(moreAgents)) }
        return .object(o)
    }
}

extension ChatTask {
    /// Unknown `kind`, `status` and agent `state` values read as `other`, `running`, `running`.
    static func parse(_ value: JSONValue) throws(ProtocolError) -> ChatTask {
        let f = try Fields(value, "task")
        return ChatTask(
            id: try f.str("id"),
            kind: ChatTaskKind(wire: try f.str("kind")),
            description: try f.str("description"),
            status: ChatTaskStatus(wire: try f.str("status")),
            startedAt: try f.optInt("startedAt"),
            endedAt: try f.optInt("endedAt"),
            background: f.flag("background"),
            command: try f.optStr("command"),
            agentType: try f.optStr("agentType"),
            detail: try f.optStr("detail"),
            toolUses: try f.optInt("toolUses"),
            tokens: try f.optInt("tokens"),
            workflow: f.isUnset("workflow") ? nil : try ChatWorkflow.parse(f["workflow"])
        )
    }

    var json: JSONValue {
        var o: JSONObject = [
            "id": .string(id), "kind": .string(kind.rawValue), "description": .string(description), "status": .string(status.rawValue),
        ]
        if let startedAt { o["startedAt"] = .int(startedAt) }
        if let endedAt { o["endedAt"] = .int(endedAt) }
        if background { o["background"] = .bool(true) }
        if let command { o["command"] = .string(command) }
        if let agentType { o["agentType"] = .string(agentType) }
        if let detail { o["detail"] = .string(detail) }
        if let toolUses { o["toolUses"] = .int(toolUses) }
        if let tokens { o["tokens"] = .int(tokens) }
        if let workflow { o["workflow"] = workflow.json }
        return .object(o)
    }
}

extension ChatTaskStopParams {
    /// The desktop's side: a missing `tabId` or `taskId` throws (`bad-request`).
    public static func parse(_ value: JSONValue?) throws(ProtocolError) -> ChatTaskStopParams {
        let o = try Fields(value, "params")
        return ChatTaskStopParams(tabId: try o.str("tabId"), taskId: try o.str("taskId"))
    }

    public var json: JSONValue { .object(["tabId": .string(tabId), "taskId": .string(taskId)]) }
}
