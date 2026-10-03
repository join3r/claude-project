import Foundation

/// One canned chat held by `MockDesktopConnection` (the desktop side of a
/// claude-chat tab, as far as the phone can tell).
struct MockChatTranscript: Sendable {
    var title: String
    var status: ChatStatus
    var items: [ChatItem]
    var prompts: [ChatPrompt]
    var details: [String: ChatDetail]
    var seq: Int64 = 0
    var nextId = 1

    /// §6.4: `chat.open` returns the last 60 items.
    static let window = 60

    mutating func makeId(_ prefix: String) -> String {
        defer { nextId += 1 }
        return "\(prefix)-\(nextId)"
    }

    /// What a desktop on a claude.ai plan sends: the pickers and a part-used meter.
    static func settings(model: String?, now: Int64) -> (ChatSettings, ChatUsage) {
        let models = [
            ChatModelOption(value: "opus", label: "Opus 4.5", description: "Most capable for complex work"),
            ChatModelOption(value: "sonnet", label: "Sonnet 4.5", description: "Best for everyday tasks"),
            ChatModelOption(value: "haiku", label: "Haiku 4.5", description: "Fastest for quick answers"),
        ]
        let name = model.flatMap { m in models.first { m.contains($0.value) }?.label }
        let settings = ChatSettings(modelName: name, models: models, defaultEffort: "medium",
                                    efforts: ["low", "medium", "high", "xhigh", "max"])
        let usage = ChatUsage(contextTokens: 64_000, contextMax: 200_000, costCents: 412,
                              fiveHour: ChatLimitWindow(used: 38, resetsAt: now + 2 * 3_600_000 + 16 * 60_000),
                              sevenDay: ChatLimitWindow(used: 81, resetsAt: now + 3 * 86_400_000))
        return (settings, usage)
    }

    static func status(turnStartedAt: Int64, permissionMode: String, model: String) -> ChatStatus {
        let (settings, usage) = Self.settings(model: model, now: Date().unixMilliseconds)
        return ChatStatus(busy: true, turnStartedAt: turnStartedAt, process: .running, permissionMode: permissionMode,
                          model: model, settings: settings, usage: usage)
    }

    /// A new chat's status: idle, on the default model.
    static func freshStatus() -> ChatStatus {
        let (settings, usage) = Self.settings(model: "claude-opus-4-5", now: Date().unixMilliseconds)
        return ChatStatus(settings: settings, usage: usage)
    }

    func view(tabId: String) -> ChatView {
        let windowed = Array(items.suffix(Self.window))
        return ChatView(tabId: tabId, title: title, status: status, items: windowed,
                        hasEarlier: items.count > windowed.count, prompts: prompts)
    }

    func earlier(before id: String, limit: Int) -> ChatEarlierResult? {
        guard let index = items.firstIndex(where: { $0.id == id }) else { return nil }
        let start = max(0, index - limit)
        return ChatEarlierResult(items: Array(items[start..<index]), hasEarlier: start > 0)
    }

    mutating func upsert(_ item: ChatItem) {
        if let index = items.firstIndex(where: { $0.id == item.id }) {
            items[index] = item
        } else {
            items.append(item)
        }
    }

    func item(_ id: String) -> ChatItem? {
        items.first { $0.id == id }
    }
}

/// Canned chats for `-mockDesktop`, keyed by tab ID (the claude-chat tabs of `MockInbox.sample`).
enum MockChats {
    static func all(now: Date = Date()) -> [String: MockChatTranscript] {
        ["tab-1": fixAuth(now: now), "tab-8": loginRedesign(now: now), "tab-11": usageCharts(now: now)]
    }

    private static func toolDetail(_ input: JSONValue, _ result: String?) -> ChatDetail {
        .tool(input: prettyJSON(input), result: result)
    }

    static func prettyJSON(_ value: JSONValue) -> String {
        guard let object = try? JSONSerialization.jsonObject(with: value.jsonData, options: [.fragmentsAllowed]),
              let data = try? JSONSerialization.data(withJSONObject: object, options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]),
              let text = String(data: data, encoding: .utf8)
        else { return value.jsonString }
        return text
    }

    /// api-server / fix-auth: a long transcript (so "Load earlier" shows up)
    /// that ends on a Bash permission prompt.
    static func fixAuth(now: Date) -> MockChatTranscript {
        var items: [ChatItem] = []
        var details: [String: ChatDetail] = [:]
        // Earlier turns, outside the 60-item window.
        for turn in 1...24 {
            items.append(ChatItem(id: "e-u\(turn)", .user(text: "Step \(turn): tidy up the next module in src/auth.", images: nil, queued: false, failed: false)))
            items.append(ChatItem(id: "e-t\(turn)", .tool(ChatTool(name: "Read", summary: "Read src/auth/module\(turn).ts", status: .done, hasDetail: true))))
            details["e-t\(turn)"] = toolDetail(.object(["file_path": .string("src/auth/module\(turn).ts")]), "export function module\(turn)() {\n  // …\n}\n")
            items.append(ChatItem(id: "e-a\(turn)", .text(markdown: "Module \(turn) is clean now: removed an unused import and tightened a type.", streaming: false)))
        }
        items += [
            ChatItem(id: "u1", .user(
                text: "The login endpoint returns 500 when the refresh token is expired. Can you find out why and fix it?",
                images: 1, queued: false, failed: false)),
            ChatItem(id: "th1", .thinking(
                preview: "A 500 on an expired refresh token smells like an uncaught error type. I'll grep for refreshToken, read the refresh handler, and check which JWT errors it catches…",
                streaming: false)),
            ChatItem(id: "t1", .tool(ChatTool(name: "Grep", summary: "Grep \"refreshToken\" in src/", status: .done, hasDetail: true))),
            ChatItem(id: "t2", .tool(ChatTool(name: "Read", summary: "Read src/auth/refresh.ts", status: .done, hasDetail: true))),
            ChatItem(id: "a1", .text(markdown: """
                Found it. `verifyRefreshToken` throws a `TokenExpiredError`, but `refresh.ts` only catches `JsonWebTokenError`, \
                so the expired case falls through to the generic handler and becomes a **500**.

                I'll:
                1. Catch `TokenExpiredError` and answer `401` with `code: "refresh_expired"`
                2. Add a regression test in `test/auth/refresh.test.ts`
                """, streaming: false)),
            ChatItem(id: "t3", .tool(ChatTool(name: "Edit", summary: "Edit src/auth/refresh.ts", status: .done, hasDetail: true))),
            ChatItem(id: "t4", .tool(ChatTool(name: "Write", summary: "Write test/auth/refresh.test.ts", status: .done, hasDetail: true))),
            ChatItem(id: "n1", .notice(text: "Permission mode changed to Accept edits", tone: .muted)),
            ChatItem(id: "t5", .tool(ChatTool(name: "Task", summary: "Explore: other callers of verifyRefreshToken", status: .done, hasDetail: true,
                                                childCount: 6, lastChild: "Read src/routes/session.ts"))),
            ChatItem(id: "a2", .text(markdown: "The fix is in. The only other caller (`routes/session.ts`) already handles expiry. Running the auth tests now.", streaming: false)),
            ChatItem(id: "t6", .tool(ChatTool(name: "Bash", summary: "npm test -- auth", status: .waiting, hasDetail: true))),
        ]
        details["t1"] = toolDetail(.object(["pattern": "refreshToken", "path": "src/", "output_mode": "content"]), """
            src/auth/refresh.ts:12:  const payload = verifyRefreshToken(req.body.refreshToken)
            src/auth/tokens.ts:48:export function verifyRefreshToken(token: string): RefreshPayload {
            src/routes/session.ts:31:    const { refreshToken } = req.cookies
            """)
        details["t2"] = toolDetail(.object(["file_path": "src/auth/refresh.ts"]), """
            import { JsonWebTokenError } from 'jsonwebtoken'
            import { verifyRefreshToken, issueTokens } from './tokens'

            export async function refresh(req: Request, res: Response) {
              try {
                const payload = verifyRefreshToken(req.body.refreshToken)
                res.json(await issueTokens(payload.sub))
              } catch (err) {
                if (err instanceof JsonWebTokenError) return res.status(401).json({ code: 'invalid_refresh' })
                throw err
              }
            }
            """)
        details["t3"] = toolDetail(.object([
            "file_path": "src/auth/refresh.ts",
            "old_string": "if (err instanceof JsonWebTokenError)",
            "new_string": "if (err instanceof TokenExpiredError) return res.status(401).json({ code: 'refresh_expired' })\n    if (err instanceof JsonWebTokenError)",
        ]), "The file src/auth/refresh.ts has been updated.")
        details["t4"] = toolDetail(.object(["file_path": "test/auth/refresh.test.ts", "content": "describe('refresh', () => { … })"]), "File created successfully.")
        details["t5"] = toolDetail(.object(["description": "Explore: other callers of verifyRefreshToken", "subagent_type": "Explore"]),
                                   "Only src/routes/session.ts calls it, inside a try/catch that maps TokenExpiredError to 401.")
        details["t6"] = toolDetail(.object(["command": "npm test -- auth", "description": "Run the auth test suite"]), nil)
        details["a1"] = .text(markdown: "Found it. `verifyRefreshToken` throws a `TokenExpiredError` …")

        let now = now.unixMilliseconds
        return MockChatTranscript(
            title: "Claude",
            status: MockChatTranscript.status(turnStartedAt: now - 95_000, permissionMode: "acceptEdits", model: "claude-opus-4-5"),
            items: items,
            prompts: [ChatPrompt(id: "p-bash", .permission(ChatPermission(
                toolName: "Bash", title: "Run a shell command", summary: "npm test -- auth",
                detail: "npm test -- auth\n\nRun the auth test suite\ncwd: ~/code/api-server",
                canAlwaysAllow: true)))],
            details: details,
            nextId: 100
        )
    }

    /// web-dashboard / login-redesign: idle, with a two-part question pending.
    static func loginRedesign(now: Date) -> MockChatTranscript {
        let items: [ChatItem] = [
            ChatItem(id: "u1", .user(text: "Let's redesign the login screens. Start with a proposal before touching code.", images: nil, queued: false, failed: false)),
            ChatItem(id: "t1", .tool(ChatTool(name: "Glob", summary: "Glob src/pages/auth/**/*.tsx", status: .done, hasDetail: true))),
            ChatItem(id: "a1", .text(markdown: """
                There are four auth screens today: **Login**, **Sign up**, **Forgot password** and **2FA**. \
                They share `AuthLayout.tsx` but each hard-codes its own spacing.

                Before I propose a layout I need two decisions from you.
                """, streaming: false)),
            ChatItem(id: "t2", .tool(ChatTool(name: "AskUserQuestion", summary: "Asking 2 questions", status: .waiting, hasDetail: false))),
        ]
        let questions = [
            ChatQuestion(question: "Which visual direction should the new login use?", header: "Direction", multiSelect: false, options: [
                ChatQuestionOption(label: "Split screen", description: "Illustration on the left, form on the right"),
                ChatQuestionOption(label: "Centered card", description: "A single card on a soft gradient"),
                ChatQuestionOption(label: "Full bleed", description: "Form over a full-screen product shot"),
            ]),
            ChatQuestion(question: "Which screens should get the new layout?", header: "Scope", multiSelect: true, options: [
                ChatQuestionOption(label: "Login"),
                ChatQuestionOption(label: "Sign up"),
                ChatQuestionOption(label: "Forgot password"),
                ChatQuestionOption(label: "2FA"),
            ]),
        ]
        return MockChatTranscript(
            title: "Claude",
            status: MockChatTranscript.status(turnStartedAt: now.unixMilliseconds - 40_000, permissionMode: "default", model: "claude-sonnet-4-5"),
            items: items,
            prompts: [ChatPrompt(id: "p-q", .question(questions))],
            details: ["t1": toolDetail(.object(["pattern": "src/pages/auth/**/*.tsx"]),
                                       "src/pages/auth/Login.tsx\nsrc/pages/auth/SignUp.tsx\nsrc/pages/auth/ForgotPassword.tsx\nsrc/pages/auth/TwoFactor.tsx")],
            nextId: 100
        )
    }

    /// web-dashboard / usage-charts: in plan mode, waiting for plan approval.
    static func usageCharts(now: Date) -> MockChatTranscript {
        let items: [ChatItem] = [
            ChatItem(id: "u1", .user(text: "Plan how we'd add a per-team usage chart to the dashboard.", images: nil, queued: false, failed: false)),
            ChatItem(id: "t1", .tool(ChatTool(name: "Read", summary: "Read src/charts/UsageChart.tsx", status: .done, hasDetail: true))),
            ChatItem(id: "t2", .tool(ChatTool(name: "Grep", summary: "Grep \"usage_events\" in api/", status: .error, hasDetail: true))),
            ChatItem(id: "n1", .notice(text: "Grep failed: api/ is not in this workspace", tone: .warning)),
            ChatItem(id: "a1", .text(markdown: "I have enough to propose a plan.", streaming: false)),
            ChatItem(id: "t3", .tool(ChatTool(name: "ExitPlanMode", summary: "Plan ready for review", status: .waiting, hasDetail: false))),
        ]
        return MockChatTranscript(
            title: "Claude",
            status: MockChatTranscript.status(turnStartedAt: now.unixMilliseconds - 20_000, permissionMode: "plan", model: "claude-opus-4-5"),
            items: items,
            prompts: [ChatPrompt(id: "p-plan", .plan(markdown: """
                ## Per-team usage chart

                1. **API**: add `GET /usage/teams?range=30d`, grouped by team, backed by the existing `usage_daily` rollup.
                2. **Data**: a `useTeamUsage(range)` hook with SWR caching.
                3. **UI**: a stacked bar variant of `UsageChart`, with a team legend and a *Top 5 + other* cut-off.
                4. **Tests**: API contract test and a Storybook story for the empty, loading and 20-team states.

                No schema changes needed.
                """))],
            details: [
                "t1": toolDetail(.object(["file_path": "src/charts/UsageChart.tsx"]), "export function UsageChart({ series }: Props) { … }"),
                "t2": toolDetail(.object(["pattern": "usage_events", "path": "api/"]), "Error: path api/ does not exist"),
            ],
            nextId: 100
        )
    }
}
