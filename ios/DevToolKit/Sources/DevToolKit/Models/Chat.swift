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
    /// Images the result carried (at most 4), fetched with `chat.image` (§8.9).
    public var images: Int?

    public init(name: String, summary: String, status: ChatToolStatus, hasDetail: Bool, childCount: Int? = nil, lastChild: String? = nil,
                images: Int? = nil) {
        self.name = name
        self.summary = summary
        self.status = status
        self.hasDetail = hasDetail
        self.childCount = childCount
        self.lastChild = lastChild
        self.images = images
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
    /// The model and effort pickers; nil from a desktop that doesn't send them.
    public var settings: ChatSettings?
    /// The context, cost and plan-limit meter; nil until the desktop has read any of it.
    public var usage: ChatUsage?

    public init(busy: Bool = false, turnStartedAt: Int64? = nil, process: ChatProcessState = .idle,
                processError: String? = nil, permissionMode: String? = nil, model: String? = nil,
                settings: ChatSettings? = nil, usage: ChatUsage? = nil) {
        self.busy = busy
        self.turnStartedAt = turnStartedAt
        self.process = process
        self.processError = processError
        self.permissionMode = permissionMode
        self.model = model
        self.settings = settings
        self.usage = usage
    }
}

/// One row of the model picker.
public struct ChatModelOption: Sendable, Equatable, Hashable {
    public var value: String
    public var label: String
    public var description: String?

    public init(value: String, label: String, description: String? = nil) {
        self.value = value
        self.label = label
        self.description = description
    }
}

/// The composer's model and effort pickers (§6.2), labelled by the desktop.
public struct ChatSettings: Sendable, Equatable {
    /// The picked `models` value; nil = Claude's settings default.
    public var model: String?
    /// What the session runs, by name ("Opus 5.5"), once known.
    public var modelName: String?
    /// Pickable models, without a "Default" row: the phone adds that.
    public var models: [ChatModelOption]
    /// The picked effort; nil = the default.
    public var effort: String?
    /// What the default effort resolves to, once known.
    public var defaultEffort: String?
    /// The effort levels the current model takes.
    public var efforts: [String]

    public init(model: String? = nil, modelName: String? = nil, models: [ChatModelOption] = [],
                effort: String? = nil, defaultEffort: String? = nil, efforts: [String] = []) {
        self.model = model
        self.modelName = modelName
        self.models = models
        self.effort = effort
        self.defaultEffort = defaultEffort
        self.efforts = efforts
    }
}

/// One plan rate-limit window.
public struct ChatLimitWindow: Sendable, Equatable {
    /// Percent used, 0–100.
    public var used: Int
    /// Unix ms.
    public var resetsAt: Int64?

    public init(used: Int, resetsAt: Int64? = nil) {
        self.used = used
        self.resetsAt = resetsAt
    }
}

/// The composer's meter (§6.2). Each part is there once the desktop has read it.
public struct ChatUsage: Sendable, Equatable {
    public var contextTokens: Int64?
    public var contextMax: Int64?
    /// Session cost at API list prices, in US cents.
    public var costCents: Int64?
    /// claude.ai plan windows; nil for API-key sessions.
    public var fiveHour: ChatLimitWindow?
    public var sevenDay: ChatLimitWindow?

    public init(contextTokens: Int64? = nil, contextMax: Int64? = nil, costCents: Int64? = nil,
                fiveHour: ChatLimitWindow? = nil, sevenDay: ChatLimitWindow? = nil) {
        self.contextTokens = contextTokens
        self.contextMax = contextMax
        self.costCents = costCents
        self.fiveHour = fiveHour
        self.sevenDay = sevenDay
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

/// `task.new` (§8.4) params: a new task in one of `projectId`'s streams whose
/// Claude chat starts on `prompt`.
public struct TaskNewParams: Sendable, Equatable {
    public var projectId: String
    /// nil: the stream the project was last used in, else `main`.
    public var streamId: String?
    public var prompt: String
    /// One of `TaskOp.modes`; nil leaves Claude's own default.
    public var mode: String?

    public init(projectId: String, streamId: String? = nil, prompt: String, mode: String? = nil) {
        self.projectId = projectId
        self.streamId = streamId
        self.prompt = prompt
        self.mode = mode
    }
}

/// `task.close` (§8.7) params: archive the task. Each flag accepts what a
/// blocker reported.
public struct TaskCloseParams: Sendable, Equatable {
    public var taskId: String
    /// Close even though its agent is working (`.working`).
    public var stopWorking: Bool
    /// Close even though an editor has unsaved changes (`.unsaved`).
    public var discardUnsaved: Bool

    public init(taskId: String, stopWorking: Bool = false, discardUnsaved: Bool = false) {
        self.taskId = taskId
        self.stopWorking = stopWorking
        self.discardUnsaved = discardUnsaved
    }
}

/// `pin.set` (§8.10) params: pin or unpin a project, a stream (`pin.streamId`)
/// or a task (`pin.taskId`).
public struct PinSetParams: Sendable, Equatable {
    public var pin: InboxPin
    public var pinned: Bool

    public init(pin: InboxPin, pinned: Bool) {
        self.pin = pin
        self.pinned = pinned
    }
}

/// `task.triage` (§8.11) params: one of the desktop inbox's row actions.
public struct TaskTriageParams: Sendable, Equatable {
    public enum Action: Sendable, Equatable {
        case read
        case unread
        case settle
        case unsettle
        /// Until a Unix-ms time.
        case snooze(until: Int64)
        /// Until a tab next needs the user.
        case snoozeUntilAttention
        case unsnooze

        public var name: String {
            switch self {
            case .read: "read"
            case .unread: "unread"
            case .settle: "settle"
            case .unsettle: "unsettle"
            case .snooze, .snoozeUntilAttention: "snooze"
            case .unsnooze: "unsnooze"
            }
        }
    }

    public var taskId: String
    public var action: Action

    public init(taskId: String, action: Action) {
        self.taskId = taskId
        self.action = action
    }
}

/// `stream.new` (§8.12) params: a new stream in `projectId`, on a new worktree
/// or in the project folder, as the desktop's New stream dialog makes it.
public struct StreamNewParams: Sendable, Equatable {
    public var projectId: String
    /// Non-blank; sent and parsed trimmed.
    public var name: String
    /// true: a new worktree on `branch`, forked from `baseBranch`. false: the
    /// project folder (`branch` and `baseBranch` are dropped).
    public var worktree: Bool
    /// nil: the desktop makes one from `name`.
    public var branch: String?
    /// nil: `BranchesListResult.defaultBase`.
    public var baseBranch: String?

    public init(projectId: String, name: String, worktree: Bool, branch: String? = nil, baseBranch: String? = nil) {
        self.projectId = projectId
        self.name = name
        self.worktree = worktree
        self.branch = worktree ? branch : nil
        self.baseBranch = worktree ? baseBranch : nil
    }
}

/// `stream.new` result: the new stream, which shows up in the next inbox.
public struct StreamNewResult: Sendable, Equatable {
    public var streamId: String

    public init(streamId: String) {
        self.streamId = streamId
    }
}

/// `branches.list` (§8.13) result: a project's local branches for the New
/// stream sheet's From picker, and the one to pick first ("" when there is none).
public struct BranchesListResult: Sendable, Equatable {
    public var branches: [String]
    public var defaultBase: String

    public init(branches: [String], defaultBase: String) {
        self.branches = branches
        self.defaultBase = defaultBase
    }
}

/// Why `task.close` left a task open (§8.7), in the order the desktop checks.
public enum TaskCloseBlocker: String, Sendable, Equatable, CaseIterable {
    /// An agent tab of the task is working.
    case working
    /// An editor tab has unsaved changes in a desktop window.
    case unsaved
}

/// `task.close` result.
public enum TaskCloseResult: Sendable, Equatable {
    /// The task is archived (its stream's Done row on the desktop).
    case closed
    case blocked(TaskCloseBlocker)
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

/// `chat.settings` (§8.5) params. Nil fields stay as they are; an empty
/// `model` or `effort` goes back to Claude's settings default.
public struct ChatSettingsParams: Sendable, Equatable {
    public var tabId: String
    /// One of `TaskOp.modes`.
    public var mode: String?
    public var model: String?
    public var effort: String?

    public init(tabId: String, mode: String? = nil, model: String? = nil, effort: String? = nil) {
        self.tabId = tabId
        self.mode = mode
        self.model = model
        self.effort = effort
    }
}

/// `chat.image` (§8.9) params: image `index` of tool item `itemId`, scaled
/// by the desktop so its longest side is at most `maxSide` pixels.
public struct ChatImageParams: Sendable, Equatable {
    public var tabId: String
    public var itemId: String
    public var index: Int
    public var maxSide: Int?

    /// `maxSide` bounds the desktop clamps to.
    public static let minSide = 64
    public static let maxSide = 4096

    public init(tabId: String, itemId: String, index: Int, maxSide: Int? = nil) {
        self.tabId = tabId
        self.itemId = itemId
        self.index = index
        self.maxSide = maxSide
    }
}

/// `chat.image` result: the image bytes and their type (`image/png`, `jpeg`, `gif` or `webp`).
public struct ChatImageResult: Sendable, Equatable {
    public static let mediaTypes = ["image/png", "image/jpeg", "image/gif", "image/webp"]

    public var mediaType: String
    public var data: Data

    public init(mediaType: String, data: Data) {
        self.mediaType = mediaType
        self.data = data
    }
}

/// `task.new` (§8.4). It names a project, not a tab, so it isn't one of `ChatParams.ops`.
public enum TaskOp {
    public static let new = "task.new"
    /// `task.close` (§8.7).
    public static let close = "task.close"
    /// `tab.close` (§8.8): one agent or terminal tab.
    public static let closeTab = "tab.close"
    /// `pin.set` (§8.10): pin or unpin a project or task.
    public static let setPin = "pin.set"
    /// `task.triage` (§8.11): read, unread, settle, snooze and their undo.
    public static let triage = "task.triage"
    /// `stream.new` (§8.12): a stream on a new worktree or in the project folder.
    public static let newStream = "stream.new"
    /// `branches.list` (§8.13): a project's branches for the New stream sheet.
    public static let listBranches = "branches.list"
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
    /// `chat.settings` (§8.5); parsed by `ChatSettingsParams`, not `ChatParams`.
    public static let settings = "chat.settings"
    /// `chat.image` (§8.9); parsed by `ChatImageParams`, not `ChatParams`.
    public static let image = "chat.image"

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
            model: try f.optStr("model"),
            settings: f.isUnset("settings") ? nil : try ChatSettings.parse(f["settings"]),
            usage: f.isUnset("usage") ? nil : try ChatUsage.parse(f["usage"])
        )
    }

    func write(to o: inout JSONObject) {
        o["busy"] = .bool(busy)
        if let turnStartedAt { o["turnStartedAt"] = .int(turnStartedAt) }
        o["process"] = .string(process.rawValue)
        if let processError { o["processError"] = .string(processError) }
        if let permissionMode { o["permissionMode"] = .string(permissionMode) }
        if let model { o["model"] = .string(model) }
        if let settings { o["settings"] = settings.json }
        if let usage { o["usage"] = usage.json }
    }
}

extension ChatSettings {
    static func parse(_ value: JSONValue?) throws(ProtocolError) -> ChatSettings {
        let f = try Fields(value, "settings")
        return ChatSettings(
            model: try f.optStr("model"),
            modelName: try f.optStr("modelName"),
            models: try f.array("models").map { (v) throws(ProtocolError) -> ChatModelOption in
                let m = try Fields(v, "model")
                return ChatModelOption(value: try m.str("value"), label: try m.str("label"), description: try m.optStr("description"))
            },
            effort: try f.optStr("effort"),
            defaultEffort: try f.optStr("defaultEffort"),
            efforts: try f.array("efforts").map { (v) throws(ProtocolError) -> String in
                guard let s = v.stringValue else { throw ProtocolError("efforts must hold strings") }
                return s
            }
        )
    }

    var json: JSONValue {
        var o: JSONObject = [:]
        if let model { o["model"] = .string(model) }
        if let modelName { o["modelName"] = .string(modelName) }
        o["models"] = .array(models.map { m in
            var row: JSONObject = ["value": .string(m.value), "label": .string(m.label)]
            if let description = m.description { row["description"] = .string(description) }
            return .object(row)
        })
        if let effort { o["effort"] = .string(effort) }
        if let defaultEffort { o["defaultEffort"] = .string(defaultEffort) }
        o["efforts"] = .array(efforts.map { .string($0) })
        return .object(o)
    }
}

extension ChatLimitWindow {
    static func parse(_ value: JSONValue?) throws(ProtocolError) -> ChatLimitWindow {
        let f = try Fields(value, "limit")
        return ChatLimitWindow(used: Int(try f.int("used")), resetsAt: try f.optInt("resetsAt"))
    }

    var json: JSONValue {
        var o: JSONObject = ["used": .int(Int64(used))]
        if let resetsAt { o["resetsAt"] = .int(resetsAt) }
        return .object(o)
    }
}

extension ChatUsage {
    static func parse(_ value: JSONValue?) throws(ProtocolError) -> ChatUsage {
        let f = try Fields(value, "usage")
        return ChatUsage(
            contextTokens: try f.optInt("contextTokens"),
            contextMax: try f.optInt("contextMax"),
            costCents: try f.optInt("costCents"),
            fiveHour: f.isUnset("fiveHour") ? nil : try ChatLimitWindow.parse(f["fiveHour"]),
            sevenDay: f.isUnset("sevenDay") ? nil : try ChatLimitWindow.parse(f["sevenDay"])
        )
    }

    var json: JSONValue {
        var o: JSONObject = [:]
        if let contextTokens { o["contextTokens"] = .int(contextTokens) }
        if let contextMax { o["contextMax"] = .int(contextMax) }
        if let costCents { o["costCents"] = .int(costCents) }
        if let fiveHour { o["fiveHour"] = fiveHour.json }
        if let sevenDay { o["sevenDay"] = sevenDay.json }
        return .object(o)
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
                lastChild: try f.optStr("lastChild"),
                images: try f.optInt("images").flatMap { $0 > 0 ? Int($0) : nil }
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
            if let images = tool.images, images > 0 { o["images"] = .int(Int64(images)) }
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
        return TaskNewParams(projectId: projectId, streamId: try o.optStr("streamId"), prompt: prompt, mode: mode)
    }

    public var json: JSONValue {
        var fields: JSONObject = ["projectId": .string(projectId)]
        if let streamId { fields["streamId"] = .string(streamId) }
        fields["prompt"] = .string(prompt)
        if let mode { fields["mode"] = .string(mode) }
        return .object(fields)
    }
}

extension TaskCloseParams {
    /// The desktop's side: a missing `taskId` throws (`bad-request`).
    public static func parse(_ value: JSONValue?) throws(ProtocolError) -> TaskCloseParams {
        let o = try Fields(value, "params")
        return TaskCloseParams(taskId: try o.str("taskId"), stopWorking: o.flag("stopWorking"), discardUnsaved: o.flag("discardUnsaved"))
    }

    public var json: JSONValue {
        var fields: JSONObject = ["taskId": .string(taskId)]
        if stopWorking { fields["stopWorking"] = .bool(true) }
        if discardUnsaved { fields["discardUnsaved"] = .bool(true) }
        return .object(fields)
    }
}

extension PinSetParams {
    /// The desktop's side: a missing `projectId` or a non-boolean `pinned` throws (`bad-request`).
    public static func parse(_ value: JSONValue?) throws(ProtocolError) -> PinSetParams {
        let o = try Fields(value, "params")
        let pin = InboxPin(projectId: try o.str("projectId"), streamId: try o.optStr("streamId"), taskId: try o.optStr("taskId"))
        return PinSetParams(pin: pin, pinned: try o.bool("pinned"))
    }

    public var json: JSONValue {
        var fields: JSONObject = ["projectId": .string(pin.projectId)]
        if let streamId = pin.streamId { fields["streamId"] = .string(streamId) }
        if let taskId = pin.taskId { fields["taskId"] = .string(taskId) }
        fields["pinned"] = .bool(pinned)
        return .object(fields)
    }
}

extension TaskTriageParams {
    /// The desktop's side: a missing `taskId`, an unknown `action`, or a
    /// `snooze` without exactly one of `until` and `untilAttention: true`
    /// throws (`bad-request`). Other actions ignore both.
    public static func parse(_ value: JSONValue?) throws(ProtocolError) -> TaskTriageParams {
        let o = try Fields(value, "params")
        let taskId = try o.str("taskId")
        let name = try o.str("action")
        let action: Action
        switch name {
        case "read": action = .read
        case "unread": action = .unread
        case "settle": action = .settle
        case "unsettle": action = .unsettle
        case "unsnooze": action = .unsnooze
        case "snooze":
            let until = try o.optInt("until")
            let untilAttention = o.flag("untilAttention")
            switch (until, untilAttention) {
            case (let until?, false): action = .snooze(until: until)
            case (nil, true): action = .snoozeUntilAttention
            default: throw ProtocolError("snooze needs exactly one of until and untilAttention")
            }
        default:
            throw ProtocolError("unknown action \(name)")
        }
        return TaskTriageParams(taskId: taskId, action: action)
    }

    public var json: JSONValue {
        var fields: JSONObject = ["taskId": .string(taskId), "action": .string(action.name)]
        switch action {
        case .snooze(let until): fields["until"] = .int(until)
        case .snoozeUntilAttention: fields["untilAttention"] = .bool(true)
        default: break
        }
        return .object(fields)
    }
}

extension StreamNewParams {
    /// The desktop's side: a missing `projectId`, a blank `name`, a missing or
    /// non-boolean `worktree`, or a blank `branch` or `baseBranch` with a worktree
    /// throws (`bad-request`). `name` and `branch` come back trimmed.
    public static func parse(_ value: JSONValue?) throws(ProtocolError) -> StreamNewParams {
        let o = try Fields(value, "params")
        let projectId = try o.str("projectId")
        let name = try o.str("name").trimmingCharacters(in: .whitespacesAndNewlines)
        if name.isEmpty { throw ProtocolError("name is empty") }
        let worktree = try o.bool("worktree")
        guard worktree else { return StreamNewParams(projectId: projectId, name: name, worktree: false) }
        let branch = try o.optStr("branch")?.trimmingCharacters(in: .whitespacesAndNewlines)
        if branch?.isEmpty == true { throw ProtocolError("branch is empty") }
        let baseBranch = try o.optStr("baseBranch")
        if let baseBranch, baseBranch.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { throw ProtocolError("baseBranch is empty") }
        return StreamNewParams(projectId: projectId, name: name, worktree: true, branch: branch, baseBranch: baseBranch)
    }

    public var json: JSONValue {
        var fields: JSONObject = ["projectId": .string(projectId), "name": .string(name), "worktree": .bool(worktree)]
        if worktree, let branch { fields["branch"] = .string(branch) }
        if worktree, let baseBranch { fields["baseBranch"] = .string(baseBranch) }
        return .object(fields)
    }
}

extension StreamNewResult {
    public static func parse(_ value: JSONValue) throws(ProtocolError) -> StreamNewResult {
        StreamNewResult(streamId: try Fields(value, "result").str("streamId"))
    }

    public var json: JSONValue { .object(["streamId": .string(streamId)]) }
}

extension BranchesListResult {
    /// A branch that isn't a string throws.
    public static func parse(_ value: JSONValue) throws(ProtocolError) -> BranchesListResult {
        let o = try Fields(value, "result")
        let branches = try o.array("branches").map { (branch: JSONValue) throws(ProtocolError) -> String in
            guard case .string(let name) = branch else { throw ProtocolError("branches must be strings") }
            return name
        }
        return BranchesListResult(branches: branches, defaultBase: try o.str("defaultBase"))
    }

    public var json: JSONValue {
        .object(["branches": .array(branches.map(JSONValue.string)), "defaultBase": .string(defaultBase)])
    }
}

extension TaskCloseResult {
    /// A blocker outside `TaskCloseBlocker` throws: a desktop sends only those.
    public static func parse(_ value: JSONValue) throws(ProtocolError) -> TaskCloseResult {
        let o = try Fields(value, "result")
        if try o.bool("closed") { return .closed }
        let raw = try o.str("blocker")
        guard let blocker = TaskCloseBlocker(rawValue: raw) else { throw ProtocolError("unknown blocker \(raw)") }
        return .blocked(blocker)
    }

    public var json: JSONValue {
        switch self {
        case .closed:
            return .object(["closed": .bool(true)])
        case .blocked(let blocker):
            return .object(["closed": .bool(false), "blocker": .string(blocker.rawValue)])
        }
    }
}

extension ChatSettingsParams {
    /// The desktop's side: a missing `tabId`, nothing to change, or an unknown
    /// `mode` throws (`bad-request`).
    public static func parse(_ value: JSONValue?) throws(ProtocolError) -> ChatSettingsParams {
        let o = try Fields(value, "params")
        let params = ChatSettingsParams(tabId: try o.str("tabId"), mode: try o.optStr("mode"),
                                        model: try o.optStr("model"), effort: try o.optStr("effort"))
        if let mode = params.mode, !TaskOp.modes.contains(mode) { throw ProtocolError("unknown mode \(mode)") }
        if params.mode == nil && params.model == nil && params.effort == nil { throw ProtocolError("nothing to change") }
        return params
    }

    public var json: JSONValue {
        var fields: JSONObject = ["tabId": .string(tabId)]
        if let mode { fields["mode"] = .string(mode) }
        if let model { fields["model"] = .string(model) }
        if let effort { fields["effort"] = .string(effort) }
        return .object(fields)
    }
}

extension ChatImageParams {
    /// The desktop's side: a missing `tabId`, `itemId` or `index` throws
    /// (`bad-request`); `maxSide` is clamped to `minSide`…`maxSide`.
    public static func parse(_ value: JSONValue?) throws(ProtocolError) -> ChatImageParams {
        let o = try Fields(value, "params")
        let maxSide = try o.optInt("maxSide").map { Int(min(Int64(Self.maxSide), max(Int64(Self.minSide), $0))) }
        return ChatImageParams(tabId: try o.str("tabId"), itemId: try o.str("itemId"), index: Int(try o.int("index")), maxSide: maxSide)
    }

    public var json: JSONValue {
        var fields: JSONObject = ["tabId": .string(tabId), "itemId": .string(itemId), "index": .int(Int64(index))]
        if let maxSide { fields["maxSide"] = .int(Int64(maxSide)) }
        return .object(fields)
    }
}

extension ChatImageResult {
    public static func parse(_ value: JSONValue) throws(ProtocolError) -> ChatImageResult {
        let o = try Fields(value, "result")
        let mediaType = try o.str("mediaType")
        guard mediaTypes.contains(mediaType) else { throw ProtocolError("unknown mediaType \(mediaType)") }
        guard let data = Data(base64Encoded: try o.str("data")), !data.isEmpty else { throw ProtocolError("data must be non-empty base64") }
        return ChatImageResult(mediaType: mediaType, data: data)
    }

    public var json: JSONValue {
        .object(["mediaType": .string(mediaType), "data": .string(data.base64EncodedString())])
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
