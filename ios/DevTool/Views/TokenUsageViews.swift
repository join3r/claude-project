import DevToolKit
import SwiftUI

/// Token usage (§8.22): the project screen's Tokens section and the Inbox's
/// Token usage screen, as the desktop's Tokens card and Token usage window.
enum TokenUsageSettings {
    /// One range for both screens, as last picked.
    static let rangeKey = "tokens.range"
    /// Days the chart shows, as the desktop's card.
    static let chartDays = 30
    /// How often an open screen asks again (the desktop reads only what the agents appended).
    static let refreshEvery: Duration = .seconds(60)
}

extension ProjectTile {
    /// The tile's text colour: the project's colour, strong enough for a bar in either theme.
    func barColor(_ scheme: ColorScheme) -> Color {
        Color(rgb: scheme == .dark ? swatch.darkFg : swatch.lightFg)
    }
}

struct TokenRangePicker: View {
    @Binding var range: TokenRange

    var body: some View {
        Picker("Range", selection: $range) {
            ForEach(TokenRange.allCases) { Text($0.label).tag($0) }
        }
        .pickerStyle(.segmented)
    }
}

/// "in 1.2M · out 340k · cache 98M read, 4.1M write".
struct TokenBreakdown: View {
    let counts: TokenCounts

    var body: some View {
        Text("in \(TokenFormat.count(counts.input)) · out \(TokenFormat.count(counts.output)) · cache \(TokenFormat.count(counts.cacheRead)) read, \(TokenFormat.count(counts.cacheWrite)) write")
            .font(.footnote.monospacedDigit())
            .foregroundStyle(.secondary)
            .accessibilityLabel("\(TokenFormat.count(counts.input)) input, \(TokenFormat.count(counts.output)) output, \(TokenFormat.count(counts.cacheRead)) cache read, \(TokenFormat.count(counts.cacheWrite)) cache write")
    }
}

/// The last 30 days as bars in the project's colour, newest on the right.
struct TokenDailyBars: View {
    let rows: [TokenUsageRow]
    let today: String
    let color: Color

    var body: some View {
        let days = rows.daily(TokenUsageSettings.chartDays, today: today)
        let max = Swift.max(1, days.map(\.total).max() ?? 0)
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .bottom, spacing: 2) {
                ForEach(days) { day in
                    RoundedRectangle(cornerRadius: 1.5, style: .continuous)
                        .fill(day.total > 0 ? color : Color(.tertiarySystemFill))
                        .frame(maxWidth: .infinity)
                        .frame(height: day.total > 0 ? Swift.max(3, 40 * CGFloat(day.total) / CGFloat(max)) : 2)
                }
            }
            .frame(height: 40, alignment: .bottom)
            HStack {
                Text("30 days ago")
                Spacer()
                Text("Today")
            }
            .font(.caption2)
            .foregroundStyle(.secondary)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Tokens per day over the last 30 days")
        .accessibilityValue(summary(days))
    }

    private func summary(_ days: [TokenDailyTotal]) -> String {
        guard let top = days.max(by: { $0.total < $1.total }), top.total > 0 else { return "None" }
        let active = days.filter { $0.total > 0 }.count
        let date = TokenDay.date(top.day)?.formatted(.dateTime.day().month(.abbreviated)) ?? top.day
        return "\(active) days with use, most on \(date): \(TokenFormat.count(top.total))"
    }
}

/// Per agent and model, largest first: "Claude  claude-opus-5-5  412M".
struct TokenModelRows: View {
    let rows: [TokenUsageRow]
    var limit = 4

    var body: some View {
        let models = rows.byModel
        let rest = models.dropFirst(limit)
        VStack(alignment: .leading, spacing: 4) {
            ForEach(models.prefix(limit)) { total in
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(TokenUsageRow.label(agent: total.agent))
                        .foregroundStyle(.secondary)
                    Text(total.model ?? "")
                        .font(.footnote.monospaced())
                        .lineLimit(1)
                        .truncationMode(.middle)
                    Spacer(minLength: 8)
                    Text(TokenFormat.count(total.counts.total))
                        .monospacedDigit()
                }
                .font(.footnote)
                .accessibilityElement(children: .combine)
            }
            if !rest.isEmpty {
                HStack {
                    Text(rest.count == 1 ? "1 more model" : "\(rest.count) more models")
                    Spacer()
                    Text(TokenFormat.count(rest.reduce(0) { $0 + $1.counts.total }))
                        .monospacedDigit()
                }
                .font(.footnote)
                .foregroundStyle(.secondary)
                .accessibilityElement(children: .combine)
            }
        }
    }
}

/// The big number and its unit.
struct TokenTotalText: View {
    let total: Int64

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Text(TokenFormat.count(total))
                .font(.largeTitle.weight(.semibold).monospacedDigit())
            Text("tokens")
                .font(.subheadline)
                .foregroundStyle(.secondary)
        }
        .accessibilityElement(children: .combine)
    }
}

/// The project screen's Tokens section: the range's total, its split, the
/// last 30 days and the top models. Shown for a desktop that lists `tokens.usage`.
struct ProjectTokensSection: View {
    @Environment(AppModel.self) private var model
    @Environment(\.colorScheme) private var colorScheme
    @AppStorage(TokenUsageSettings.rangeKey) private var range: TokenRange = .month
    let ref: ProjectRef
    let project: InboxProject

    @State private var usage: TokenUsageProject?
    @State private var today = ""
    @State private var loaded = false
    @State private var error: String?

    var body: some View {
        Section {
            content
                .task(id: ref) {
                    while !Task.isCancelled {
                        await load()
                        guard (try? await Task.sleep(for: TokenUsageSettings.refreshEvery)) != nil else { return }
                    }
                }
        } header: {
            Text("Tokens")
        }
    }

    @ViewBuilder
    private var content: some View {
        if let usage, !usage.unavailable {
            let inRange = usage.rows.inRange(range, today: today)
            let counts = inRange.counts
            VStack(alignment: .leading, spacing: 10) {
                TokenRangePicker(range: $range)
                TokenTotalText(total: counts.total)
                TokenBreakdown(counts: counts)
                TokenDailyBars(rows: usage.rows, today: today, color: project.tile.barColor(colorScheme))
                TokenModelRows(rows: inRange)
            }
            .padding(.vertical, 4)
        } else if usage?.unavailable == true {
            Text("Not counted for SSH or shell-command projects.")
                .font(.footnote)
                .foregroundStyle(.secondary)
        } else if let error {
            Text("Couldn't read token usage: \(error)")
                .font(.footnote)
                .foregroundStyle(.secondary)
        } else if !loaded {
            HStack(spacing: 8) {
                ProgressView()
                Text("Reading agent sessions…")
                    .foregroundStyle(.secondary)
            }
            .font(.footnote)
        }
    }

    private func load() async {
        guard !model.isOffline(ref.desktopId) else {
            if usage == nil { error = "\(model.kindTitle(ref.desktopId)) offline" }
            return
        }
        do {
            let result = try await model.tokensUsage(desktopId: ref.desktopId, projectId: ref.projectId)
            usage = result.projects.first { $0.projectId == ref.projectId }
            today = result.today
            error = nil
        } catch is CancellationError {
            return
        } catch {
            // Keep what was there; say why only when there is nothing.
            if usage == nil { self.error = error.localizedDescription }
        }
        loaded = true
    }
}

/// A project's tokens in the Token usage list.
struct TokenUsageEntry: Identifiable {
    let ref: ProjectRef
    let project: InboxProject
    let rows: [TokenUsageRow]
    let counts: TokenCounts
    var id: ProjectRef { ref }
}

/// Every project's tokens over a range, largest first, with the total and
/// each agent's on top. A row opens its project's screen. Reached from the
/// Inbox's toolbar; it covers every paired desktop that lists `tokens.usage`.
struct TokenUsageView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var colorScheme
    @AppStorage(TokenUsageSettings.rangeKey) private var range: TokenRange = .month
    /// Called with the tapped row, just before the sheet goes away.
    let onOpenProject: (ProjectRef) -> Void

    @State private var results: [String: TokensUsageResult] = [:]
    @State private var errors: [String: String] = [:]
    @State private var loading = true

    var body: some View {
        let desktops = model.desktops.filter { model.supports(DesktopFeature.tokensUsage, on: $0.id) }
        let entries = entries(desktops)
        let all = entries.flatMap(\.rows)
        let max = Swift.max(1, entries.map(\.counts.total).max() ?? 0)
        List {
            Section {
                VStack(alignment: .leading, spacing: 10) {
                    TokenRangePicker(range: $range)
                    Text("All projects")
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(.secondary)
                    TokenTotalText(total: all.counts.total)
                    let agents = all.byAgent
                    if !agents.isEmpty {
                        HStack(alignment: .firstTextBaseline, spacing: 18) {
                            ForEach(agents) { agent in
                                VStack(alignment: .leading, spacing: 1) {
                                    Text(TokenUsageRow.label(agent: agent.agent))
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                    Text(TokenFormat.count(agent.counts.total))
                                        .font(.headline.monospacedDigit())
                                }
                                .accessibilityElement(children: .combine)
                            }
                        }
                    }
                    TokenBreakdown(counts: all.counts)
                }
                .padding(.vertical, 4)
            }
            Section {
                if entries.isEmpty {
                    Text(loading ? "Reading agent sessions…" : "Nothing counted yet.")
                        .foregroundStyle(.secondary)
                }
                ForEach(entries) { entry in
                    row(entry, max: max, showDesktop: desktops.count > 1)
                }
            } footer: {
                Text(footer(desktops))
            }
        }
        .listStyle(.insetGrouped)
        .navigationTitle("Token usage")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button("Done") { dismiss() }
            }
            if loading {
                ToolbarItem(placement: .topBarLeading) { ProgressView() }
            }
        }
        .refreshable { await load() }
        .task {
            while !Task.isCancelled {
                await load()
                guard (try? await Task.sleep(for: TokenUsageSettings.refreshEvery)) != nil else { return }
            }
        }
    }

    private func row(_ entry: TokenUsageEntry, max: Int64, showDesktop: Bool) -> some View {
        let total = entry.counts.total
        return Button {
            onOpenProject(entry.ref)
            dismiss()
        } label: {
            HStack(spacing: 12) {
                ProjectTileView(tile: entry.project.tile, size: 30)
                VStack(alignment: .leading, spacing: 5) {
                    HStack(alignment: .firstTextBaseline) {
                        Text(entry.project.name)
                            .lineLimit(1)
                        if showDesktop, let name = model.desktop(entry.ref.desktopId)?.name {
                            Text(name)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                        }
                        Spacer(minLength: 8)
                        Text(total > 0 ? TokenFormat.count(total) : "—")
                            .monospacedDigit()
                            .foregroundStyle(total > 0 ? .primary : .secondary)
                    }
                    GeometryReader { geometry in
                        ZStack(alignment: .leading) {
                            Capsule().fill(Color(.tertiarySystemFill))
                            if total > 0 {
                                Capsule()
                                    .fill(entry.project.tile.barColor(colorScheme))
                                    .frame(width: Swift.max(4, geometry.size.width * CGFloat(total) / CGFloat(max)))
                            }
                        }
                    }
                    .frame(height: 5)
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(entry.project.name)
        .accessibilityValue(total > 0 ? "\(TokenFormat.count(total)) tokens" : "No tokens")
        .accessibilityHint("Opens the project")
        .accessibilityAddTraits(.isButton)
    }

    /// Each counted project of each desktop, largest first; ones the desktop
    /// can't count, or that its inbox no longer lists, are left out.
    private func entries(_ desktops: [DesktopRecord]) -> [TokenUsageEntry] {
        var out: [TokenUsageEntry] = []
        for desktop in desktops {
            guard let result = results[desktop.id], let inbox = model.inboxes[desktop.id] else { continue }
            for usage in result.projects where !usage.unavailable {
                guard let project = inbox.projects.first(where: { $0.id == usage.projectId }) else { continue }
                let rows = usage.rows.inRange(range, today: result.today)
                out.append(TokenUsageEntry(ref: ProjectRef(desktopId: desktop.id, projectId: project.id), project: project, rows: rows, counts: rows.counts))
            }
        }
        return out.enumerated()
            .sorted { $0.element.counts.total != $1.element.counts.total ? $0.element.counts.total > $1.element.counts.total : $0.offset < $1.offset }
            .map(\.element)
    }

    private func footer(_ desktops: [DesktopRecord]) -> String {
        var parts = ["Counted from Claude Code, Codex and Pi session files in each project's folder and its worktrees, on the desktop it lives on."]
        let skipped = desktops.reduce(0) { sum, desktop in sum + (results[desktop.id]?.projects.filter(\.unavailable).count ?? 0) }
        if skipped > 0 { parts.append(skipped == 1 ? "1 SSH or shell-command project isn't counted." : "\(skipped) SSH or shell-command projects aren't counted.") }
        for desktop in desktops where results[desktop.id] == nil {
            if model.isOffline(desktop.id) {
                parts.append("\(desktop.name) is offline, so its projects aren't counted.")
            } else if let error = errors[desktop.id] {
                parts.append("Couldn't read \(desktop.name): \(error)")
            }
        }
        return parts.joined(separator: " ")
    }

    private func load() async {
        let ids = model.desktops.filter { model.supports(DesktopFeature.tokensUsage, on: $0.id) && !model.isOffline($0.id) }.map(\.id)
        loading = true
        defer { loading = false }
        // One after the other: a phone has a desktop or two, and each answers from its tallies.
        for id in ids {
            do {
                results[id] = try await model.tokensUsage(desktopId: id)
                errors[id] = nil
            } catch is CancellationError {
                return
            } catch {
                errors[id] = error.localizedDescription
            }
        }
    }
}
