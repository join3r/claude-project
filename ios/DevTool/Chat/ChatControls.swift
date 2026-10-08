import DevToolKit
import SwiftUI

/// The desktop's labels for `TaskOp.modes`.
enum PermissionModes {
    static let labels: [String: String] = [
        "default": "Ask", "acceptEdits": "Accept edits", "plan": "Plan", "auto": "Auto", "bypassPermissions": "Bypass",
    ]

    static func label(_ mode: String?) -> String {
        mode.flatMap { labels[$0] } ?? "Ask"
    }
}

/// The desktop composer's pickers and meter above the phone's composer: permission
/// mode, model and effort menus, then the plan limits. Tapping the meter shows the
/// details, with when each window resets.
struct ChatControlsBar: View {
    let status: ChatStatus
    /// False on a desktop without `chat.settings`, or while offline: the chips only show.
    let editable: Bool
    /// One of mode, model or effort; "" for model or effort is the default.
    let change: (_ mode: String?, _ model: String?, _ effort: String?) -> Void

    @State private var showingUsage = false

    var body: some View {
        HStack(spacing: 8) {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 6) {
                    modeMenu
                    if let settings = status.settings {
                        modelMenu(settings)
                        if !settings.efforts.isEmpty { effortMenu(settings) }
                    }
                }
            }
            .scrollBounceBehavior(.basedOnSize, axes: .horizontal)
            if let usage = status.usage, usage.fiveHour != nil || usage.sevenDay != nil || usage.contextTokens != nil {
                Button { showingUsage = true } label: { UsageMeter(usage: usage) }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Usage and limits")
                    .popover(isPresented: $showingUsage, arrowEdge: .bottom) {
                        UsageDetails(usage: usage)
                            .presentationCompactAdaptation(.popover)
                    }
            }
        }
        .font(.caption)
    }

    // MARK: Menus

    private var modeMenu: some View {
        Menu {
            Picker("Permission mode", selection: selection(status.permissionMode ?? "default") { change($0, nil, nil) }) {
                ForEach(TaskOp.modes, id: \.self) { mode in
                    Text(PermissionModes.label(mode)).tag(mode)
                }
            }
        } label: {
            Chip(text: PermissionModes.label(status.permissionMode), symbol: modeSymbol)
        }
        .disabled(!editable)
        .accessibilityLabel("Permission mode: \(PermissionModes.label(status.permissionMode))")
    }

    private var modeSymbol: String {
        switch status.permissionMode {
        case "plan": "list.bullet.clipboard"
        case "acceptEdits": "pencil"
        case "auto": "sparkles"
        case "bypassPermissions": "exclamationmark.shield"
        default: "hand.raised"
        }
    }

    private func modelMenu(_ settings: ChatSettings) -> some View {
        let defaultLabel = settings.model == nil ? settings.modelName.map { "Default (\($0))" } ?? "Default" : "Default"
        // The chip names what runs; the menu says whether that is the default.
        let label = settings.model.map { picked in settings.models.first { $0.value == picked }?.label ?? settings.modelName ?? picked }
            ?? settings.modelName ?? "Default"
        return Menu {
            Picker("Model", selection: selection(settings.model ?? "") { change(nil, $0, nil) }) {
                Text(defaultLabel).tag("")
                ForEach(settings.models, id: \.value) { option in
                    Text(option.label).tag(option.value)
                }
            }
        } label: {
            Chip(text: label, symbol: "cpu")
        }
        .disabled(!editable)
        .accessibilityLabel("Model: \(label)")
    }

    private func effortMenu(_ settings: ChatSettings) -> some View {
        let defaultLabel = settings.defaultEffort.map { "Default (\($0))" } ?? "Default"
        let label = settings.effort ?? settings.defaultEffort ?? "Default"
        return Menu {
            Picker("Effort", selection: selection(settings.effort ?? "") { change(nil, nil, $0) }) {
                Text(defaultLabel).tag("")
                ForEach(settings.efforts, id: \.self) { level in
                    Text(level).tag(level)
                }
            }
        } label: {
            Chip(text: label, symbol: "gauge.with.dots.needle.50percent")
        }
        .disabled(!editable)
        .accessibilityLabel("Effort: \(label)")
    }

    /// A picker binding that reads the current value and sends a change; the
    /// desktop's next event brings the new value back.
    private func selection(_ value: String, set: @escaping (String) -> Void) -> Binding<String> {
        Binding(get: { value }, set: { if $0 != value { set($0) } })
    }
}

/// A compact picker chip.
private struct Chip: View {
    let text: String
    let symbol: String

    var body: some View {
        HStack(spacing: 4) {
            Image(systemName: symbol)
                .imageScale(.small)
            Text(text)
                .lineLimit(1)
            Image(systemName: "chevron.up.chevron.down")
                .imageScale(.small)
                .foregroundStyle(.tertiary)
        }
        .foregroundStyle(.secondary)
        .padding(.horizontal, 9)
        .padding(.vertical, 5)
        .background(Color(.secondarySystemBackground), in: Capsule())
        .contentShape(Capsule())
    }
}

// MARK: - Usage

/// Colour bands, as the desktop's meter has them.
enum UsageTone {
    /// Plan windows, in percent used.
    static func limit(_ used: Int) -> Color {
        used > 90 ? .red : used > 75 ? .orange : .green
    }

    /// Context, in tokens: a 1M window degrades long before it fills.
    static func context(_ tokens: Int64) -> Color {
        tokens > 200_000 ? .red : tokens >= 150_000 ? .orange : .green
    }
}

enum UsageFormat {
    /// Time left until `ms`: "42m", "3h 12m", "2d 5h"; "now" once it has passed.
    static func resetIn(_ ms: Int64, now: Date) -> String {
        let left = Int(ceil((Double(ms) / 1000 - now.timeIntervalSince1970) / 60))
        if left <= 0 { return "now" }
        if left < 60 { return "\(left)m" }
        let hours = left / 60
        if hours < 24 { return "\(hours)h \(left % 60)m" }
        return "\(hours / 24)d \(hours % 24)h"
    }

    /// When `ms` falls, on the clock: "14:30" today, "Thu 09:10" on another day.
    static func resetAt(_ ms: Int64, now: Date) -> String {
        let date = Date(unixMilliseconds: ms)
        let time = date.formatted(.dateTime.hour(.twoDigits(amPM: .omitted)).minute(.twoDigits))
        if Calendar.current.isDate(date, inSameDayAs: now) { return time }
        return "\(date.formatted(.dateTime.weekday(.abbreviated))) \(time)"
    }

    /// "14:30 · in 4h 16m", or "resetting now".
    static func reset(_ ms: Int64, now: Date) -> String {
        let left = resetIn(ms, now: now)
        return left == "now" ? "resetting now" : "\(resetAt(ms, now: now)) · in \(left)"
    }

    static func tokens(_ n: Int64) -> String {
        if n >= 1_000_000 {
            let m = Double(n) / 1_000_000
            return n % 1_000_000 == 0 ? "\(Int(m))M" : String(format: "%.1fM", m)
        }
        if n >= 1000 { return "\(Int((Double(n) / 1000).rounded()))k" }
        return "\(n)"
    }

    static func cost(cents: Int64) -> String {
        let usd = Double(cents) / 100
        return usd < 10 ? String(format: "$%.2f", usd) : String(format: "$%.1f", usd)
    }
}

/// The compact meter, as the desktop's strip: how full the context is (ring + used
/// tokens), then the 5-hour bar over the weekly one and the 5-hour countdown.
private struct UsageMeter: View {
    let usage: ChatUsage

    var body: some View {
        TimelineView(.periodic(from: .now, by: 30)) { context in
            HStack(spacing: 6) {
                if let tokens = usage.contextTokens {
                    HStack(spacing: 4) {
                        ContextRing(tokens: tokens, max: usage.contextMax)
                        Text(UsageFormat.tokens(tokens))
                            .monospacedDigit()
                            .foregroundStyle(UsageTone.context(tokens))
                    }
                }
                if usage.fiveHour != nil || usage.sevenDay != nil {
                    VStack(spacing: 3) {
                        Bar(window: usage.fiveHour)
                        Bar(window: usage.sevenDay)
                    }
                    .frame(width: 34)
                    if let five = usage.fiveHour {
                        Text("\(five.used)%")
                            .monospacedDigit()
                        if let resetsAt = five.resetsAt {
                            Text(UsageFormat.resetIn(resetsAt, now: context.date))
                                .monospacedDigit()
                                .foregroundStyle(.tertiary)
                        }
                    }
                }
            }
            .foregroundStyle(.secondary)
            .padding(.horizontal, 9)
            .padding(.vertical, 5)
            .background(Color(.secondarySystemBackground), in: Capsule())
            .contentShape(Capsule())
        }
    }
}

/// How full the context is, as a ring in the context's colour band; a full dot when
/// the window size is unknown.
private struct ContextRing: View {
    let tokens: Int64
    let max: Int64?

    var body: some View {
        let tone = UsageTone.context(tokens)
        let fraction = max.map { $0 > 0 ? Swift.min(1, Swift.max(0, Double(tokens) / Double($0))) : 1 } ?? 1
        ZStack {
            Circle().stroke(tone.opacity(0.2), lineWidth: 2)
            Circle()
                .trim(from: 0, to: fraction)
                .stroke(tone, style: StrokeStyle(lineWidth: 2, lineCap: .round))
                .rotationEffect(.degrees(-90))
        }
        .frame(width: 11, height: 11)
    }
}

/// One thin bar of a plan window; an empty track when unknown.
private struct Bar: View {
    let window: ChatLimitWindow?

    var body: some View {
        GeometryReader { geo in
            ZStack(alignment: .leading) {
                Capsule().fill(Color.secondary.opacity(0.2))
                if let window {
                    Capsule()
                        .fill(UsageTone.limit(window.used))
                        .frame(width: geo.size.width * CGFloat(min(100, max(0, window.used))) / 100)
                }
            }
        }
        .frame(height: 3)
    }
}

/// What tapping the meter shows: each window's use and reset, the context and the cost.
private struct UsageDetails: View {
    let usage: ChatUsage

    var body: some View {
        TimelineView(.periodic(from: .now, by: 30)) { context in
            VStack(alignment: .leading, spacing: 12) {
                if let five = usage.fiveHour {
                    limitRow("5-hour limit", five, now: context.date)
                }
                if let week = usage.sevenDay {
                    limitRow("Weekly limit", week, now: context.date)
                }
                if let tokens = usage.contextTokens {
                    row("Context") {
                        if let max = usage.contextMax, max > 0 {
                            Text("\(UsageFormat.tokens(tokens)) / \(UsageFormat.tokens(max)) · \(Int((Double(tokens) / Double(max) * 100).rounded()))%")
                        } else {
                            Text(UsageFormat.tokens(tokens))
                        }
                    }
                    .foregroundStyle(UsageTone.context(tokens))
                }
                if let cents = usage.costCents {
                    row("Session cost") {
                        Text(UsageFormat.cost(cents: cents))
                    }
                    Text("At API list prices, whatever your plan pays.")
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                }
            }
            .font(.footnote)
            .monospacedDigit()
            .padding(16)
            .frame(minWidth: 260)
        }
    }

    private func limitRow(_ title: String, _ window: ChatLimitWindow, now: Date) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            row(title) {
                Text("\(window.used)% used")
                    .foregroundStyle(UsageTone.limit(window.used))
            }
            Bar(window: window)
            if let resetsAt = window.resetsAt {
                Text("Resets \(UsageFormat.reset(resetsAt, now: now))")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private func row(_ title: String, @ViewBuilder value: () -> some View) -> some View {
        HStack(alignment: .firstTextBaseline) {
            Text(title)
            Spacer(minLength: 16)
            value()
        }
    }
}
