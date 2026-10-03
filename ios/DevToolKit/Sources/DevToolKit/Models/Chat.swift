import Foundation

// SPEC.md §6.2: the chat view model the desktop sends for a claude-chat tab.
// The phone renders only this schema. Parsing matches `protocol/ts/chat-messages.ts`:
// unknown fields are dropped, `null` optionals are absent, an unknown item or
// prompt kind becomes `.unknown` (rendered as "Needs a newer app"), an unknown
// tool status reads as `pending`, an unknown process as `idle` and an unknown
// tone as `muted`. A known kind with a wrong-typed field fails the message.

/// Lifecycle of the chat's Claude process.
public enum ChatProcessState: Sendable, Hashable {
    case idle
    case starting
    case running
    case exited

    /// An unknown value reads as `idle`.
    public init(rawValue: String) {
        switch rawValue {
        case "starting": self = .starting
        case "running": self = .running
        case "exited": self = .exited
        default: self = .idle
        }
    }

    public var rawValue: String {
        switch self {
        case .idle: "idle"
        case .starting: "starting"
        case .running: "running"
        case .exited: "exited"
        }
    }
}

public enum ChatToolStatus: Sendable, Hashable {
    case pending
    case running
    /// Waiting on a permission prompt.
    case waiting
    case done
    case error
    case denied

    /// An unknown value reads as `pending`.
    public init(rawValue: String) {
        switch rawValue {
        case "running": self = .running
        case "waiting": self = .waiting
        case "done": self = .done
        case "error": self = .error
        case "denied": self = .denied
        default: self = .pending
        }
    }

    public var rawValue: String {
        switch self {
        case .pending: "pending"
        case .running: "running"
        case .waiting: "waiting"
        case .done: "done"
        case .error: "error"
        case .denied: "denied"
        }
    }

    /// Still in flight (spinner-worthy).
    public var isActive: Bool {
        switch self {
        case .pending, .running, .waiting: true
        default: false
        }
    }
}

public enum ChatNoticeTone: Sendable, Hashable {
    case muted
    case warning
    case error

    /// An unknown tone is shown muted.
    public init(rawValue: String) {
        switch rawValue {
        case "warning": self = .warning
        case "error": self = .error
        default: self = .muted
        }
    }

    public var rawValue: String {
        switch self {
        case .muted: "muted"
        case .warning: "warning"
        case .error: "error"
        }
    }
}

public struct ChatTool: Sendable, Equatable {
    public var name: String
    public var summary: String
    public var status: ChatToolStatus
    public var hasDetail: Bool
    public var childCount: Int?
    public var lastChild: String?

    public init(name: String, summary: String, status: ChatToolStatus, hasDetail: Bool, childCount: Int? = nil, lastChild: String? = nil) {
        self.name = name
        self.summary = summary
        self.status = status
        self.hasDetail = hasDetail
        self.childCount = childCount
        self.lastChild = lastChild
    }
}

/// One transcript row.
public struct ChatItem: Sendable, Equatable, Identifiable {
    public enum Content: Sendable, Equatable {
        case user(text: String, images: Int?, queued: Bool, failed: Bool)
        case text(markdown: String, streaming: Bool)
        /// `preview` is at most 300 chars.
        case thinking(preview: String, streaming: Bool)
        case tool(ChatTool)
        case notice(text: String, tone: ChatNoticeTone)
        /// A kind this build doesn't know.
        case unknown(kind: String)
    }

    public var id: String
    public var content: Content

    public init(id: String, _ content: Content) {
        self.id = id
        self.content = content
    }

    public var kind: String {
        switch content {
        case .user: "user"
        case .text: "text"
        case .thinking: "thinking"
        case .tool: "tool"
        case .notice: "notice"
        case .unknown: "unknown"
        }
    }

    public var isStreaming: Bool {
        switch content {
        case .text(_, let streaming), .thinking(_, let streaming): streaming
        default: false
        }
    }
}

public struct ChatQuestionOption: Sendable, Equatable, Hashable {
    public var label: String
    public var description: String?

    public init(label: String, description: String? = nil) {
        self.label = label
        self.description = description
    }
}

public struct ChatQuestion: Sendable, Equatable {
    public var question: String
    public var header: String?
    public var multiSelect: Bool
    public var options: [ChatQuestionOption]

    public init(question: String, header: String? = nil, multiSelect: Bool = false, options: [ChatQuestionOption]) {
        self.question = question
        self.header = header
        self.multiSelect = multiSelect
        self.options = options
    }
}

public struct ChatPermission: Sendable, Equatable {
    public var toolName: String
    public var title: String
    public var summary: String
    /// At most 4000 chars: the full command, a diff excerpt, …
    public var detail: String?
    public var canAlwaysAllow: Bool
    /// Raised by a subagent.
    public var agent: Bool

    public init(toolName: String, title: String, summary: String, detail: String? = nil, canAlwaysAllow: Bool, agent: Bool = false) {
        self.toolName = toolName
        self.title = title
        self.summary = summary
        self.detail = detail
        self.canAlwaysAllow = canAlwaysAllow
        self.agent = agent
    }
}

/// An open prompt waiting for the user.
public struct ChatPrompt: Sendable, Equatable, Identifiable {
    public enum Content: Sendable, Equatable {
        case permission(ChatPermission)
        case question([ChatQuestion])
        /// ExitPlanMode.
        case plan(markdown: String)
        case unknown(kind: String)
    }

    public var id: String
    public var content: Content

    public init(id: String, _ content: Content) {
        self.id = id
        self.content = content
    }

    public var kind: String {
        switch content {
        case .permission: "permission"
        case .question: "question"
        case .plan: "plan"
        case .unknown: "unknown"
        }
    }
}

/// Status fields shared by `ChatView` and the `chat` event.
public struct ChatStatus: Sendable, Equatable {
    public var busy: Bool
    /// Unix ms.
    public var turnStartedAt: Int64?
    public var process: ChatProcessState
    public var processError: String?
    public var permissionMode: String?
    public var model: String?

    public init(busy: Bool = false, turnStartedAt: Int64? = nil, process: ChatProcessState = .idle,
                processError: String? = nil, permissionMode: String? = nil, model: String? = nil) {
        self.busy = busy
        self.turnStartedAt = turnStartedAt
        self.process = process
        self.processError = processError
        self.permissionMode = permissionMode
        self.model = model
    }
}

/// `chat.open` result's `view`.
public struct ChatView: Sendable, Equatable {
    public var tabId: String
    public var title: String
    public var status: ChatStatus
    /// Oldest → newest, windowed: `hasEarlier` says more exist before `items[0]`.
    public var items: [ChatItem]
    public var hasEarlier: Bool
    /// Open prompts, oldest first.
    public var prompts: [ChatPrompt]

    public init(tabId: String, title: String, status: ChatStatus = ChatStatus(), items: [ChatItem] = [],
                hasEarlier: Bool = false, prompts: [ChatPrompt] = []) {
        self.tabId = tabId
        self.title = title
        self.status = status
        self.items = items
        self.hasEarlier = hasEarlier
        self.prompts = prompts
    }

    public var busy: Bool {
        get { status.busy }
        set { status.busy = newValue }
    }
}

/// `evt chat` (§6.4).
public struct ChatEvent: Sendable, Equatable {
    public var tabId: String
    public var seq: Int64
    /// Replace by `id`, or append (in order) after the last item.
    public var upserts: [ChatItem]
    public var removes: [String]
    /// Always the full open-prompt list.
    public var prompts: [ChatPrompt]
    public var status: ChatStatus

    public init(tabId: String, seq: Int64, upserts: [ChatItem] = [], removes: [String] = [], prompts: [ChatPrompt] = [],
                status: ChatStatus = ChatStatus()) {
        self.tabId = tabId
        self.seq = seq
        self.upserts = upserts
        self.removes = removes
        self.prompts = prompts
        self.status = status
    }
}

/// `chat.open` result.
public struct ChatOpenResult: Sendable, Equatable {
    public var seq: Int64
    public var view: ChatView

    public init(seq: Int64, view: ChatView) {
        self.seq = seq
        self.view = view
    }
}

/// `chat.earlier` result.
public struct ChatEarlierResult: Sendable, Equatable {
    public var items: [ChatItem]
    public var hasEarlier: Bool

    public init(items: [ChatItem], hasEarlier: Bool) {
        self.items = items
        self.hasEarlier = hasEarlier
    }
}

/// `chat.new` params (§8.2).
public struct ChatNewParams: Sendable, Equatable {
    public var taskId: String

    public init(taskId: String) {
        self.taskId = taskId
    }
}

/// `chat.new` result: the new claude-chat tab, which `chat.open` then starts.
public struct ChatNewResult: Sendable, Equatable {
    public var tabId: String

    public init(tabId: String) {
        self.tabId = tabId
    }
}

/// `task.new` (§8.4) params: a new task in `projectId` whose Claude chat starts on `prompt`.
public struct TaskNewParams: Sendable, Equatable {
    public var projectId: String
    public var prompt: String
    /// One of `TaskOp.modes`; nil leaves Claude's own default.
    public var mode: String?

    public init(projectId: String, prompt: String, mode: String? = nil) {
        self.projectId = projectId
        self.prompt = prompt
        self.mode = mode
    }
}

/// `task.new` result: the new task and its claude-chat tab, already sent the prompt.
public struct TaskNewResult: Sendable, Equatable {
    public var taskId: String
    public var tabId: String

    public init(taskId: String, tabId: String) {
        self.taskId = taskId
        self.tabId = tabId
    }
}

/// `task.new` (§8.4). It names a project, not a tab, so it isn't one of `ChatParams.ops`.
public enum TaskOp {
    public static let new = "task.new"
    /// The permission modes `task.new` accepts, in the order the phone offers them.
    public static let modes = ["default", "acceptEdits", "plan", "auto", "bypassPermissions"]
}

/// `chat.detail` result.
public enum ChatDetail: Sendable, Equatable {
    /// Pretty JSON input and the result text, each at most 200000 chars.
    case tool(input: String, result: String?)
    /// The full markdown of a truncated text or user item.
    case text(markdown: String)
}

/// `chat.answer` `answer`.
public enum ChatAnswer: Sendable, Equatable {
    case allow(always: Bool)
    case deny(message: String?)
    /// Question → answer. Multi-select answers join labels with ", ".
    case answers([(question: String, answer: String)])
    case approvePlan

    public static func == (lhs: ChatAnswer, rhs: ChatAnswer) -> Bool {
        lhs.json == rhs.json
    }

    /// Multi-select answers join labels with ", ", matching the desktop.
    public static func joined(_ labels: [String]) -> String {
        labels.joined(separator: ", ")
    }
}

/// Chat ops (§6.3).
public enum ChatOp {
    public static let open = "chat.open"
    public static let close = "chat.close"
    public static let earlier = "chat.earlier"
    public static let send = "chat.send"
    public static let answer = "chat.answer"
    public static let interrupt = "chat.interrupt"
    public static let detail = "chat.detail"
    /// `chat.new` (§8.2) names a task, not a tab, so it isn't one of `ChatParams.ops`.
    public static let new = "chat.new"

    /// §6.3 limits.
    public static let maxSendLength = 32_000
    public static let maxEarlierLimit = 100
}

// MARK: - Parsing

extension Fields {
    func optStr(_ key: String) throws(ProtocolError) -> String? {
        isUnset(key) ? nil : try str(key)
    }

    func optInt(_ key: String) throws(ProtocolError) -> Int64? {
        isUnset(key) ? nil : try int(key)
    }

    /// Flags are `true` or absent on the wire; anything else counts as absent.
    func flag(_ key: String) -> Bool {
        self[key] == .bool(true)
    }

    func bool(_ key: String) throws(ProtocolError) -> Bool {
        guard case .bool(let b)? = self[key] else { throw ProtocolError("\(key) must be a boolean") }
        return b
    }
}

extension ChatStatus {
    init(fields f: Fields) throws(ProtocolError) {
        self.init(
            busy: try f.bool("busy"),
            turnStartedAt: try f.optInt("turnStartedAt"),
            process: ChatProcessState(rawValue: try f.str("process")),
            processError: try f.optStr("processError"),
            permissionMode: try f.optStr("permissionMode"),
            model: try f.optStr("model")
        )
    }

    func write(to o: inout JSONObject) {
        o["busy"] = .bool(busy)
        if let turnStartedAt { o["turnStartedAt"] = .int(turnStartedAt) }
        o["process"] = .string(process.rawValue)
        if let processError { o["processError"] = .string(processError) }
        if let permissionMode { o["permissionMode"] = .string(permissionMode) }
        if let model { o["model"] = .string(model) }
    }
}

extension ChatItem {
    /// Throws when the value isn't an object with string `kind` and `id`, or
    /// when a known kind has a wrong-typed field. An unknown kind parses as `.unknown`.
    public static func parse(_ value: JSONValue) throws(ProtocolError) -> ChatItem {
        let f = try Fields(value, "item")
        let kind = try f.str("kind")
        let id = try f.str("id")
        switch kind {
        case "user":
            let images = try f.optInt("images").map(Int.init)
            return ChatItem(id: id, .user(
                text: try f.str("text"),
                images: images.flatMap { $0 > 0 ? $0 : nil },
                queued: f.flag("queued"),
                failed: f.flag("failed")
            ))
        case "text":
            return ChatItem(id: id, .text(markdown: try f.str("markdown"), streaming: f.flag("streaming")))
        case "thinking":
            return ChatItem(id: id, .thinking(preview: try f.str("preview"), streaming: f.flag("streaming")))
        case "tool":
            return ChatItem(id: id, .tool(ChatTool(
                name: try f.str("name"),
                summary: try f.str("summary"),
                status: ChatToolStatus(rawValue: try f.str("status")),
                hasDetail: try f.bool("hasDetail"),
                childCount: try f.optInt("childCount").map(Int.init),
                lastChild: try f.optStr("lastChild")
            )))
        case "notice":
            return ChatItem(id: id, .notice(text: try f.str("text"), tone: ChatNoticeTone(rawValue: try f.str("tone"))))
        default:
            return ChatItem(id: id, .unknown(kind: kind))
        }
    }

    static func parseList(_ values: [JSONValue]) throws(ProtocolError) -> [ChatItem] {
        try values.map { (v) throws(ProtocolError) in try parse(v) }
    }

    /// Wire JSON; an unknown kind is `{ kind:"unknown", id, unknownKind }` like the TS parser's output.
    public var json: JSONValue {
        var o: JSONObject = ["kind": .string(kind), "id": .string(id)]
        switch content {
        case .user(let text, let images, let queued, let failed):
            o["text"] = .string(text)
            if let images, images > 0 { o["images"] = .int(Int64(images)) }
            if queued { o["queued"] = true }
            if failed { o["failed"] = true }
        case .text(let markdown, let streaming):
            o["markdown"] = .string(markdown)
            if streaming { o["streaming"] = true }
        case .thinking(let preview, let streaming):
            o["preview"] = .string(preview)
            if streaming { o["streaming"] = true }
        case .tool(let tool):
            o["name"] = .string(tool.name)
            o["summary"] = .string(tool.summary)
            o["status"] = .string(tool.status.rawValue)
            o["hasDetail"] = .bool(tool.hasDetail)
            if let childCount = tool.childCount { o["childCount"] = .int(Int64(childCount)) }
            if let lastChild = tool.lastChild { o["lastChild"] = .string(lastChild) }
        case .notice(let text, let tone):
            o["text"] = .string(text)
            o["tone"] = .string(tone.rawValue)
        case .unknown(let kind):
            o["unknownKind"] = .string(kind)
        }
        return .object(o)
    }
}

extension ChatPrompt {
    public static func parse(_ value: JSONValue) throws(ProtocolError) -> ChatPrompt {
        let f = try Fields(value, "prompt")
        let kind = try f.str("kind")
        let id = try f.str("id")
        switch kind {
        case "permission":
            return ChatPrompt(id: id, .permission(ChatPermission(
                toolName: try f.str("toolName"),
                title: try f.str("title"),
                summary: try f.str("summary"),
                detail: try f.optStr("detail"),
                canAlwaysAllow: f.flag("canAlwaysAllow"),
                agent: f.flag("agent")
            )))
        case "question":
            let questions = try f.array("questions").map { (v) throws(ProtocolError) -> ChatQuestion in
                let q = try Fields(v, "question")
                return ChatQuestion(
                    question: try q.str("question"),
                    header: try q.optStr("header"),
                    multiSelect: q.flag("multiSelect"),
                    options: try q.array("options").map { (o) throws(ProtocolError) -> ChatQuestionOption in
                        let of = try Fields(o, "option")
                        return ChatQuestionOption(label: try of.str("label"), description: try of.optStr("description"))
                    }
                )
            }
            return ChatPrompt(id: id, .question(questions))
        case "plan":
            return ChatPrompt(id: id, .plan(markdown: try f.str("markdown")))
        default:
            return ChatPrompt(id: id, .unknown(kind: kind))
        }
    }

    static func parseList(_ values: [JSONValue]) throws(ProtocolError) -> [ChatPrompt] {
        try values.map { (v) throws(ProtocolError) in try parse(v) }
    }

    public var json: JSONValue {
        var o: JSONObject = ["kind": .string(kind), "id": .string(id)]
        switch content {
        case .permission(let p):
            o["toolName"] = .string(p.toolName)
            o["title"] = .string(p.title)
            o["summary"] = .string(p.summary)
            if let detail = p.detail { o["detail"] = .string(detail) }
            o["canAlwaysAllow"] = .bool(p.canAlwaysAllow)
            if p.agent { o["agent"] = true }
        case .question(let questions):
            o["questions"] = .array(questions.map { q in
                var qo: JSONObject = ["question": .string(q.question)]
                if let header = q.header { qo["header"] = .string(header) }
                qo["multiSelect"] = .bool(q.multiSelect)
                qo["options"] = .array(q.options.map { option in
                    var oo: JSONObject = ["label": .string(option.label)]
                    if let description = option.description { oo["description"] = .string(description) }
                    return .object(oo)
                })
                return .object(qo)
            })
        case .plan(let markdown):
            o["markdown"] = .string(markdown)
        case .unknown(let kind):
            o["unknownKind"] = .string(kind)
        }
        return .object(o)
    }
}

extension ChatView {
    public static func parse(_ value: JSONValue?) throws(ProtocolError) -> ChatView {
        let f = try Fields(value, "view")
        return ChatView(
            tabId: try f.str("tabId"),
            title: try f.str("title"),
            status: try ChatStatus(fields: f),
            items: try ChatItem.parseList(try f.array("items")),
            hasEarlier: try f.bool("hasEarlier"),
            prompts: try ChatPrompt.parseList(try f.array("prompts"))
        )
    }

    public var json: JSONValue {
        var o: JSONObject = ["tabId": .string(tabId), "title": .string(title)]
        status.write(to: &o)
        o["items"] = .array(items.map(\.json))
        o["hasEarlier"] = .bool(hasEarlier)
        o["prompts"] = .array(prompts.map(\.json))
        return .object(o)
    }
}

extension ChatEvent {
    /// The fields of an `{ t:"evt", e:"chat", … }` message.
    static func parse(fields f: Fields) throws(ProtocolError) -> ChatEvent {
        ChatEvent(
            tabId: try f.str("tabId"),
            seq: try f.int("seq"),
            upserts: try ChatItem.parseList(try f.array("upserts")),
            removes: try f.array("removes").map { (v) throws(ProtocolError) -> String in
                guard let id = v.stringValue else { throw ProtocolError("removes must hold strings") }
                return id
            },
            prompts: try ChatPrompt.parseList(try f.array("prompts")),
            status: try ChatStatus(fields: f)
        )
    }

    public var json: JSONValue {
        var o: JSONObject = ["t": "evt", "e": "chat", "tabId": .string(tabId), "seq": .int(seq)]
        status.write(to: &o)
        o["upserts"] = .array(upserts.map(\.json))
        o["removes"] = .array(removes.map(JSONValue.string))
        o["prompts"] = .array(prompts.map(\.json))
        return .object(o)
    }
}

extension ChatOpenResult {
    public static func parse(_ value: JSONValue) throws(ProtocolError) -> ChatOpenResult {
        let f = try Fields(value, "result")
        return ChatOpenResult(seq: try f.int("seq"), view: try ChatView.parse(f["view"]))
    }

    public var json: JSONValue { .object(["seq": .int(seq), "view": view.json]) }
}

extension ChatEarlierResult {
    public static func parse(_ value: JSONValue) throws(ProtocolError) -> ChatEarlierResult {
        let f = try Fields(value, "result")
        return ChatEarlierResult(items: try ChatItem.parseList(try f.array("items")), hasEarlier: try f.bool("hasEarlier"))
    }

    public var json: JSONValue { .object(["items": .array(items.map(\.json)), "hasEarlier": .bool(hasEarlier)]) }
}

extension ChatNewParams {
    /// The desktop's side; a missing or non-string `taskId` throws (`bad-request`).
    public static func parse(_ value: JSONValue?) throws(ProtocolError) -> ChatNewParams {
        ChatNewParams(taskId: try Fields(value, "params").str("taskId"))
    }

    public var json: JSONValue { .object(["taskId": .string(taskId)]) }
}

extension ChatNewResult {
    public static func parse(_ value: JSONValue) throws(ProtocolError) -> ChatNewResult {
        ChatNewResult(tabId: try Fields(value, "result").str("tabId"))
    }

    public var json: JSONValue { .object(["tabId": .string(tabId)]) }
}

extension TaskNewParams {
    /// The desktop's side: a missing `projectId`, a blank or over-long prompt, or an
    /// unknown `mode` throws (`bad-request`).
    public static func parse(_ value: JSONValue?) throws(ProtocolError) -> TaskNewParams {
        let o = try Fields(value, "params")
        let projectId = try o.str("projectId")
        let prompt = try o.str("prompt")
        if prompt.utf16.count > ChatOp.maxSendLength { throw ProtocolError("prompt over \(ChatOp.maxSendLength) characters") }
        if prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { throw ProtocolError("prompt is empty") }
        let mode = try o.optStr("mode")
        if let mode, !TaskOp.modes.contains(mode) { throw ProtocolError("unknown mode \(mode)") }
        return TaskNewParams(projectId: projectId, prompt: prompt, mode: mode)
    }

    public var json: JSONValue {
        var fields: JSONObject = ["projectId": .string(projectId), "prompt": .string(prompt)]
        if let mode { fields["mode"] = .string(mode) }
        return .object(fields)
    }
}

extension TaskNewResult {
    public static func parse(_ value: JSONValue) throws(ProtocolError) -> TaskNewResult {
        let o = try Fields(value, "result")
        return TaskNewResult(taskId: try o.str("taskId"), tabId: try o.str("tabId"))
    }

    public var json: JSONValue { .object(["taskId": .string(taskId), "tabId": .string(tabId)]) }
}

extension ChatDetail {
    public static func parse(_ value: JSONValue) throws(ProtocolError) -> ChatDetail {
        let f = try Fields(value, "result")
        switch f["kind"]?.stringValue {
        case "tool": return .tool(input: try f.str("input"), result: try f.optStr("result"))
        case "text": return .text(markdown: try f.str("markdown"))
        default: throw ProtocolError("detail kind has an unknown value")
        }
    }

    public var json: JSONValue {
        switch self {
        case .tool(let input, let result):
            var o: JSONObject = ["kind": "tool", "input": .string(input)]
            if let result { o["result"] = .string(result) }
            return .object(o)
        case .text(let markdown):
            return .object(["kind": "text", "markdown": .string(markdown)])
        }
    }
}

extension ChatAnswer {
    public var json: JSONValue {
        switch self {
        case .allow(let always):
            var o: JSONObject = ["behavior": "allow"]
            if always { o["always"] = true }
            return .object(o)
        case .deny(let message):
            var o: JSONObject = ["behavior": "deny"]
            if let message { o["message"] = .string(message) }
            return .object(o)
        case .answers(let answers):
            var a = JSONObject()
            for (question, answer) in answers { a[question] = .string(answer) }
            return .object(["behavior": "answers", "answers": .object(a)])
        case .approvePlan:
            return .object(["behavior": "approvePlan"])
        }
    }

    /// Parses an `answer` the way the desktop does.
    public static func parse(_ value: JSONValue?) throws(ProtocolError) -> ChatAnswer {
        let f = try Fields(value, "answer")
        switch f["behavior"]?.stringValue {
        case "allow": return .allow(always: f.flag("always"))
        case "deny": return .deny(message: try f.optStr("message"))
        case "approvePlan": return .approvePlan
        case "answers":
            let a = try Fields(f["answers"], "answers")
            var out: [(question: String, answer: String)] = []
            for (key, value) in a.o.entries {
                guard let s = value.stringValue else { throw ProtocolError("answers must map questions to strings") }
                out.append((question: key, answer: s))
            }
            return .answers(out)
        default:
            throw ProtocolError("answer.behavior has an unknown value")
        }
    }
}

/// The `params` of a `chat.*` req, parsed the way the desktop does
/// (`parseChatParams` in TS). Used by test desktops and the vectors.
public enum ChatParams: Sendable, Equatable {
    case tab(op: String, tabId: String)
    case earlier(tabId: String, before: String, limit: Int?)
    case send(tabId: String, text: String)
    case answer(tabId: String, promptId: String, answer: ChatAnswer)
    case detail(tabId: String, itemId: String)

    public static let ops: [String] = [ChatOp.open, ChatOp.close, ChatOp.earlier, ChatOp.send, ChatOp.answer, ChatOp.interrupt, ChatOp.detail]

    /// nil for an op that isn't a chat op; throws (answer `bad-request`) for bad params.
    public static func parse(op: String, _ params: JSONValue?) throws(ProtocolError) -> ChatParams? {
        guard ops.contains(op) else { return nil }
        let f = try Fields(params, "params")
        let tabId = try f.str("tabId")
        switch op {
        case ChatOp.earlier:
            let before = try f.str("before")
            let limit = try f.optInt("limit")
            if limit == 0 { throw ProtocolError("limit must be positive") }
            return .earlier(tabId: tabId, before: before, limit: limit.map { Int(min($0, Int64(ChatOp.maxEarlierLimit))) })
        case ChatOp.send:
            let text = try f.str("text")
            // JS string length counts UTF-16 code units.
            if text.utf16.count > ChatOp.maxSendLength { throw ProtocolError("text over \(ChatOp.maxSendLength) characters") }
            if text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { throw ProtocolError("text is empty") }
            return .send(tabId: tabId, text: text)
        case ChatOp.answer:
            return .answer(tabId: tabId, promptId: try f.str("promptId"), answer: try ChatAnswer.parse(f["answer"]))
        case ChatOp.detail:
            return .detail(tabId: tabId, itemId: try f.str("itemId"))
        default:
            return .tab(op: op, tabId: tabId)
        }
    }

    public var tabId: String {
        switch self {
        case .tab(_, let id), .earlier(let id, _, _), .send(let id, _), .answer(let id, _, _), .detail(let id, _): id
        }
    }

    public var json: JSONValue {
        switch self {
        case .tab(_, let tabId):
            return .object(["tabId": .string(tabId)])
        case .earlier(let tabId, let before, let limit):
            var o: JSONObject = ["tabId": .string(tabId), "before": .string(before)]
            if let limit { o["limit"] = .int(Int64(limit)) }
            return .object(o)
        case .send(let tabId, let text):
            return .object(["tabId": .string(tabId), "text": .string(text)])
        case .answer(let tabId, let promptId, let answer):
            return .object(["tabId": .string(tabId), "promptId": .string(promptId), "answer": answer.json])
        case .detail(let tabId, let itemId):
            return .object(["tabId": .string(tabId), "itemId": .string(itemId)])
        }
    }
}
