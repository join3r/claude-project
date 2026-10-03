import Foundation

/// The phone ↔ desktop channel above Noise (SPEC.md §4.3, §4.4), a port of
/// `protocol/ts/app-messages.ts`. All of it is UTF-8 JSON. Parsers are
/// tolerant the way the spec asks: unknown fields are dropped, unknown message
/// types come back as nil (ignore them), `null` optional fields are absent,
/// and a newer desktop's extra tab types or statuses don't break the phone.
public enum AppProtocol {
    /// The version this build speaks (N) and the oldest it still accepts.
    public static let version = 1
    public static let minVersion = 1
    public static var local: VersionInfo { VersionInfo(v: version, min: minVersion) }
}

public struct VersionInfo: Sendable, Equatable {
    public var v: Int
    public var min: Int

    public init(v: Int, min: Int) {
        self.v = v
        self.min = min
    }

    init(fields f: Fields) throws(ProtocolError) {
        let v = try f.int("v"), min = try f.int("min")
        guard v >= 1, min >= 1, min <= v else { throw ProtocolError("invalid protocol version range") }
        self.init(v: Int(v), min: Int(min))
    }

    /// Just `{ v, min }` from a handshake payload; negotiated before the rest is parsed.
    public static func parse(_ payload: Data) throws(ProtocolError) -> VersionInfo {
        try VersionInfo(fields: Fields(JSONValue.parse(payload), "payload"))
    }
}

public enum VersionNegotiation: Sendable, Equatable {
    case ok(version: Int)
    /// `update` names the side that is too old ("Update DevTool" vs "Update the app").
    case incompatible(update: Side)

    public enum Side: String, Sendable {
        case local
        case remote
    }

    /// §4.3: chosen = min(v); incompatible when chosen < max(min).
    public static func negotiate(local: VersionInfo, remote: VersionInfo) -> VersionNegotiation {
        let version = Swift.min(local.v, remote.v)
        if version >= Swift.max(local.min, remote.min) { return .ok(version: version) }
        return .incompatible(update: local.v < remote.min ? .local : .remote)
    }
}

public enum PairKind: String, Sendable {
    case pair
    case resume
}

public enum HandshakeResult: String, Sendable {
    case ok
    case pending
    case rejected
    case incompatible
    case unknownDevice = "unknown-device"
}

private func featureList(_ f: Fields) throws(ProtocolError) -> [String] {
    guard f.has("features") else { return [] }
    return try f.array("features").compactMap(\.stringValue)
}

private func b64u32(_ f: Fields, _ key: String) throws(ProtocolError) -> String {
    try f.b64u(key, length: 32)
}

/// Noise message 1 payload (phone → desktop).
public struct PhoneHello: Sendable, Equatable {
    public var v: Int
    public var min: Int
    public var app: String
    public var features: [String]
    public var kind: PairKind
    /// b64u pairProof; present exactly when `kind` is `pair`.
    public var proof: String?
    public var deviceName: String
    /// b64u phone Ed25519 public key.
    public var ed: String

    public init(v: Int = AppProtocol.version, min: Int = AppProtocol.minVersion, app: String, features: [String] = [],
                kind: PairKind, proof: String? = nil, deviceName: String, ed: String) {
        self.v = v
        self.min = min
        self.app = app
        self.features = features
        self.kind = kind
        self.proof = proof
        self.deviceName = deviceName
        self.ed = ed
    }

    public static func parse(_ payload: Data) throws(ProtocolError) -> PhoneHello {
        let f = try Fields(JSONValue.parse(payload), "payload")
        let version = try VersionInfo(fields: f)
        var hello = PhoneHello(
            v: version.v, min: version.min,
            app: try f.str("app"),
            features: try featureList(f),
            kind: PairKind(rawValue: try f.oneOf("kind", ["pair", "resume"]))!,
            deviceName: try f.str("deviceName"),
            ed: try b64u32(f, "ed")
        )
        if hello.kind == .pair { hello.proof = try b64u32(f, "proof") }
        return hello
    }

    /// Key order matches the TS encoder, so the bytes match too.
    public var json: JSONValue {
        var o: JSONObject = ["v": .int(Int64(v)), "min": .int(Int64(min)), "app": .string(app),
                             "features": .array(features.map(JSONValue.string)), "kind": .string(kind.rawValue)]
        if let proof { o["proof"] = .string(proof) }
        o["deviceName"] = .string(deviceName)
        o["ed"] = .string(ed)
        return .object(o)
    }
}

/// Noise message 2 payload (desktop → phone).
public struct DesktopHello: Sendable, Equatable {
    public var v: Int
    public var min: Int
    public var app: String
    public var features: [String]
    public var desktopName: String
    public var result: HandshakeResult

    public init(v: Int = AppProtocol.version, min: Int = AppProtocol.minVersion, app: String, features: [String] = [],
                desktopName: String, result: HandshakeResult) {
        self.v = v
        self.min = min
        self.app = app
        self.features = features
        self.desktopName = desktopName
        self.result = result
    }

    public var version: VersionInfo { VersionInfo(v: v, min: min) }

    /// An unknown `result` throws: the phone can only treat it as a failed handshake.
    public static func parse(_ payload: Data) throws(ProtocolError) -> DesktopHello {
        let f = try Fields(JSONValue.parse(payload), "payload")
        let version = try VersionInfo(fields: f)
        return DesktopHello(
            v: version.v, min: version.min,
            app: try f.str("app"),
            features: try featureList(f),
            desktopName: try f.str("desktopName"),
            result: HandshakeResult(rawValue: try f.oneOf("result", ["ok", "pending", "rejected", "incompatible", "unknown-device"]))!
        )
    }

    public var json: JSONValue {
        .object(["v": .int(Int64(v)), "min": .int(Int64(min)), "app": .string(app),
                 "features": .array(features.map(JSONValue.string)), "desktopName": .string(desktopName),
                 "result": .string(result.rawValue)])
    }
}

public enum AppOp {
    public static let inboxGet = "inbox.get"
}

/// Optional ops a side names in its hello's `features` (§8.1). Unknown
/// strings are ignored.
public enum DesktopFeature {
    /// The desktop answers `chat.new` (§8.2).
    public static let chatNew = "chat.new"
    /// The desktop answers `task.new` (§8.4).
    public static let taskNew = "task.new"
    /// The desktop answers `chat.settings` (§8.5).
    public static let chatSettings = "chat.settings"
}

/// `res.error.code` values. Receivers treat the code as an open string.
public enum AppErrorCode {
    public static let unsupported = "unsupported"
    public static let badRequest = "bad-request"
    public static let notAuthorized = "not-authorized"
    public static let `internal` = "internal"
    /// §6.3: unknown tab or item, a hidden project, or a tab that isn't claude-chat.
    public static let notFound = "not-found"
    /// §6.3: the prompt was already answered.
    public static let gone = "gone"
}

public enum PairingEventStatus: String, Sendable {
    case accepted
    case rejected
    case revoked
}

/// One decrypted transport message (§4.4).
public enum AppMessage: Sendable, Equatable {
    /// `op` stays a string: an unknown op must still be answered `unsupported`.
    /// `params` is the op's raw parameters (§6.3), nil when absent or `null`.
    case req(id: Int64, op: String, params: JSONValue? = nil)
    /// Op-specific result, kept raw; for `inbox.get` run it through `Inbox.parse`.
    case resOk(id: Int64, result: JSONValue)
    case resError(id: Int64, code: String, message: String)
    case inbox(seq: Int64, inbox: Inbox)
    case pairing(PairingEventStatus)
    /// `evt chat` (§6.4).
    case chat(ChatEvent)

    /// Returns nil for a message this build doesn't know (unknown `t`, or
    /// `evt` with an unknown `e`). Throws when a known message is malformed.
    public static func parse(_ payload: Data) throws(ProtocolError) -> AppMessage? {
        let f = try Fields(JSONValue.parse(payload), "payload")
        switch f["t"]?.stringValue ?? "" {
        case "req":
            return .req(id: try f.int("id"), op: try f.str("op"), params: f.isUnset("params") ? nil : f["params"])
        case "res":
            let id = try f.int("id")
            switch f["ok"] {
            case .bool(true)?:
                return .resOk(id: id, result: f["result"] ?? .null)
            case .bool(false)?:
                let error = try Fields(f["error"], "error")
                let message: String = error.isUnset("message") ? "" : try error.str("message")
                return .resError(id: id, code: try error.str("code"), message: message)
            default:
                throw ProtocolError("ok must be a boolean")
            }
        case "evt":
            switch f["e"]?.stringValue ?? "" {
            case "inbox":
                return .inbox(seq: try f.int("seq"), inbox: try Inbox.parse(f["inbox"]))
            case "pairing":
                return .pairing(PairingEventStatus(rawValue: try f.oneOf("status", ["accepted", "rejected", "revoked"]))!)
            case "chat":
                return .chat(try ChatEvent.parse(fields: f))
            default:
                return nil
            }
        default:
            return nil
        }
    }

    public var json: JSONValue {
        switch self {
        case .req(let id, let op, let params):
            var o: JSONObject = ["t": "req", "id": .int(id), "op": .string(op)]
            if let params { o["params"] = params }
            return .object(o)
        case .resOk(let id, let result):
            return .object(["t": "res", "id": .int(id), "ok": true, "result": result])
        case .resError(let id, let code, let message):
            return .object(["t": "res", "id": .int(id), "ok": false,
                            "error": .object(["code": .string(code), "message": .string(message)])])
        case .inbox(let seq, let inbox):
            return .object(["t": "evt", "e": "inbox", "seq": .int(seq), "inbox": inbox.json])
        case .pairing(let status):
            return .object(["t": "evt", "e": "pairing", "status": .string(status.rawValue)])
        case .chat(let event):
            return event.json
        }
    }

    /// Compact UTF-8 JSON, what goes into a transport message.
    public var encoded: Data { json.jsonData }
}

// MARK: - Inbox

extension Inbox {
    /// Validates an `Inbox` value (already-parsed JSON, e.g. `res.result` or
    /// `evt.inbox`) exactly like `parseInbox` in TS: an unknown tab `type` is
    /// kept, an unknown `status` becomes `idle`, `null` optionals are absent.
    public static func parse(_ value: JSONValue?) throws(ProtocolError) -> Inbox {
        let o = try Fields(value, "inbox")
        let desktop = try Fields(o["desktop"], "desktop")
        return Inbox(
            desktop: InboxDesktop(id: try desktop.str("id"), name: try desktop.str("name")),
            generatedAt: try o.int("generatedAt"),
            projects: try o.array("projects").map { (v) throws(ProtocolError) in try parseProject(v) }
        )
    }

    private static func optInt(_ f: Fields, _ key: String) throws(ProtocolError) -> Int64? {
        f.isUnset(key) ? nil : try f.int(key)
    }

    private static func optStr(_ f: Fields, _ key: String) throws(ProtocolError) -> String? {
        f.isUnset(key) ? nil : try f.str(key)
    }

    private static func parseProject(_ value: JSONValue) throws(ProtocolError) -> InboxProject {
        let o = try Fields(value, "project")
        return InboxProject(
            id: try o.str("id"),
            name: try o.str("name"),
            emoji: try optStr(o, "emoji"),
            remote: o["remote"] == .bool(true),
            tasks: try o.array("tasks").map { (v) throws(ProtocolError) in try parseTask(v) }
        )
    }

    private static func parseTask(_ value: JSONValue) throws(ProtocolError) -> InboxTask {
        let o = try Fields(value, "task")
        let id = try o.str("id"), name = try o.str("name")
        let tabs = try o.array("tabs").map { (v) throws(ProtocolError) in try parseTab(v) }
        return InboxTask(
            id: id, name: name,
            lastInteractedAt: try optInt(o, "lastInteractedAt"),
            attentionAt: try optInt(o, "attentionAt"),
            tabs: tabs
        )
    }

    private static func parseTab(_ value: JSONValue) throws(ProtocolError) -> InboxTab {
        let o = try Fields(value, "tab")
        let status = try o.str("status")
        let known: [String] = ["working", "attention", "exited", "idle"]
        return InboxTab(
            id: try o.str("id"),
            type: TabType(rawValue: try o.str("type")),
            title: try o.str("title"),
            // A status this build doesn't know is shown as idle rather than dropping the tab.
            status: known.contains(status) ? TabStatus(rawValue: status) : .idle,
            since: try optInt(o, "since"),
            activity: try optStr(o, "activity")
        )
    }

    /// Wire JSON, in the TS key order.
    public var json: JSONValue {
        .object([
            "desktop": .object(["id": .string(desktop.id), "name": .string(desktop.name)]),
            "generatedAt": .int(generatedAt),
            "projects": .array(projects.map(\.json)),
        ])
    }
}

extension InboxProject {
    var json: JSONValue {
        var o: JSONObject = ["id": .string(id), "name": .string(name)]
        if let emoji { o["emoji"] = .string(emoji) }
        o["remote"] = .bool(remote)
        o["tasks"] = .array(tasks.map(\.json))
        return .object(o)
    }
}

extension InboxTask {
    var json: JSONValue {
        var o: JSONObject = ["id": .string(id), "name": .string(name)]
        if let lastInteractedAt { o["lastInteractedAt"] = .int(lastInteractedAt) }
        if let attentionAt { o["attentionAt"] = .int(attentionAt) }
        o["tabs"] = .array(tabs.map(\.json))
        return .object(o)
    }
}

extension InboxTab {
    var json: JSONValue {
        var o: JSONObject = ["id": .string(id), "type": .string(type.rawValue), "title": .string(title),
                             "status": .string(status.rawValue)]
        if let since { o["since"] = .int(since) }
        if let activity { o["activity"] = .string(activity) }
        return .object(o)
    }
}
