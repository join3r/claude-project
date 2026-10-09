import DevToolKit
import SwiftUI

extension TabStatus {
    var label: String {
        switch self {
        case .working: "Working"
        case .attention: "Needs you"
        case .exited: "Exited"
        case .idle: "Idle"
        case .unknown: "Unknown"
        }
    }

    var symbol: String {
        switch self {
        case .working: "waveform"
        case .attention: "exclamationmark.bubble.fill"
        case .exited: "stop.circle"
        case .idle: "moon.zzz"
        case .unknown: "questionmark.circle"
        }
    }

    var color: Color {
        switch self {
        case .working: .blue
        case .attention: .orange
        case .exited, .idle, .unknown: .gray
        }
    }
}

extension TabType {
    var symbol: String {
        switch self {
        case .claudeChat: "bubble.left.and.text.bubble.right"
        case .claude: "sparkles"
        case .codex: "curlybraces"
        case .pi: "p.circle"
        case .terminal: "terminal"
        case .unknown: "square.dashed"
        }
    }

    var displayName: String {
        switch self {
        case .claudeChat: "Claude chat"
        case .claude: "Claude Code"
        case .codex: "Codex"
        case .pi: "Pi"
        case .terminal: "Terminal"
        case .unknown(let raw): raw.isEmpty ? "Tab" : raw
        }
    }
}

/// Status of a tab or task: an SF Symbol plus a short label.
/// Idle renders nothing when `hideIdle` is set (task rows).
struct StatusBadge: View {
    let status: TabStatus
    var hideIdle = false

    var body: some View {
        switch status {
        case .idle where hideIdle:
            EmptyView()
        case .attention:
            content
                .font(.caption.weight(.semibold))
                .foregroundStyle(.orange)
                .padding(.horizontal, 8)
                .padding(.vertical, 3)
                .background(.orange.opacity(0.15), in: Capsule())
        case .working:
            content
                .font(.caption.weight(.medium))
                .foregroundStyle(.blue)
        default:
            content
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }

    private var content: some View {
        HStack(spacing: 4) {
            if status == .working {
                Image(systemName: status.symbol)
                    .symbolEffect(.variableColor.iterative.reversing, options: .repeating)
            } else {
                Image(systemName: status.symbol)
            }
            Text(status.label)
        }
        .fixedSize()
        .accessibilityElement(children: .combine)
    }
}

/// Tab type icon in a small tinted tile.
struct TabTypeIcon: View {
    let type: TabType
    let status: TabStatus

    var body: some View {
        Image(systemName: type.symbol)
            .font(.system(size: 15, weight: .medium))
            .foregroundStyle(status == .exited ? Color.secondary : Color.accentColor)
            .frame(width: 32, height: 32)
            .background(Color(.tertiarySystemFill), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
            .accessibilityLabel(type.displayName)
    }
}

/// The small `server.rack` by a DevTool server's name (its hello's `app`,
/// SPEC.md §4.3). Desktops show nothing.
struct ServerGlyph: View {
    var body: some View {
        Image(systemName: "server.rack")
            .font(.caption)
            .foregroundStyle(.secondary)
            .accessibilityLabel("Server")
    }
}

/// "Desktop offline · last seen 14:02" ("Server offline" for a DevTool
/// server), shown above a stale (cached) inbox.
struct OfflineBanner: View {
    let title: String
    let lastSeen: Date?

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "wifi.slash")
            Text(text)
                .lineLimit(2)
            Spacer(minLength: 0)
        }
        .font(.footnote.weight(.medium))
        .foregroundStyle(.secondary)
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.orange.opacity(0.12), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .accessibilityElement(children: .combine)
    }

    private var text: String {
        guard let lastSeen else { return "\(title) offline" }
        return "\(title) offline · last seen \(lastSeen.lastSeenText)"
    }
}

/// Relative time like "3 min ago", refreshed every minute.
struct RelativeTime: View {
    let date: Date

    var body: some View {
        TimelineView(.everyMinute) { context in
            Text(Self.text(for: date, now: context.date))
        }
    }

    static func text(for date: Date, now: Date) -> String {
        if now.timeIntervalSince(date) < 60 { return "just now" }
        return date.formatted(.relative(presentation: .numeric, unitsStyle: .abbreviated))
    }
}

/// Why a desktop can't be reached, and whether pairing again fixes it.
struct ConnectionProblem: Equatable {
    var symbol: String
    var title: String
    var message: String
    var canPairAgain: Bool
}

extension ConnectionState {
    /// Non-nil for states that need the user (revoked, unknown device, version
    /// mismatch) or that failed outright; plain offline isn't a problem.
    var problem: ConnectionProblem? {
        switch self {
        case .revoked:
            ConnectionProblem(
                symbol: "person.crop.circle.badge.xmark", title: "Access revoked",
                message: "This phone was removed on the desktop. Pair again to see it.", canPairAgain: true)
        case .unknownDevice:
            ConnectionProblem(
                symbol: "questionmark.circle", title: "Desktop doesn't know this phone",
                message: "The pairing was lost on the desktop. Show a new pairing code in DevTool → Settings → Mobile.",
                canPairAgain: true)
        case .incompatible(let updateDesktop):
            ConnectionProblem(
                symbol: "arrow.up.circle", title: updateDesktop ? "Update DevTool" : "Update the app",
                message: updateDesktop
                    ? "The desktop runs an older DevTool that this app can't talk to. Update DevTool on the desktop."
                    : "The desktop needs a newer version of this app. Update the app.",
                canPairAgain: false)
        case .failed(let message):
            ConnectionProblem(symbol: "exclamationmark.triangle", title: "Can't connect", message: message, canPairAgain: false)
        default:
            nil
        }
    }
}

/// Shown above a desktop's (cached) inbox when the connection needs attention.
struct ConnectionProblemBanner: View {
    let desktopName: String
    let problem: ConnectionProblem
    let onPairAgain: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label {
                Text("\(desktopName): \(problem.title)")
                    .font(.subheadline.weight(.semibold))
            } icon: {
                Image(systemName: problem.symbol)
            }
            .foregroundStyle(.red)
            Text(problem.message)
                .font(.footnote)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            if problem.canPairAgain {
                Button("Pair again", systemImage: "qrcode.viewfinder", action: onPairAgain)
                    .buttonStyle(.borderedProminent)
                    .controlSize(.small)
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.red.opacity(0.1), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    }
}
