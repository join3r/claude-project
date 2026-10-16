import Foundation

// `!command` in the composer (§8.17): `chat.bash`, behind its own feature.

/// `chat.bash` params: a shell command the desktop runs in the chat's shell.
public struct ChatBashParams: Sendable, Equatable {
    public var tabId: String
    public var command: String

    public init(tabId: String, command: String) {
        self.tabId = tabId
        self.command = command
    }
}

extension ChatBashParams {
    /// The desktop's side: a missing `tabId`, or a blank command or one over
    /// `ChatOp.maxBashLength` characters throws (`bad-request`).
    public static func parse(_ value: JSONValue?) throws(ProtocolError) -> ChatBashParams {
        let o = try Fields(value, "params")
        let tabId = try o.str("tabId")
        let command = try o.str("command")
        if command.utf16.count > ChatOp.maxBashLength { throw ProtocolError("command over \(ChatOp.maxBashLength) characters") }
        if command.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { throw ProtocolError("command is empty") }
        return ChatBashParams(tabId: tabId, command: command)
    }

    public var json: JSONValue { .object(["tabId": .string(tabId), "command": .string(command)]) }
}

/// The composer's bash mode, as the desktop's.
public enum ChatBashMode {
    /// True while the draft starts with `!` (leading whitespace aside).
    public static func isOn(_ text: String) -> Bool {
        text.drop { $0.isWhitespace }.first == "!"
    }

    /// What a send of `text` runs: what follows the `!`, trimmed, "" for a bare
    /// `!` (which does nothing), nil when `text` isn't a shell command.
    public static func command(in text: String) -> String? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.hasPrefix("!") else { return nil }
        return String(trimmed.dropFirst()).trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
