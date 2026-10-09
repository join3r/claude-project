import Foundation

/// A task's landing into its stream (§4.4 `landing`, protocol version 3): a
/// task with a worktree of its own (`InboxTask.branch`) lands on close, and a
/// landing that stops leaves the task open with this state. A port of
/// `TaskLanding` in `protocol/ts/chat-messages.ts`.
public struct TaskLanding: Codable, Sendable, Equatable {
    public enum State: Sendable, Hashable, Codable {
        /// Running.
        case landing
        /// The rebase onto the stream stopped in the task's worktree.
        case conflict
        /// The stream's worktree refused the fast-forward (local changes).
        case blocked
        /// The task's agent was asked to resolve the conflict.
        case fixing
        /// A newer desktop's state: shown without actions.
        case unknown(String)

        public init(rawValue: String) {
            switch rawValue {
            case "landing": self = .landing
            case "conflict": self = .conflict
            case "blocked": self = .blocked
            case "fixing": self = .fixing
            default: self = .unknown(rawValue)
            }
        }

        public var rawValue: String {
            switch self {
            case .landing: "landing"
            case .conflict: "conflict"
            case .blocked: "blocked"
            case .fixing: "fixing"
            case .unknown(let raw): raw
            }
        }

        public init(from decoder: any Decoder) throws {
            self = State(rawValue: try decoder.singleValueContainer().decode(String.self))
        }

        public func encode(to encoder: any Encoder) throws {
            var c = encoder.singleValueContainer()
            try c.encode(rawValue)
        }
    }

    /// What the landing was asked for; nil means `close`.
    public enum Intent: String, Sendable, Codable, CaseIterable {
        /// The task goes to Done once it lands.
        case close
        /// It lands and stays open.
        case land
        /// Rebase onto the stream only (the desktop's Update from stream).
        case update
    }

    public var state: State
    public var intent: Intent?
    /// The conflicted files, or the stream's files in the way (`blocked`): the first 20.
    public var files: [String]
    /// How many files there are in all.
    public var fileCount: Int?
    /// Git's reason (`blocked`).
    public var message: String?

    public init(state: State, intent: Intent? = nil, files: [String] = [], fileCount: Int? = nil, message: String? = nil) {
        self.state = state
        self.intent = intent
        self.files = files
        self.fileCount = fileCount
        self.message = message
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        state = try c.decode(State.self, forKey: .state)
        intent = (try? c.decodeIfPresent(Intent.self, forKey: .intent)) ?? nil
        files = try c.decodeIfPresent([String].self, forKey: .files) ?? []
        fileCount = try c.decodeIfPresent(Int.self, forKey: .fileCount)
        message = try c.decodeIfPresent(String.self, forKey: .message)
    }

    /// Every file, counted, even past the 20 listed.
    public var count: Int { max(fileCount ?? files.count, files.count) }

    /// Waits for the user (the desktop's `landingNeedsYou`): Your turn in the Inbox.
    public var needsYou: Bool { state == .conflict || state == .blocked }

    /// The desktop's line for it (`landingStatusLabel`), as a sentence:
    /// "Conflicts with 0.5.0 in 2 files", "Landing into 0.5.0…".
    public func label(streamName: String) -> String {
        let inFiles = count == 0 ? "" : count == 1 ? " in 1 file" : " in \(count) files"
        switch state {
        case .landing: return intent == .update ? "Updating from \(streamName)…" : "Landing into \(streamName)…"
        case .conflict: return "Conflicts with \(streamName)\(inFiles)"
        case .fixing: return "Agent fixing conflicts with \(streamName)…"
        case .blocked: return count > 0 ? "\(streamName) has local changes\(inFiles)" : "Can't land into \(streamName)"
        case .unknown: return "Landing into \(streamName)"
        }
    }

    /// The row badge: "landing…", "fixing…", "conflict", "blocked".
    public var badge: String {
        switch state {
        case .landing: intent == .update ? "updating…" : "landing…"
        case .fixing: "fixing…"
        case .conflict: "conflict"
        case .blocked: "blocked"
        case .unknown(let raw): raw
        }
    }
}

extension TaskLanding {
    /// Like `parseTaskLanding` in TS: `state` is kept as sent, an unknown
    /// `intent` is dropped, an empty `files` is absent.
    public static func parse(_ value: JSONValue?) throws(ProtocolError) -> TaskLanding {
        let o = try Fields(value, "landing")
        let intent = try o.optStr("intent").flatMap(Intent.init(rawValue:))
        let files = o.isUnset("files") ? [] : try o.strings("files")
        return TaskLanding(
            state: State(rawValue: try o.str("state")),
            intent: intent,
            files: files,
            fileCount: try o.optInt("fileCount").map { Int($0) },
            message: try o.optStr("message")
        )
    }

    /// Wire JSON, in the TS key order.
    public var json: JSONValue {
        var o: JSONObject = ["state": .string(state.rawValue)]
        if let intent { o["intent"] = .string(intent.rawValue) }
        if !files.isEmpty { o["files"] = .array(files.map(JSONValue.string)) }
        if let fileCount { o["fileCount"] = .int(Int64(fileCount)) }
        if let message { o["message"] = .string(message) }
        return .object(o)
    }
}

/// `task.land` (§8.15) params: a stopped landing's buttons.
public struct TaskLandParams: Sendable, Equatable {
    public enum Action: String, Sendable, CaseIterable {
        /// Ask the task's agent to resolve the conflict and continue.
        case fixWithAgent = "fix-with-agent"
        /// Undo the stopped rebase; the task stays open.
        case abort
        /// Pick the landing up again.
        case retry
    }

    public var taskId: String
    public var action: Action

    public init(taskId: String, action: Action) {
        self.taskId = taskId
        self.action = action
    }

    /// The desktop's side: a missing `taskId` or an unknown `action` throws (`bad-request`).
    public static func parse(_ value: JSONValue?) throws(ProtocolError) -> TaskLandParams {
        let o = try Fields(value, "params")
        let taskId = try o.str("taskId")
        let raw = try o.str("action")
        guard let action = Action(rawValue: raw) else { throw ProtocolError("unknown action \(raw)") }
        return TaskLandParams(taskId: taskId, action: action)
    }

    public var json: JSONValue {
        .object(["taskId": .string(taskId), "action": .string(action.rawValue)])
    }
}

/// `task.land` result: what came of it. The task's new state also arrives in
/// the next inbox.
public struct TaskLandResult: Sendable, Equatable {
    public enum Status: String, Sendable, CaseIterable {
        /// The stream took the task's commit.
        case landed
        /// An update finished its rebase.
        case updated
        /// Nothing was left to land.
        case nothing
        case aborted
        case fixing
        case conflict
        case blocked
        /// The task's agent is mid-turn; nothing happened.
        case working
    }

    public var status: Status
    /// A landing finished a close: the task went to Done.
    public var closed: Bool
    /// The task's landing now (`fixing`, `conflict`, `blocked`).
    public var landing: TaskLanding?

    public init(status: Status, closed: Bool = false, landing: TaskLanding? = nil) {
        self.status = status
        self.closed = closed
        self.landing = landing
    }

    /// A status outside `Status` throws: a desktop sends only those.
    public static func parse(_ value: JSONValue) throws(ProtocolError) -> TaskLandResult {
        let o = try Fields(value, "result")
        let raw = try o.str("status")
        guard let status = Status(rawValue: raw) else { throw ProtocolError("unknown status \(raw)") }
        return TaskLandResult(status: status, closed: o.flag("closed"), landing: o.isUnset("landing") ? nil : try TaskLanding.parse(o["landing"]))
    }

    public var json: JSONValue {
        var o: JSONObject = ["status": .string(status.rawValue)]
        if closed { o["closed"] = .bool(true) }
        if let landing { o["landing"] = landing.json }
        return .object(o)
    }
}
