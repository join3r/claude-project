import Foundation
import Testing
@testable import DevToolKit

/// `tokens.usage` (§8.22): the vectors in `protocol/vectors/chat-messages.json`,
/// the range sums the screens show, and the mock desktop's answer.
@Suite struct TokenUsageTests {
    @Test func paramsAndResultsMatchTheVectors() throws {
        let usage = try #require(try Vectors.load("chat-messages.json")["tokensUsage"])
        #expect(!usage["params"].array.isEmpty && !usage["results"].array.isEmpty)
        for sample in usage["params"].array {
            let parsed = try TokensUsageParams.parse(try JSONValue.parse(sample["json"].str))
            #expect(parsed.json == sample["expected"], "\(sample["json"].str)")
        }
        for sample in usage["results"].array {
            let parsed = try TokensUsageResult.parse(try JSONValue.parse(sample["json"].str))
            #expect(parsed.json == sample["expected"], "\(sample["json"].str)")
        }
        for json in usage["invalid"]["params"].array {
            #expect(throws: (any Error).self, "\(json.str)") { _ = try TokensUsageParams.parse(try JSONValue.parse(json.str)) }
        }
        for json in usage["invalid"]["results"].array {
            #expect(throws: (any Error).self, "\(json.str)") { _ = try TokensUsageResult.parse(try JSONValue.parse(json.str)) }
        }
    }

    private func row(_ day: String, _ model: String, _ input: Int64, agent: String = "claude") -> TokenUsageRow {
        TokenUsageRow(day: day, agent: agent, model: model, counts: TokenCounts(input: input, output: 1, cacheRead: 10))
    }

    @Test func rangesCountBackFromTheDesktopsToday() {
        let rows = [row("2026-10-30", "opus", 1), row("2026-10-24", "opus", 2), row("2026-10-23", "opus", 4), row("2026-10-01", "gpt", 8, agent: "codex"), row("2026-08-02", "opus", 16)]
        let today = "2026-10-30"
        #expect(rows.inRange(.today, today: today).map(\.counts.input) == [1])
        #expect(rows.inRange(.week, today: today).map(\.counts.input) == [1, 2])
        #expect(rows.inRange(.month, today: today).map(\.counts.input) == [1, 2, 4, 8])
        #expect(rows.inRange(.all, today: today).counts == TokenCounts(input: 31, output: 5, cacheRead: 50))
        #expect(rows.byAgent.map(\.agent) == ["claude", "codex"])
        #expect(rows.byModel.map(\.id) == ["claude|opus", "codex|gpt"])
        #expect(rows.byModel.first?.counts.total == 67)
        // Across a month and a year end.
        #expect(TokenDay.adding(-29, to: "2026-10-30") == "2026-10-01")
        #expect(TokenDay.adding(-1, to: "2027-01-01") == "2026-12-31")
        #expect(TokenDay.adding(1, to: "2028-02-28") == "2028-02-29")
    }

    @Test func dailyTotalsFillTheGaps() {
        let rows = [row("2026-10-30", "opus", 1), row("2026-10-30", "haiku", 1), row("2026-10-28", "opus", 5)]
        let days = rows.daily(3, today: "2026-10-30")
        #expect(days.map(\.day) == ["2026-10-28", "2026-10-29", "2026-10-30"])
        #expect(days.map(\.total) == [16, 0, 24])
    }

    @Test func countsReadAsTheDesktopWritesThem() {
        #expect(TokenFormat.count(812) == "812")
        #expect(TokenFormat.count(48_000) == "48k")
        #expect(TokenFormat.count(3_420_000) == "3.4M")
        #expect(TokenFormat.count(412_000_000) == "412M")
        #expect(TokenFormat.count(1_200_000_000) == "1.2B")
        #expect(TokenFormat.count(99_960) == "100k")
        #expect(TokenUsageRow.label(agent: "pi") == "Pi")
        #expect(TokenUsageRow.label(agent: "gemini") == "gemini")
    }

    @Test func mockCountsLocalProjectsOnly() async throws {
        let mock = MockDesktopConnection(desktopId: "d", desktopName: "desk", flipInterval: .seconds(60), streamStep: .milliseconds(1))
        let events = EventRecorder(mock)
        await mock.start()
        try await events.waitFor(RelayConnectionTests.isInbox)
        let all = try await mock.tokensUsage()
        let api = try #require(all.projects.first { $0.projectId == "p-api" })
        #expect(!api.unavailable && !api.rows.isEmpty)
        #expect(api.rows.byAgent.map(\.agent).contains("codex"))
        #expect(all.projects.first { $0.projectId == "p-infra" }?.unavailable == true)
        #expect(all.projects.first { $0.projectId == "p-dotfiles" }?.unavailable == true)
        let one = try await mock.tokensUsage(projectId: "p-web")
        #expect(one.projects.map(\.projectId) == ["p-web"])
        await #expect(throws: DesktopConnectionError.remote(code: AppErrorCode.notFound, message: "No such project")) {
            _ = try await mock.tokensUsage(projectId: "missing")
        }
        await mock.stop()
    }
}
