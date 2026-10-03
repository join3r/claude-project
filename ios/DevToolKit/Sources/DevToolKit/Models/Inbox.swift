import Foundation

/// A full snapshot of one desktop's projects, tasks and agent tabs
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

    public func isPinned(projectId: String, taskId: String? = nil) -> Bool {
        pinned.contains(InboxPin(projectId: projectId, taskId: taskId))
    }

    /// The pins this inbox can show, in order. A pin whose project or task
    /// isn't here is skipped (§4.4).
    public var resolvedPins: [ResolvedPin] {
        pinned.compactMap { pin in
            guard let project = projects.first(where: { $0.id == pin.projectId }) else { return nil }
            guard let taskId = pin.taskId else { return .project(project) }
            guard let task = project.tasks.first(where: { $0.id == taskId }) else { return nil }
            return .task(task, project: project)
        }
    }
}

/// One entry of the desktop's Pinned list: a project, or one of its tasks.
public struct InboxPin: Codable, Sendable, Hashable {
    public var projectId: String
    public var taskId: String?

    public init(projectId: String, taskId: String? = nil) {
        self.projectId = projectId
        self.taskId = taskId
    }
}

/// A pin matched to what it names in the inbox.
public enum ResolvedPin: Sendable, Equatable, Identifiable {
    case project(InboxProject)
    case task(InboxTask, project: InboxProject)

    public var id: String {
        switch self {
        case .project(let project): "project:\(project.id)"
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
    public var tasks: [InboxTask]

    public init(id: String, name: String, emoji: String? = nil, remote: Bool = false, tasks: [InboxTask]) {
        self.id = id
        self.name = name
        self.emoji = emoji
        self.remote = remote
        self.tasks = tasks
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        name = try c.decode(String.self, forKey: .name)
        emoji = try c.decodeIfPresent(String.self, forKey: .emoji)
        remote = try c.decodeIfPresent(Bool.self, forKey: .remote) ?? false
        tasks = try c.decodeIfPresent([InboxTask].self, forKey: .tasks) ?? []
    }
}

public struct InboxTask: Codable, Sendable, Equatable, Identifiable {
    public var id: String
    public var name: String
    /// Unix milliseconds.
    public var lastInteractedAt: Int64?
    /// Unix milliseconds. Set while a tab needs the user.
    public var attentionAt: Int64?
    /// Set on a workspace task: the branch of its worktree (§4.4).
    public var branch: String?
    public var tabs: [InboxTab]

    public init(id: String, name: String, lastInteractedAt: Int64? = nil, attentionAt: Int64? = nil, branch: String? = nil, tabs: [InboxTab]) {
        self.id = id
        self.name = name
        self.lastInteractedAt = lastInteractedAt
        self.attentionAt = attentionAt
        self.branch = branch
        self.tabs = tabs
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        name = try c.decode(String.self, forKey: .name)
        lastInteractedAt = try c.decodeIfPresent(Int64.self, forKey: .lastInteractedAt)
        attentionAt = try c.decodeIfPresent(Int64.self, forKey: .attentionAt)
        branch = try c.decodeIfPresent(String.self, forKey: .branch)
        tabs = try c.decodeIfPresent([InboxTab].self, forKey: .tabs) ?? []
    }

    /// The most significant status across the task's tabs.
    public var summaryStatus: TabStatus {
        tabs.map(\.status).max(by: { $0.priority < $1.priority }) ?? .idle
    }

    /// Sort key for task lists: attention first by recency, then last interaction.
    public var sortTimestamp: Int64 {
        max(attentionAt ?? 0, lastInteractedAt ?? 0)
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

    public init(id: String, type: TabType, title: String, status: TabStatus, since: Int64? = nil, activity: String? = nil) {
        self.id = id
        self.type = type
        self.title = title
        self.status = status
        self.since = since
        self.activity = activity
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
