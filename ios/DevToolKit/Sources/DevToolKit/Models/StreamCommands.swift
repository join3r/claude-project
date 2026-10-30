import Foundation

/// `stream.commands.get` and `stream.commands.suggest` (§8.21) params: the
/// project's own commands (no `streamId`) or a stream's own.
public struct StreamCommandsParams: Sendable, Equatable {
    public var projectId: String
    public var streamId: String?

    public init(projectId: String, streamId: String? = nil) {
        self.projectId = projectId
        self.streamId = streamId
    }

    /// The desktop's side: a missing `projectId` or an empty `streamId` throws.
    public static func parse(_ value: JSONValue?) throws(ProtocolError) -> StreamCommandsParams {
        let o = try Fields(value, "params")
        return StreamCommandsParams(projectId: try o.str("projectId"), streamId: try o.optNonEmpty("streamId"))
    }

    public var json: JSONValue {
        var o: JSONObject = ["projectId": .string(projectId)]
        if let streamId { o["streamId"] = .string(streamId) }
        return .object(o)
    }
}

/// `stream.commands.get` result: that list's commands and, for a stream, the
/// project's (`inherited`, empty when there are none).
public struct StreamCommandsResult: Sendable, Equatable {
    public var commands: [InboxRunCommand]
    public var inherited: [InboxRunCommand]

    public init(commands: [InboxRunCommand], inherited: [InboxRunCommand] = []) {
        self.commands = commands
        self.inherited = inherited
    }

    public static func parse(_ value: JSONValue) throws(ProtocolError) -> StreamCommandsResult {
        let o = try Fields(value, "result")
        var commands: [InboxRunCommand] = []
        for item in try o.array("commands") { commands.append(try InboxRunCommand.parse(item)) }
        var inherited: [InboxRunCommand] = []
        if !o.isUnset("inherited") {
            for item in try o.array("inherited") { inherited.append(try InboxRunCommand.parse(item)) }
        }
        return StreamCommandsResult(commands: commands, inherited: inherited)
    }

    public var json: JSONValue {
        var o: JSONObject = ["commands": .array(commands.map(\.json))]
        if !inherited.isEmpty { o["inherited"] = .array(inherited.map(\.json)) }
        return .object(o)
    }
}

/// A command as the phone sends it: `id` keeps one already saved in that list
/// (its run is keyed by it); nil gets a fresh id on the desktop.
public struct StreamCommandEntry: Sendable, Equatable, Hashable {
    public var id: String?
    public var name: String
    public var command: String

    public init(id: String? = nil, name: String, command: String) {
        self.id = id
        self.name = name
        self.command = command
    }
}

/// `stream.commands.set` (§8.21) params: the whole list, replacing what is saved there.
public struct StreamCommandsSetParams: Sendable, Equatable {
    /// At most this many commands in a list.
    public static let maxCommands = 20
    /// A name's and a command line's length limits (UTF-16, after trimming).
    public static let nameLimit = 60
    public static let commandLimit = 2000

    public var projectId: String
    public var streamId: String?
    public var commands: [StreamCommandEntry]

    public init(projectId: String, streamId: String? = nil, commands: [StreamCommandEntry]) {
        self.projectId = projectId
        self.streamId = streamId
        self.commands = commands
    }

    /// The desktop's side: a missing `projectId`, an empty `streamId` or `id`,
    /// a blank or too-long name or command, more than `maxCommands`, or two
    /// names equal ignoring case throws. Names and commands come back trimmed.
    public static func parse(_ value: JSONValue?) throws(ProtocolError) -> StreamCommandsSetParams {
        let o = try Fields(value, "params")
        let list = try o.array("commands")
        guard list.count <= maxCommands else { throw ProtocolError("more than \(maxCommands) commands") }
        var seen = Set<String>()
        var commands: [StreamCommandEntry] = []
        for item in list {
            let c = try Fields(item, "command")
            let name = try c.str("name").trimmingCharacters(in: .whitespacesAndNewlines)
            let command = try c.str("command").trimmingCharacters(in: .whitespacesAndNewlines)
            guard !name.isEmpty else { throw ProtocolError("name is empty") }
            guard !command.isEmpty else { throw ProtocolError("command is empty") }
            guard name.utf16.count <= nameLimit else { throw ProtocolError("name over \(nameLimit) characters") }
            guard command.utf16.count <= commandLimit else { throw ProtocolError("command over \(commandLimit) characters") }
            guard seen.insert(name.lowercased()).inserted else { throw ProtocolError("two commands are named \"\(name)\"") }
            commands.append(StreamCommandEntry(id: try c.optNonEmpty("id"), name: name, command: command))
        }
        return StreamCommandsSetParams(projectId: try o.str("projectId"), streamId: try o.optNonEmpty("streamId"), commands: commands)
    }

    public var json: JSONValue {
        var o: JSONObject = [
            "projectId": .string(projectId),
            "commands": .array(commands.map { entry in
                var c: JSONObject = ["name": .string(entry.name), "command": .string(entry.command)]
                if let id = entry.id { c["id"] = .string(id) }
                return .object(c)
            }),
        ]
        if let streamId { o["streamId"] = .string(streamId) }
        return .object(o)
    }
}

/// A command Claude suggests: no id, nothing saved yet.
public struct SuggestedCommand: Sendable, Equatable, Hashable {
    public var name: String
    public var command: String

    public init(name: String, command: String) {
        self.name = name
        self.command = command
    }
}

/// `stream.commands.suggest` result.
public struct StreamCommandsSuggestResult: Sendable, Equatable {
    public var commands: [SuggestedCommand]

    public init(commands: [SuggestedCommand]) {
        self.commands = commands
    }

    public static func parse(_ value: JSONValue) throws(ProtocolError) -> StreamCommandsSuggestResult {
        let o = try Fields(value, "result")
        var commands: [SuggestedCommand] = []
        for item in try o.array("commands") {
            let c = try Fields(item, "command")
            commands.append(SuggestedCommand(name: try c.str("name"), command: try c.str("command")))
        }
        return StreamCommandsSuggestResult(commands: commands)
    }

    public var json: JSONValue {
        .object(["commands": .array(commands.map { .object(["name": .string($0.name), "command": .string($0.command)]) })])
    }
}

extension TaskOp {
    /// `stream.commands.get` (§8.21): a project's or a stream's own commands.
    public static let streamCommandsGet = "stream.commands.get"
    /// `stream.commands.set` (§8.21): replace that list.
    public static let streamCommandsSet = "stream.commands.set"
    /// `stream.commands.suggest` (§8.21): what Claude suggests for it; nothing is saved.
    public static let streamCommandsSuggest = "stream.commands.suggest"
}

// MARK: - The Commands sheet's rows

/// One row of the Commands sheet: may still be blank. `key` tells rows apart
/// on the phone; `savedId` is the saved command it edits (nil: a new one).
public struct RunCommandDraft: Sendable, Equatable, Identifiable {
    public var key: String
    public var savedId: String?
    public var name: String
    public var command: String

    public init(key: String = UUID().uuidString, savedId: String? = nil, name: String = "", command: String = "") {
        self.key = key
        self.savedId = savedId
        self.name = name
        self.command = command
    }

    public init(_ saved: InboxRunCommand) {
        self.init(savedId: saved.id.isEmpty ? nil : saved.id, name: saved.name, command: saved.command)
    }

    public var id: String { key }

    var trimmedName: String { name.trimmingCharacters(in: .whitespacesAndNewlines) }
    var trimmedCommand: String { command.trimmingCharacters(in: .whitespacesAndNewlines) }
    /// Neither a name nor a command: left out when saving.
    public var isBlank: Bool { trimmedName.isEmpty && trimmedCommand.isEmpty }
}

public enum RunCommandDrafts {
    /// The rows to save, trimmed; blank rows are left out.
    public static func entries(_ drafts: [RunCommandDraft]) -> [StreamCommandEntry] {
        drafts.filter { !$0.isBlank }.map { StreamCommandEntry(id: $0.savedId, name: $0.trimmedName, command: $0.trimmedCommand) }
    }

    /// Why the rows can't be saved, as the desktop would refuse them; nil when they can.
    public static func problem(_ drafts: [RunCommandDraft]) -> String? {
        let rows = drafts.filter { !$0.isBlank }
        if rows.contains(where: { $0.trimmedName.isEmpty || $0.trimmedCommand.isEmpty }) {
            return "Each command needs a name and a command line."
        }
        if rows.count > StreamCommandsSetParams.maxCommands { return "At most \(StreamCommandsSetParams.maxCommands) commands." }
        if let row = rows.first(where: { $0.trimmedName.utf16.count > StreamCommandsSetParams.nameLimit }) {
            return "“\(row.trimmedName.prefix(20))…” is longer than \(StreamCommandsSetParams.nameLimit) characters."
        }
        if let row = rows.first(where: { $0.trimmedCommand.utf16.count > StreamCommandsSetParams.commandLimit }) {
            return "\(row.trimmedName)’s command is longer than \(StreamCommandsSetParams.commandLimit) characters."
        }
        var seen = Set<String>()
        for row in rows where !seen.insert(row.trimmedName.lowercased()).inserted {
            return "Two commands are named “\(row.trimmedName)”."
        }
        return nil
    }

    /// Suggested commands into the rows, as the desktop's editor does it
    /// (`mergeSuggestedCommands`): blank rows go; one named like a row (ignoring
    /// case) sets that row's command; the others are added at the end, except
    /// one the same as an `inherited` command (a stream's project command).
    /// `changed` holds the keys of the rows set or added.
    public static func merge(
        _ drafts: [RunCommandDraft],
        suggested: [SuggestedCommand],
        inherited: [InboxRunCommand] = [],
        newKey: () -> String = { UUID().uuidString }
    ) -> (next: [RunCommandDraft], changed: [String]) {
        var next = drafts.filter { !$0.isBlank }
        var changed: [String] = []
        for suggestion in suggested {
            let key = suggestion.name.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            if let index = next.firstIndex(where: { $0.trimmedName.lowercased() == key }) {
                if next[index].trimmedCommand == suggestion.command { continue }
                next[index].command = suggestion.command
                changed.append(next[index].key)
                continue
            }
            if inherited.contains(where: { $0.name.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == key
                && $0.command.trimmingCharacters(in: .whitespacesAndNewlines) == suggestion.command }) { continue }
            let row = RunCommandDraft(key: newKey(), name: suggestion.name, command: suggestion.command)
            next.append(row)
            changed.append(row.key)
        }
        return (next, changed)
    }
}
