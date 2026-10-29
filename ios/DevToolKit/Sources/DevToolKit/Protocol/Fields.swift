import Foundation

/// Field accessors shared by the parsers, with the same checks and messages as
/// the helpers in `protocol/ts/relay-messages.ts` and `app-messages.ts`.
struct Fields {
    let o: JSONObject

    init(_ value: JSONValue?, _ what: String) throws(ProtocolError) {
        guard let value, case .object(let o) = value else { throw ProtocolError("\(what) must be an object") }
        self.o = o
    }

    subscript(key: String) -> JSONValue? { o[key] }

    /// Absent (`undefined` in TS).
    func has(_ key: String) -> Bool { o[key] != nil }

    /// Absent or `null`.
    func isUnset(_ key: String) -> Bool { o[key] == nil || o[key] == .null }

    func str(_ key: String) throws(ProtocolError) -> String {
        guard case .string(let s)? = o[key] else { throw ProtocolError("\(key) must be a string") }
        return s
    }

    /// A non-negative safe integer (unix seconds/ms, ids, counters).
    func int(_ key: String) throws(ProtocolError) -> Int64 {
        guard case .number(let d)? = o[key], d == d.rounded(), d >= 0, d <= 9_007_199_254_740_991 else {
            throw ProtocolError("\(key) must be a non-negative integer")
        }
        return Int64(d)
    }

    func oneOf(_ key: String, _ allowed: [String]) throws(ProtocolError) -> String {
        let value = try str(key)
        guard allowed.contains(value) else { throw ProtocolError("\(key) has an unknown value") }
        return value
    }

    /// Absent or null as nil; an empty string throws.
    func optNonEmpty(_ key: String) throws(ProtocolError) -> String? {
        guard !isUnset(key) else { return nil }
        let value = try str(key)
        guard !value.isEmpty else { throw ProtocolError("\(key) is empty") }
        return value
    }

    func array(_ key: String) throws(ProtocolError) -> [JSONValue] {
        guard case .array(let a)? = o[key] else { throw ProtocolError("\(key) must be an array") }
        return a
    }

    /// Strict b64u of exactly `length` bytes, or of any non-empty length when nil.
    func b64u(_ key: String, length: Int?) throws(ProtocolError) -> String {
        let value = try str(key)
        guard let bytes = Base64URL.decode(value) else { throw ProtocolError("\(key) must be base64url") }
        if let length {
            guard bytes.count == length else { throw ProtocolError("\(key) must be \(length) bytes") }
        } else {
            guard !bytes.isEmpty else { throw ProtocolError("\(key) must not be empty") }
        }
        return value
    }

    func deviceId(_ key: String) throws(ProtocolError) -> String {
        let value = try str(key)
        guard DeviceId(value) != nil else { throw ProtocolError("\(key) must be a device ID") }
        return value
    }
}
