import Foundation

// The composer's `/` menu (§8.14): `chat.commands`, `chat.btw` and
// `chat.permissions` / `chat.permissions.update`, behind one feature.

/// One row of the `/` menu: a Claude Code command or skill, as the desktop lists it.
public struct ChatCommand: Sendable, Equatable, Identifiable {
    /// Without the leading `/`.
    public var name: String
    public var description: String?
    public var argumentHint: String?
    /// Only works in Claude's terminal UI; shown disabled.
    public var terminalOnly: Bool

    public var id: String { name }

    public init(name: String, description: String? = nil, argumentHint: String? = nil, terminalOnly: Bool = false) {
        self.name = name
        self.description = description
        self.argumentHint = argumentHint
        self.terminalOnly = terminalOnly
    }
}

/// `chat.commands` result.
public struct ChatCommandsResult: Sendable, Equatable {
    public var commands: [ChatCommand]

    public init(commands: [ChatCommand]) {
        self.commands = commands
    }
}

/// `chat.commands` and `chat.permissions` params: just the tab.
public struct ChatTabParams: Sendable, Equatable {
    public var tabId: String

    public init(tabId: String) {
        self.tabId = tabId
    }
}

/// `chat.btw` params: a side question, answered without joining the conversation.
public struct ChatBtwParams: Sendable, Equatable {
    public var tabId: String
    public var question: String

    public init(tabId: String, question: String) {
        self.tabId = tabId
        self.question = question
    }
}

/// `chat.btw` result.
public struct ChatBtwResult: Sendable, Equatable {
    /// nil when Claude had nothing to say (the question was cancelled).
    public var response: String?
    /// The CLI made the answer up itself (an error or refusal), not the model.
    public var synthetic: Bool

    public init(response: String?, synthetic: Bool = false) {
        self.response = response
        self.synthetic = synthetic
    }
}

/// Which settings file a permission rule lives in, most specific first.
public enum ChatPermissionKind: String, Sendable, Equatable, CaseIterable {
    case localSettings, projectSettings, userSettings

    /// The desktop dialog's labels (`PERMISSION_SOURCE_LABELS`).
    public var title: String {
        switch self {
        case .localSettings: "This project, only you"
        case .projectSettings: "This project, shared"
        case .userSettings: "All your projects"
        }
    }

    public var hint: String {
        switch self {
        case .localSettings: ".claude/settings.local.json (not committed)"
        case .projectSettings: ".claude/settings.json (committed)"
        case .userSettings: "~/.claude/settings.json"
        }
    }
}

public enum ChatPermissionBehavior: String, Sendable, Equatable, CaseIterable {
    case allow, ask, deny
}

public enum ChatPermissionAction: String, Sendable, Equatable {
    case add, remove
}

/// One settings file's rules.
public struct ChatPermissionSource: Sendable, Equatable, Identifiable {
    public var kind: ChatPermissionKind
    /// Absolute, on the desktop.
    public var path: String
    public var exists: Bool
    public var allow: [String]
    public var ask: [String]
    public var deny: [String]
    /// The file exists but couldn't be read; it isn't edited.
    public var error: String?

    public var id: String { kind.rawValue }

    public init(kind: ChatPermissionKind, path: String, exists: Bool, allow: [String] = [], ask: [String] = [], deny: [String] = [], error: String? = nil) {
        self.kind = kind
        self.path = path
        self.exists = exists
        self.allow = allow
        self.ask = ask
        self.deny = deny
        self.error = error
    }

    public func rules(_ behavior: ChatPermissionBehavior) -> [String] {
        switch behavior {
        case .allow: allow
        case .ask: ask
        case .deny: deny
        }
    }
}

/// `chat.permissions` and `chat.permissions.update` result.
public struct ChatPermissionsResult: Sendable, Equatable {
    public var sources: [ChatPermissionSource]

    public init(sources: [ChatPermissionSource]) {
        self.sources = sources
    }
}

/// `chat.permissions.update` params: add or remove one rule.
public struct ChatPermissionsUpdateParams: Sendable, Equatable {
    public var tabId: String
    public var kind: ChatPermissionKind
    public var behavior: ChatPermissionBehavior
    public var rule: String
    public var action: ChatPermissionAction

    public init(tabId: String, kind: ChatPermissionKind, behavior: ChatPermissionBehavior, rule: String, action: ChatPermissionAction) {
        self.tabId = tabId
        self.kind = kind
        self.behavior = behavior
        self.rule = rule
        self.action = action
    }
}

// MARK: - The composer's rules

/// What the desktop composer does with `/` text (Composer.tsx), for the phone's.
public enum ChatCommandMenu {
    public static let sideQuestion = "btw"
    public static let permissions = "permissions"

    /// The menu's query when `text` is `/` and a word (no whitespace anywhere), else nil.
    public static func query(_ text: String) -> String? {
        guard text.hasPrefix("/"), !text.contains(where: \.isWhitespace) else { return nil }
        return String(text.dropFirst())
    }

    /// The desktop's ranking: names starting with the query first, then, from two
    /// characters on, names containing it; each by name, at most 50.
    public static func matches(_ commands: [ChatCommand], query: String) -> [ChatCommand] {
        let q = query.lowercased()
        func rank(_ name: String) -> Int {
            let lower = name.lowercased()
            return lower.hasPrefix(q) ? 0 : lower.contains(q) ? 1 : 2
        }
        let cutoff = q.count > 1 ? 2 : 1
        let ranked = commands.map { (command: $0, rank: rank($0.name)) }.filter { $0.rank < cutoff }
        let sorted = ranked.sorted { a, b in
            a.rank != b.rank ? a.rank < b.rank : a.command.name.localizedCompare(b.command.name) == .orderedAscending
        }
        return Array(sorted.prefix(50).map(\.command))
    }

    /// The command a message starts with (`/name …`), without the slash.
    public static func command(in text: String) -> String? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.hasPrefix("/") else { return nil }
        let name = trimmed.dropFirst().prefix { !$0.isWhitespace }
        return name.isEmpty ? nil : String(name)
    }

    /// The question in `/btw <question>`: "" for a bare `/btw`, nil for anything else
    /// (`parseSideQuestion`).
    public static func sideQuestion(in text: String) -> String? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.hasPrefix("/" + sideQuestion) else { return nil }
        let rest = trimmed.dropFirst(sideQuestion.count + 1)
        if rest.isEmpty { return "" }
        guard rest.first?.isWhitespace == true else { return nil }
        return rest.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

// MARK: - Parsing

extension ChatCommandsResult {
    /// `terminalOnly` other than `true` is absent.
    public static func parse(_ value: JSONValue) throws(ProtocolError) -> ChatCommandsResult {
        let o = try Fields(value, "result")
        let commands = try o.array("commands").map { (raw: JSONValue) throws(ProtocolError) -> ChatCommand in
            let c = try Fields(raw, "command")
            return ChatCommand(name: try c.str("name"), description: try c.optStr("description"),
                               argumentHint: try c.optStr("argumentHint"), terminalOnly: c.flag("terminalOnly"))
        }
        return ChatCommandsResult(commands: commands)
    }

    public var json: JSONValue {
        .object(["commands": .array(commands.map { command in
            var fields: JSONObject = ["name": .string(command.name)]
            if let description = command.description { fields["description"] = .string(description) }
            if let hint = command.argumentHint { fields["argumentHint"] = .string(hint) }
            if command.terminalOnly { fields["terminalOnly"] = .bool(true) }
            return .object(fields)
        })])
    }
}

extension ChatTabParams {
    public static func parse(_ value: JSONValue?) throws(ProtocolError) -> ChatTabParams {
        ChatTabParams(tabId: try Fields(value, "params").str("tabId"))
    }

    public var json: JSONValue { .object(["tabId": .string(tabId)]) }
}

extension ChatBtwParams {
    /// The desktop's side: a missing `tabId`, or a blank question or one over
    /// `ChatOp.maxBtwLength` characters throws (`bad-request`).
    public static func parse(_ value: JSONValue?) throws(ProtocolError) -> ChatBtwParams {
        let o = try Fields(value, "params")
        let tabId = try o.str("tabId")
        let question = try o.str("question")
        if question.utf16.count > ChatOp.maxBtwLength { throw ProtocolError("question over \(ChatOp.maxBtwLength) characters") }
        if question.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { throw ProtocolError("question is empty") }
        return ChatBtwParams(tabId: tabId, question: question)
    }

    public var json: JSONValue { .object(["tabId": .string(tabId), "question": .string(question)]) }
}

extension ChatBtwResult {
    /// An absent `response` reads as nil.
    public static func parse(_ value: JSONValue) throws(ProtocolError) -> ChatBtwResult {
        let o = try Fields(value, "result")
        return ChatBtwResult(response: try o.optStr("response"), synthetic: o.flag("synthetic"))
    }

    public var json: JSONValue {
        var fields: JSONObject = ["response": response.map(JSONValue.string) ?? .null]
        if synthetic { fields["synthetic"] = .bool(true) }
        return .object(fields)
    }
}

extension ChatPermissionsResult {
    /// A source of a kind this build doesn't know is skipped.
    public static func parse(_ value: JSONValue) throws(ProtocolError) -> ChatPermissionsResult {
        let o = try Fields(value, "result")
        var sources: [ChatPermissionSource] = []
        for raw in try o.array("sources") {
            let s = try Fields(raw, "source")
            guard let kind = ChatPermissionKind(rawValue: try s.str("kind")) else { continue }
            sources.append(ChatPermissionSource(
                kind: kind, path: try s.str("path"), exists: try s.bool("exists"),
                allow: try s.strings("allow"), ask: try s.strings("ask"), deny: try s.strings("deny"),
                error: try s.optStr("error")))
        }
        return ChatPermissionsResult(sources: sources)
    }

    public var json: JSONValue {
        .object(["sources": .array(sources.map { source in
            var fields: JSONObject = [
                "kind": .string(source.kind.rawValue), "path": .string(source.path), "exists": .bool(source.exists),
                "allow": .array(source.allow.map(JSONValue.string)), "ask": .array(source.ask.map(JSONValue.string)),
                "deny": .array(source.deny.map(JSONValue.string)),
            ]
            if let error = source.error { fields["error"] = .string(error) }
            return .object(fields)
        })])
    }
}

extension ChatPermissionsUpdateParams {
    /// The desktop's side: an unknown `kind`, `behavior` or `action`, or a blank
    /// rule or one over `ChatOp.maxRuleLength` characters throws (`bad-request`).
    public static func parse(_ value: JSONValue?) throws(ProtocolError) -> ChatPermissionsUpdateParams {
        let o = try Fields(value, "params")
        let tabId = try o.str("tabId")
        let kind = ChatPermissionKind(rawValue: try o.oneOf("kind", ChatPermissionKind.allCases.map(\.rawValue)))!
        let behavior = ChatPermissionBehavior(rawValue: try o.oneOf("behavior", ChatPermissionBehavior.allCases.map(\.rawValue)))!
        let rule = try o.str("rule")
        if rule.utf16.count > ChatOp.maxRuleLength { throw ProtocolError("rule over \(ChatOp.maxRuleLength) characters") }
        if rule.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { throw ProtocolError("rule is empty") }
        let action = ChatPermissionAction(rawValue: try o.oneOf("action", ["add", "remove"]))!
        return ChatPermissionsUpdateParams(tabId: tabId, kind: kind, behavior: behavior, rule: rule, action: action)
    }

    public var json: JSONValue {
        .object([
            "tabId": .string(tabId), "kind": .string(kind.rawValue), "behavior": .string(behavior.rawValue),
            "rule": .string(rule), "action": .string(action.rawValue),
        ])
    }
}

extension Fields {
    func strings(_ key: String) throws(ProtocolError) -> [String] {
        try array(key).map { (value: JSONValue) throws(ProtocolError) -> String in
            guard case .string(let s) = value else { throw ProtocolError("\(key) must hold strings") }
            return s
        }
    }
}
