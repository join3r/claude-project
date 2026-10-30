import Foundation

/// Token usage per project (§8.22): what the agents spent, read from their
/// session files on the desktop, by day, agent and model. The phone picks the
/// range and sums, as the desktop's Tokens card and Token usage window do.

/// Input, output and the two cache counts of some rows.
public struct TokenCounts: Sendable, Equatable, Hashable {
    /// Fresh input, not read from the prompt cache.
    public var input: Int64
    public var output: Int64
    public var cacheRead: Int64
    public var cacheWrite: Int64

    public init(input: Int64 = 0, output: Int64 = 0, cacheRead: Int64 = 0, cacheWrite: Int64 = 0) {
        self.input = input
        self.output = output
        self.cacheRead = cacheRead
        self.cacheWrite = cacheWrite
    }

    public var total: Int64 { input + output + cacheRead + cacheWrite }

    public static func + (a: TokenCounts, b: TokenCounts) -> TokenCounts {
        TokenCounts(input: a.input + b.input, output: a.output + b.output, cacheRead: a.cacheRead + b.cacheRead, cacheWrite: a.cacheWrite + b.cacheWrite)
    }
}

/// One day's tokens of one agent and model.
public struct TokenUsageRow: Sendable, Equatable, Hashable {
    /// `YYYY-MM-DD` on the desktop's clock. Older days come summed into one
    /// row per agent and model, dated the earliest day it covers.
    public var day: String
    /// `claude`, `codex`, `pi`, or a newer agent's name as it came.
    public var agent: String
    public var model: String
    public var counts: TokenCounts

    public init(day: String, agent: String, model: String, counts: TokenCounts) {
        self.day = day
        self.agent = agent
        self.model = model
        self.counts = counts
    }

    /// "Claude", "Codex", "Pi", or the agent as it came.
    public var agentLabel: String { TokenUsageRow.label(agent: agent) }

    public static func label(agent: String) -> String {
        switch agent {
        case "claude": "Claude"
        case "codex": "Codex"
        case "pi": "Pi"
        default: agent
        }
    }

    static func parse(_ value: JSONValue) throws(ProtocolError) -> TokenUsageRow {
        let o = try Fields(value, "row")
        return TokenUsageRow(
            day: try TokenDay.parse(o, "day"), agent: try o.str("agent"), model: try o.str("model"),
            counts: TokenCounts(input: try o.int("input"), output: try o.int("output"), cacheRead: try o.int("cacheRead"), cacheWrite: try o.int("cacheWrite"))
        )
    }

    var json: JSONValue {
        .object([
            "day": .string(day), "agent": .string(agent), "model": .string(model),
            "input": .int(counts.input), "output": .int(counts.output), "cacheRead": .int(counts.cacheRead), "cacheWrite": .int(counts.cacheWrite),
        ])
    }
}

/// One project's rows. `unavailable`: the desktop can't read its sessions
/// (SSH, shell command), so it isn't counted rather than at zero.
public struct TokenUsageProject: Sendable, Equatable, Identifiable {
    public var projectId: String
    public var rows: [TokenUsageRow]
    public var unavailable: Bool

    public init(projectId: String, rows: [TokenUsageRow], unavailable: Bool = false) {
        self.projectId = projectId
        self.rows = rows
        self.unavailable = unavailable
    }

    public var id: String { projectId }

    static func parse(_ value: JSONValue) throws(ProtocolError) -> TokenUsageProject {
        let o = try Fields(value, "project")
        var rows: [TokenUsageRow] = []
        for row in try o.array("rows") { rows.append(try TokenUsageRow.parse(row)) }
        return TokenUsageProject(projectId: try o.str("projectId"), rows: rows, unavailable: o["unavailable"] == .bool(true))
    }

    var json: JSONValue {
        var o: JSONObject = ["projectId": .string(projectId), "rows": .array(rows.map(\.json))]
        if unavailable { o["unavailable"] = .bool(true) }
        return .object(o)
    }
}

/// `tokens.usage` result (§8.22).
public struct TokensUsageResult: Sendable, Equatable {
    /// The desktop's own day: ranges count back from it, not from the phone's clock.
    public var today: String
    /// When the desktop last read the session files (unix ms).
    public var scannedAt: Int64
    public var projects: [TokenUsageProject]

    public init(today: String, scannedAt: Int64, projects: [TokenUsageProject]) {
        self.today = today
        self.scannedAt = scannedAt
        self.projects = projects
    }

    /// A day that isn't `YYYY-MM-DD`, or a missing or negative count, throws.
    public static func parse(_ value: JSONValue) throws(ProtocolError) -> TokensUsageResult {
        let o = try Fields(value, "result")
        var projects: [TokenUsageProject] = []
        for project in try o.array("projects") { projects.append(try TokenUsageProject.parse(project)) }
        return TokensUsageResult(today: try TokenDay.parse(o, "today"), scannedAt: try o.int("scannedAt"), projects: projects)
    }

    public var json: JSONValue {
        .object(["today": .string(today), "scannedAt": .int(scannedAt), "projects": .array(projects.map(\.json))])
    }
}

/// `tokens.usage` params: nil asks for every project the phone sees.
public struct TokensUsageParams: Sendable, Equatable {
    public var projectId: String?

    public init(projectId: String? = nil) { self.projectId = projectId }

    /// The desktop's side: an empty `projectId` throws (`bad-request`).
    public static func parse(_ value: JSONValue?) throws(ProtocolError) -> TokensUsageParams {
        TokensUsageParams(projectId: try Fields(value, "params").optNonEmpty("projectId"))
    }

    public var json: JSONValue {
        var o: JSONObject = [:]
        if let projectId { o["projectId"] = .string(projectId) }
        return .object(o)
    }
}

/// The ranges the desktop offers: Today, 7 days, 30 days, All time.
public enum TokenRange: String, Sendable, CaseIterable, Identifiable {
    case today
    case week = "7d"
    case month = "30d"
    case all

    public var id: String { rawValue }

    public var label: String {
        switch self {
        case .today: "Today"
        case .week: "7 days"
        case .month: "30 days"
        case .all: "All time"
        }
    }

    /// Days the range covers, counting today; nil for all time.
    public var days: Int? {
        switch self {
        case .today: 1
        case .week: 7
        case .month: 30
        case .all: nil
        }
    }
}

/// `YYYY-MM-DD` arithmetic on the desktop's days, in a fixed Gregorian UTC
/// calendar so the phone's time zone never shifts a day.
public enum TokenDay {
    private static let calendar: Calendar = {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        return calendar
    }()

    static func parse(_ o: Fields, _ key: String) throws(ProtocolError) -> String {
        let value = try o.str(key)
        guard components(value) != nil else { throw ProtocolError("\(key) must be YYYY-MM-DD") }
        return value
    }

    private static func components(_ day: String) -> DateComponents? {
        let parts = day.split(separator: "-", omittingEmptySubsequences: false)
        guard day.count == 10, parts.count == 3, parts[0].count == 4, parts[1].count == 2, parts[2].count == 2,
              parts.allSatisfy({ $0.allSatisfy(\.isASCII) && $0.allSatisfy(\.isNumber) }),
              let year = Int(parts[0]), let month = Int(parts[1]), let day = Int(parts[2]) else { return nil }
        return DateComponents(year: year, month: month, day: day)
    }

    /// `day` moved by `offset` days ("2026-10-30" by -29 is "2026-10-01").
    public static func adding(_ offset: Int, to day: String) -> String {
        guard let parts = components(day), let date = calendar.date(from: parts),
              let moved = calendar.date(byAdding: .day, value: offset, to: date) else { return day }
        let c = calendar.dateComponents([.year, .month, .day], from: moved)
        return String(format: "%04d-%02d-%02d", c.year ?? 0, c.month ?? 0, c.day ?? 0)
    }

    /// The day as a date at noon UTC, for showing it ("30 Oct").
    public static func date(_ day: String) -> Date? {
        guard var parts = components(day) else { return nil }
        parts.hour = 12
        return calendar.date(from: parts)
    }
}

/// One day's total in a chart.
public struct TokenDailyTotal: Sendable, Equatable, Identifiable {
    public var day: String
    public var total: Int64
    public var id: String { day }
}

/// One agent's (or agent and model's) total in a list.
public struct TokenTotal: Sendable, Equatable, Identifiable {
    public var agent: String
    /// nil when summed per agent.
    public var model: String?
    public var counts: TokenCounts
    public var id: String { "\(agent)|\(model ?? "")" }
}

extension Array where Element == TokenUsageRow {
    /// The rows `range` covers, counting back from the desktop's `today`.
    public func inRange(_ range: TokenRange, today: String) -> [TokenUsageRow] {
        guard let days = range.days else { return self }
        let start = TokenDay.adding(-(days - 1), to: today)
        return filter { $0.day >= start }
    }

    public var counts: TokenCounts { reduce(TokenCounts()) { $0 + $1.counts } }

    /// Totals per agent, largest first.
    public var byAgent: [TokenTotal] { totals { ($0.agent, nil) } }

    /// Totals per agent and model, largest first.
    public var byModel: [TokenTotal] { totals { ($0.agent, $0.model) } }

    private func totals(_ key: (TokenUsageRow) -> (String, String?)) -> [TokenTotal] {
        var order: [String] = []
        var sums: [String: TokenTotal] = [:]
        for row in self {
            let (agent, model) = key(row)
            let id = "\(agent)|\(model ?? "")"
            if var sum = sums[id] {
                sum.counts = sum.counts + row.counts
                sums[id] = sum
            } else {
                order.append(id)
                sums[id] = TokenTotal(agent: agent, model: model, counts: row.counts)
            }
        }
        // Stable for ties: first seen first.
        return order.compactMap { sums[$0] }.enumerated()
            .sorted { $0.element.counts.total != $1.element.counts.total ? $0.element.counts.total > $1.element.counts.total : $0.offset < $1.offset }
            .map(\.element)
    }

    /// Each of the last `days` days up to `today` (oldest first) with its total, zero when nothing ran.
    public func daily(_ days: Int, today: String) -> [TokenDailyTotal] {
        var byDay: [String: Int64] = [:]
        for row in self { byDay[row.day, default: 0] += row.counts.total }
        return (0..<days).reversed().map { back in
            let day = TokenDay.adding(-back, to: today)
            return TokenDailyTotal(day: day, total: byDay[day] ?? 0)
        }
    }
}

public enum TokenFormat {
    /// "812", "48k", "3.4M", "1.2B", as the desktop writes them.
    public static func count(_ tokens: Int64) -> String {
        let n = Double(tokens)
        func short(_ value: Double, _ unit: String) -> String {
            if value >= 100 { return "\(Int(value.rounded()))\(unit)" }
            let rounded = (value * 10).rounded() / 10
            return rounded == rounded.rounded() ? "\(Int(rounded))\(unit)" : "\(rounded)\(unit)"
        }
        if n >= 1e9 { return short(n / 1e9, "B") }
        if n >= 1e6 { return short(n / 1e6, "M") }
        if n >= 1e3 { return short(n / 1e3, "k") }
        return String(tokens)
    }
}

extension TaskOp {
    /// `tokens.usage` (§8.22): the agents' tokens per project.
    public static let tokensUsage = "tokens.usage"
}
