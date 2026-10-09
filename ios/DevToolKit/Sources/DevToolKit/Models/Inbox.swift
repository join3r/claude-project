import Foundation

/// A full snapshot of one desktop's projects, streams, tasks and agent tabs
/// (spec §4.4). Every `inbox` event replaces the previous one.
///
/// Decoding is tolerant: unknown fields are ignored, unknown enum values map
/// to `.unknown`, and a missing array decodes as empty.
public struct Inbox: Codable, Sendable, Equatable {
    public var desktop: InboxDesktop
    /// Unix milliseconds.
    public var generatedAt: Int64
    public var projects: [InboxProject]
    /// The desktop sidebar's Pinned list, in its order (§4.4).
    public var pinned: [InboxPin]

    public init(desktop: InboxDesktop, generatedAt: Int64, projects: [InboxProject], pinned: [InboxPin] = []) {
        self.desktop = desktop
        self.generatedAt = generatedAt
        self.projects = projects
        self.pinned = pinned
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        desktop = try c.decode(InboxDesktop.self, forKey: .desktop)
        generatedAt = try c.decodeIfPresent(Int64.self, forKey: .generatedAt) ?? 0
        projects = try c.decodeIfPresent([InboxProject].self, forKey: .projects) ?? []
        pinned = try c.decodeIfPresent([InboxPin].self, forKey: .pinned) ?? []
    }

    public var generatedDate: Date { Date(unixMilliseconds: generatedAt) }

    /// Whether the desktop's Pinned list holds exactly this pin: a project
    /// pin, a stream pin, or a task pin (matched by task, whatever stream it
    /// names). A task of a pinned stream is not pinned by itself.
    public func isPinned(_ pin: InboxPin) -> Bool {
        pinned.contains { $0.key == pin.key }
    }

    /// The pins this inbox can show, in order. A pin whose project, stream or
    /// task isn't here is skipped (§4.4).
    public var resolvedPins: [ResolvedPin] {
        pinned.compactMap { pin in
            guard let project = projects.first(where: { $0.id == pin.projectId }) else { return nil }
            if let taskId = pin.taskId {
                guard let task = project.tasks.first(where: { $0.id == taskId }) else { return nil }
                return .task(task, project: project)
            }
            if let streamId = pin.streamId {
                guard let stream = project.streams.first(where: { $0.id == streamId }) else { return nil }
                return .stream(stream, project: project)
            }
            return .project(project)
        }
    }
}

/// One entry of the desktop's Pinned list: a project, one of its streams
/// (`streamId`), or one of its tasks (`taskId`, with the stream holding it).
public struct InboxPin: Codable, Sendable, Hashable {
    public var projectId: String
    public var streamId: String?
    public var taskId: String?

    public init(projectId: String, streamId: String? = nil, taskId: String? = nil) {
        self.projectId = projectId
        self.streamId = streamId
        self.taskId = taskId
    }

    public static func project(_ project: InboxProject) -> InboxPin { InboxPin(projectId: project.id) }
    public static func stream(_ stream: InboxStream, in project: InboxProject) -> InboxPin {
        InboxPin(projectId: project.id, streamId: stream.id)
    }
    public static func task(_ task: InboxTask, in project: InboxProject) -> InboxPin {
        InboxPin(projectId: project.id, streamId: task.streamId, taskId: task.id)
    }

    /// What the pin names, as the desktop's `pinnedItemKey`: a task pin is the
    /// task's whatever stream it names.
    public var key: String {
        if let taskId { return "task:\(projectId):\(taskId)" }
        if let streamId { return "stream:\(projectId):\(streamId)" }
        return "project:\(projectId)"
    }
}

/// A pin matched to what it names in the inbox.
public enum ResolvedPin: Sendable, Equatable, Identifiable {
    case project(InboxProject)
    case stream(InboxStream, project: InboxProject)
    case task(InboxTask, project: InboxProject)

    public var id: String {
        switch self {
        case .project(let project): "project:\(project.id)"
        case .stream(let stream, let project): "stream:\(project.id):\(stream.id)"
        case .task(let task, let project): "task:\(project.id):\(task.id)"
        }
    }
}

public struct InboxDesktop: Codable, Sendable, Equatable {
    public var id: String
    public var name: String

    public init(id: String, name: String) {
        self.id = id
        self.name = name
    }
}

public struct InboxProject: Codable, Sendable, Equatable, Identifiable {
    public var id: String
    public var name: String
    public var emoji: String?
    public var remote: Bool
    /// Open streams in the desktop sidebar's order, `main` first, empty ones included.
    public var streams: [InboxStream]
    /// The stream the project was last used in: New task's default.
    public var lastStreamId: String?
    /// Open tasks, stream by stream.
    public var tasks: [InboxTask]

    public init(id: String, name: String, emoji: String? = nil, remote: Bool = false,
                streams: [InboxStream] = [], lastStreamId: String? = nil, tasks: [InboxTask]) {
        self.id = id
        self.name = name
        self.emoji = emoji
        self.remote = remote
        self.streams = streams
        self.lastStreamId = lastStreamId
        self.tasks = tasks
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        name = try c.decode(String.self, forKey: .name)
        emoji = try c.decodeIfPresent(String.self, forKey: .emoji)
        remote = try c.decodeIfPresent(Bool.self, forKey: .remote) ?? false
        streams = try c.decodeIfPresent([InboxStream].self, forKey: .streams) ?? []
        lastStreamId = try c.decodeIfPresent(String.self, forKey: .lastStreamId)
        tasks = try c.decodeIfPresent([InboxTask].self, forKey: .tasks) ?? []
    }

    /// The `main` stream (the project folder).
    public var mainStream: InboxStream? {
        streams.first(where: \.isMain) ?? streams.first
    }

    /// New task's default stream: the one last used, else `main` (§8.3).
    public var defaultStream: InboxStream? {
        streams.first(where: { $0.id == lastStreamId }) ?? mainStream
    }

    /// The tasks of one stream, in the desktop's order.
    public func tasks(in stream: InboxStream) -> [InboxTask] {
        tasks.filter { $0.streamId == stream.id }
    }

    /// The task list grouped by stream, in `streams` order. Streams with no
    /// task are left out; a task naming a stream that isn't listed gets a
    /// group of its own at the end (it shouldn't happen).
    public var streamGroups: [(stream: InboxStream, tasks: [InboxTask])] {
        var groups: [(stream: InboxStream, tasks: [InboxTask])] = streams.compactMap { stream in
            let list = self.tasks(in: stream)
            return list.isEmpty ? nil : (stream, list)
        }
        let known = Set(streams.map(\.id))
        for task in tasks where !known.contains(task.streamId) {
            if let i = groups.firstIndex(where: { $0.stream.id == task.streamId }) {
                groups[i].tasks.append(task)
            } else {
                groups.append((InboxStream(id: task.streamId, name: task.streamName), [task]))
            }
        }
        return groups
    }
}

/// A line of work in a project (§4.4), e.g. `main`, `0.5.0`, `bugfixes`.
public struct InboxStream: Codable, Sendable, Equatable, Hashable, Identifiable {
    public var id: String
    public var name: String
    /// The project's default stream (its folder); it can't be closed.
    public var isMain: Bool
    /// Set on a worktree stream: its branch.
    public var branch: String?

    public init(id: String, name: String, isMain: Bool = false, branch: String? = nil) {
        self.id = id
        self.name = name
        self.isMain = isMain
        self.branch = branch
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        name = try c.decodeIfPresent(String.self, forKey: .name) ?? ""
        isMain = (try? c.decodeIfPresent(Bool.self, forKey: .isMain)) == true
        branch = try c.decodeIfPresent(String.self, forKey: .branch)
    }
}

public struct InboxTask: Codable, Sendable, Equatable, Identifiable {
    public var id: String
    public var name: String
    /// The stream holding the task, and its name (the `Project · Stream` line).
    public var streamId: String
    public var streamName: String
    /// The task's one status: the strongest of its main tab and agent tabs
    /// (§4.4). An extra terminal's bell doesn't count.
    public var status: TabStatus
    /// Unix milliseconds when `status` began.
    public var since: Int64?
    /// What the agent is doing, e.g. "Running Bash".
    public var activity: String?
    /// Unix milliseconds.
    public var lastInteractedAt: Int64?
    /// Unix milliseconds. Set while a tab needs the user.
    public var attentionAt: Int64?
    /// Unix milliseconds. The task's last event: a hook notification or
    /// stop, a terminal bell, a process exit (§4.4).
    public var eventAt: Int64?
    /// The desktop counts the task unread (§4.4).
    public var unread: Bool
    /// Unix milliseconds. Set while the task is settled.
    public var settledAt: Int64?
    /// Unix milliseconds. A timed snooze; it ends on the phone's clock.
    public var snoozedUntil: Int64?
    /// Snoozed until the task next needs the user.
    public var snoozeUntilAttention: Bool
    /// The task's own worktree branch (version 3, §4.4); nil for a task that
    /// works in its stream's folder. Closing such a task lands it.
    public var branch: String?
    /// Present while the task lands into its stream or has stopped doing so (§4.4).
    public var landing: TaskLanding?
    public var tabs: [InboxTab]

    public init(
        id: String, name: String, streamId: String = "", streamName: String = "",
        status: TabStatus = .idle, since: Int64? = nil, activity: String? = nil,
        lastInteractedAt: Int64? = nil, attentionAt: Int64? = nil,
        eventAt: Int64? = nil, unread: Bool = false, settledAt: Int64? = nil,
        snoozedUntil: Int64? = nil, snoozeUntilAttention: Bool = false,
        branch: String? = nil, landing: TaskLanding? = nil,
        tabs: [InboxTab]
    ) {
        self.id = id
        self.name = name
        self.streamId = streamId
        self.streamName = streamName
        self.status = status
        self.since = since
        self.activity = activity
        self.lastInteractedAt = lastInteractedAt
        self.attentionAt = attentionAt
        self.eventAt = eventAt
        self.unread = unread
        self.settledAt = settledAt
        self.snoozedUntil = snoozedUntil
        self.snoozeUntilAttention = snoozeUntilAttention
        self.branch = branch
        self.landing = landing
        self.tabs = tabs
    }

    /// Also reads an inbox cached by a version 1 build (no streams, status per
    /// tab only) until the desktop sends a fresh one.
    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        name = try c.decode(String.self, forKey: .name)
        streamId = try c.decodeIfPresent(String.self, forKey: .streamId) ?? ""
        streamName = try c.decodeIfPresent(String.self, forKey: .streamName) ?? ""
        since = try c.decodeIfPresent(Int64.self, forKey: .since)
        activity = try c.decodeIfPresent(String.self, forKey: .activity)
        lastInteractedAt = try c.decodeIfPresent(Int64.self, forKey: .lastInteractedAt)
        attentionAt = try c.decodeIfPresent(Int64.self, forKey: .attentionAt)
        eventAt = try c.decodeIfPresent(Int64.self, forKey: .eventAt)
        unread = (try? c.decodeIfPresent(Bool.self, forKey: .unread)) == true
        settledAt = try c.decodeIfPresent(Int64.self, forKey: .settledAt)
        snoozedUntil = try c.decodeIfPresent(Int64.self, forKey: .snoozedUntil)
        snoozeUntilAttention = (try? c.decodeIfPresent(Bool.self, forKey: .snoozeUntilAttention)) == true
        branch = try c.decodeIfPresent(String.self, forKey: .branch)
        landing = (try? c.decodeIfPresent(TaskLanding.self, forKey: .landing)) ?? nil
        tabs = try c.decodeIfPresent([InboxTab].self, forKey: .tabs) ?? []
        status = try c.decodeIfPresent(TabStatus.self, forKey: .status)
            ?? tabs.map(\.status).max(by: { $0.priority < $1.priority }) ?? .idle
    }

    /// Sort key for task lists: attention first by recency, then last interaction.
    public var sortTimestamp: Int64 {
        max(attentionAt ?? 0, lastInteractedAt ?? 0)
    }

    /// Last time anything happened in the task, ours or the agent's (the
    /// desktop's `lastActivityAt`).
    public var lastActivityAt: Int64 {
        max(eventAt ?? 0, lastInteractedAt ?? 0)
    }

    /// Snoozed at `now`: until it needs you, or until `snoozedUntil` on the phone's clock.
    public func isSnoozed(now: Date) -> Bool {
        if snoozeUntilAttention { return true }
        guard let snoozedUntil else { return false }
        return now.unixMilliseconds < snoozedUntil
    }

}

public struct InboxTab: Codable, Sendable, Equatable, Identifiable {
    public var id: String
    public var type: TabType
    public var title: String
    public var status: TabStatus
    /// Unix milliseconds when `status` last changed.
    public var since: Int64?
    /// Short label derived from the agent's current activity, e.g. "Running Bash".
    public var activity: String?
    /// What an agent tab's conversation is about: Claude's session title, else the last prompt.
    public var topic: String?

    public init(id: String, type: TabType, title: String, status: TabStatus, since: Int64? = nil, activity: String? = nil, topic: String? = nil) {
        self.id = id
        self.type = type
        self.title = title
        self.status = status
        self.since = since
        self.activity = activity
        self.topic = topic
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        type = try c.decodeIfPresent(TabType.self, forKey: .type) ?? .unknown("")
        title = try c.decodeIfPresent(String.self, forKey: .title) ?? ""
        // `null` means idle on the desktop side (spec §4.4).
        status = try c.decodeIfPresent(TabStatus.self, forKey: .status) ?? .idle
        since = try c.decodeIfPresent(Int64.self, forKey: .since)
        activity = try c.decodeIfPresent(String.self, forKey: .activity)
        topic = try c.decodeIfPresent(String.self, forKey: .topic)
    }
}

public enum TabStatus: Sendable, Hashable, Codable {
    case working
    case attention
    case exited
    case idle
    case unknown(String)

    public init(rawValue: String) {
        switch rawValue {
        case "working": self = .working
        case "attention": self = .attention
        case "exited": self = .exited
        case "idle": self = .idle
        default: self = .unknown(rawValue)
        }
    }

    public var rawValue: String {
        switch self {
        case .working: "working"
        case .attention: "attention"
        case .exited: "exited"
        case .idle: "idle"
        case .unknown(let raw): raw
        }
    }

    /// Higher wins when summarising a task: attention > working > exited > idle.
    public var priority: Int {
        switch self {
        case .attention: 4
        case .working: 3
        case .exited: 2
        case .unknown: 1
        case .idle: 0
        }
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.singleValueContainer()
        self = c.decodeNil() ? .idle : TabStatus(rawValue: try c.decode(String.self))
    }

    public func encode(to encoder: any Encoder) throws {
        var c = encoder.singleValueContainer()
        try c.encode(rawValue)
    }
}

public enum TabType: Sendable, Hashable, Codable {
    case claudeChat
    case claude
    case codex
    case pi
    case terminal
    case unknown(String)

    public init(rawValue: String) {
        switch rawValue {
        case "claude-chat": self = .claudeChat
        case "claude": self = .claude
        case "codex": self = .codex
        case "pi": self = .pi
        case "terminal": self = .terminal
        default: self = .unknown(rawValue)
        }
    }

    public var rawValue: String {
        switch self {
        case .claudeChat: "claude-chat"
        case .claude: "claude"
        case .codex: "codex"
        case .pi: "pi"
        case .terminal: "terminal"
        case .unknown(let raw): raw
        }
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.singleValueContainer()
        self = c.decodeNil() ? .unknown("") : TabType(rawValue: try c.decode(String.self))
    }

    public func encode(to encoder: any Encoder) throws {
        var c = encoder.singleValueContainer()
        try c.encode(rawValue)
    }
}

extension Date {
    public init(unixMilliseconds ms: Int64) {
        self.init(timeIntervalSince1970: TimeInterval(ms) / 1000)
    }

    public var unixMilliseconds: Int64 {
        Int64((timeIntervalSince1970 * 1000).rounded())
    }
}
