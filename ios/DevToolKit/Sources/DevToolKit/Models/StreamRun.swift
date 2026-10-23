import Foundation

/// A stream's app run since the desktop started (§4.4, §8.19): the stream's
/// `runCommand`, started in its folder, in a terminal no task owns.
public struct InboxStreamRun: Codable, Sendable, Equatable, Hashable {
    public enum Status: String, Codable, Sendable, Hashable, CaseIterable {
        case running
        /// It ended by itself, with `exitCode`.
        case exited
        /// Stop (or Restart) ended it.
        case stopped
    }

    public var status: Status
    /// Unix milliseconds.
    public var startedAt: Int64
    /// Unix milliseconds; set once it ended.
    public var endedAt: Int64?
    /// Only with `exited`; may be negative.
    public var exitCode: Int?

    public init(status: Status, startedAt: Int64, endedAt: Int64? = nil, exitCode: Int? = nil) {
        self.status = status
        self.startedAt = startedAt
        self.endedAt = endedAt
        self.exitCode = status == .exited ? exitCode : nil
    }

    public var isRunning: Bool { status == .running }

    /// Wire parse (§8.19). An unknown `status` or a malformed field throws;
    /// `InboxStream`'s parser then drops the run rather than the inbox.
    static func parse(_ value: JSONValue?) throws(ProtocolError) -> InboxStreamRun {
        let o = try Fields(value, "run")
        guard let status = Status(rawValue: try o.str("status")) else { throw ProtocolError("status has an unknown value") }
        let endedAt = o.isUnset("endedAt") ? nil : try o.int("endedAt")
        var exitCode: Int?
        if !o.isUnset("exitCode") {
            guard case .number(let d)? = o["exitCode"], d == d.rounded(), abs(d) <= 9_007_199_254_740_991 else {
                throw ProtocolError("exitCode must be an integer")
            }
            exitCode = Int(d)
        }
        return InboxStreamRun(status: status, startedAt: try o.int("startedAt"), endedAt: endedAt, exitCode: exitCode)
    }

    var json: JSONValue {
        var o: JSONObject = ["status": .string(status.rawValue), "startedAt": .int(startedAt)]
        if let endedAt { o["endedAt"] = .int(endedAt) }
        if let exitCode { o["exitCode"] = .int(Int64(exitCode)) }
        return .object(o)
    }
}

/// `stream.run` (§8.19) params: the desktop's Run, Stop and Restart.
public struct StreamRunParams: Sendable, Equatable {
    public enum Action: String, Sendable, Equatable, CaseIterable {
        /// A no-op while it already runs.
        case start
        case stop
        case restart
    }

    public var projectId: String
    public var streamId: String
    public var action: Action

    public init(projectId: String, streamId: String, action: Action) {
        self.projectId = projectId
        self.streamId = streamId
        self.action = action
    }

    /// The desktop's side: a missing `projectId` or `streamId`, or an unknown `action`, throws (`bad-request`).
    public static func parse(_ value: JSONValue?) throws(ProtocolError) -> StreamRunParams {
        let o = try Fields(value, "params")
        let action = try o.oneOf("action", Action.allCases.map(\.rawValue))
        return StreamRunParams(projectId: try o.str("projectId"), streamId: try o.str("streamId"), action: Action(rawValue: action)!)
    }

    public var json: JSONValue {
        .object(["projectId": .string(projectId), "streamId": .string(streamId), "action": .string(action.rawValue)])
    }
}

/// `stream.logs` (§8.19) params.
public struct StreamLogsParams: Sendable, Equatable {
    public var projectId: String
    public var streamId: String

    public init(projectId: String, streamId: String) {
        self.projectId = projectId
        self.streamId = streamId
    }

    /// The desktop's side: a missing `projectId` or `streamId` throws (`bad-request`).
    public static func parse(_ value: JSONValue?) throws(ProtocolError) -> StreamLogsParams {
        let o = try Fields(value, "params")
        return StreamLogsParams(projectId: try o.str("projectId"), streamId: try o.str("streamId"))
    }

    public var json: JSONValue { .object(["projectId": .string(projectId), "streamId": .string(streamId)]) }
}

/// `stream.logs` result: the run's output as plain text (terminal escapes
/// stripped), at most `maxLength` characters from its end.
public struct StreamLogsResult: Sendable, Equatable {
    public static let maxLength = 200_000

    public var text: String
    /// The start of the output was cut off.
    public var truncated: Bool

    public init(text: String, truncated: Bool = false) {
        self.text = text
        self.truncated = truncated
    }

    public static func parse(_ value: JSONValue) throws(ProtocolError) -> StreamLogsResult {
        let o = try Fields(value, "result")
        return StreamLogsResult(text: try o.str("text"), truncated: o["truncated"] == .bool(true))
    }

    public var json: JSONValue {
        var o: JSONObject = ["text": .string(text)]
        if truncated { o["truncated"] = .bool(true) }
        return .object(o)
    }
}

extension TaskOp {
    /// `stream.run` (§8.19): start, stop or restart a stream's app run.
    public static let streamRun = "stream.run"
    /// `stream.logs` (§8.19): the end of a stream's app run output.
    public static let streamLogs = "stream.logs"
}

extension InboxStreamRun {
    /// Ended by itself with a non-zero (or unknown) exit code.
    public var crashed: Bool { status == .exited && exitCode != 0 }

    /// Belongs in the Inbox's Apps group: running, or crashed. Stopped runs
    /// and clean exits don't.
    public var isInboxApp: Bool { isRunning || crashed }
}

/// A row of the phone Inbox's Apps group (§8.19): a stream whose app is
/// running or crashed, with the desktop and project it belongs to.
public struct InboxAppRun: Sendable, Equatable, Identifiable {
    public var desktopId: String
    public var project: InboxProject
    public var stream: InboxStream
    public var run: InboxStreamRun

    public init(desktopId: String, project: InboxProject, stream: InboxStream, run: InboxStreamRun) {
        self.desktopId = desktopId
        self.project = project
        self.stream = stream
        self.run = run
    }

    public var id: String { "\(desktopId):\(project.id):\(stream.id)" }

    /// Every running or crashed app run across `inboxes` (pass only desktops
    /// that list `stream.run`): crashes first, most recently ended first, then
    /// running ones, most recently started first. Equal times keep the
    /// desktops' own order.
    public static func list(_ inboxes: [(desktopId: String, inbox: Inbox)]) -> [InboxAppRun] {
        var crashed: [(InboxAppRun, Int)] = []
        var running: [(InboxAppRun, Int)] = []
        var index = 0
        for (desktopId, inbox) in inboxes {
            for project in inbox.projects {
                for stream in project.streams {
                    guard let run = stream.run, run.isInboxApp else { continue }
                    let entry = (InboxAppRun(desktopId: desktopId, project: project, stream: stream, run: run), index)
                    index += 1
                    if run.crashed { crashed.append(entry) } else { running.append(entry) }
                }
            }
        }
        func sorted(_ entries: [(InboxAppRun, Int)], by key: (InboxStreamRun) -> Int64) -> [InboxAppRun] {
            entries.sorted { a, b in
                let ka = key(a.0.run), kb = key(b.0.run)
                return ka != kb ? ka > kb : a.1 < b.1
            }.map(\.0)
        }
        return sorted(crashed) { $0.endedAt ?? $0.startedAt } + sorted(running, by: \.startedAt)
    }
}
