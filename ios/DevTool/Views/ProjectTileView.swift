import DevToolKit
import SwiftUI

extension Color {
    /// From `0xRRGGBB`.
    init(rgb: UInt32) {
        self.init(
            red: Double((rgb >> 16) & 0xff) / 255,
            green: Double((rgb >> 8) & 0xff) / 255,
            blue: Double(rgb & 0xff) / 255
        )
    }
}

/// A project's tile (§10): its emoji, else its initials, on the project's
/// colour in the current theme.
struct ProjectTileView: View {
    @Environment(\.colorScheme) private var colorScheme
    let tile: ProjectTile
    var size: CGFloat = 30

    var body: some View {
        let swatch = tile.swatch
        let dark = colorScheme == .dark
        ZStack {
            RoundedRectangle(cornerRadius: size * 0.26, style: .continuous)
                .fill(Color(rgb: dark ? swatch.darkBg : swatch.lightBg))
            if let emoji = tile.emoji {
                Text(emoji)
                    .font(.system(size: size * 0.52))
            } else {
                Text(tile.text)
                    .font(.system(size: size * (tile.text.count > 2 ? 0.32 : 0.4), weight: .bold))
                    .foregroundStyle(Color(rgb: dark ? swatch.darkFg : swatch.lightFg))
                    .minimumScaleFactor(0.6)
                    .lineLimit(1)
                    .padding(.horizontal, 2)
            }
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}

/// The project-first title of a task (Design › Rules): tile, **project** ›
/// stream (left out on `main`), and the task's name under it.
struct TaskTitleHeader: View {
    let project: InboxProject
    let task: InboxTask
    var tileSize: CGFloat = 32
    var projectFont: Font = .headline
    /// Appended to the task line, e.g. the chat's permission mode.
    var detail: String?

    var body: some View {
        HStack(spacing: 10) {
            ProjectTileView(tile: project.tile, size: tileSize)
            VStack(alignment: .leading, spacing: 1) {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text(project.name)
                        .font(projectFont)
                        .layoutPriority(1)
                    if let stream = streamName {
                        Text(stream)
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
                }
                .lineLimit(1)
                Text(detail.map { "\(task.name) · \($0)" } ?? task.name)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(project.place(of: task)), \(task.name)")
    }

    /// The stream, unless it is `main` (`InboxProject.place(of:)`).
    private var streamName: String? {
        let stream = project.streams.first { $0.id == task.streamId }
        if stream?.isMain == true { return nil }
        let name = stream?.name ?? task.streamName
        return name.isEmpty ? nil : name
    }
}

/// "Needs you · 4m", "Working · 12m", "Idle": a task's status with how long
/// it has been so.
struct StatusChip: View {
    let status: TabStatus
    let since: Int64?

    var body: some View {
        TimelineView(.everyMinute) { context in
            Text(text(now: context.date))
                .font(.footnote.weight(.semibold))
                .foregroundStyle(status.chipForeground)
                .padding(.horizontal, 8)
                .padding(.vertical, 3)
                .background(status.chipForeground.opacity(0.14), in: Capsule())
        }
    }

    private func text(now: Date) -> String {
        guard let since else { return status.label }
        return "\(status.label) · \(InboxClock.wait(now.unixMilliseconds - since))"
    }
}

extension TabStatus {
    var chipForeground: Color {
        switch self {
        case .attention: .orange
        case .working: .blue
        default: .secondary
        }
    }
}

/// What a task row says under its name: its agent when that isn't the Claude
/// chat, then what it needs or is doing.
enum TaskText {
    static func line(_ task: InboxTask, now: Date) -> String {
        var parts: [String] = []
        if let agent = task.agentTab, agent.type != .claudeChat { parts.append(agent.type.displayName) }
        switch task.inboxGroup(now: now) {
        case .snoozed:
            parts.append("Snoozed")
        case .settled:
            parts.append(InboxClock.activity(task) ?? "Done for now")
        case .needsYou, .yourTurn, .working, .quiet:
            if let activity = InboxClock.activity(task) {
                parts.append(activity)
            } else if task.status == .attention || task.status == .working || task.status == .exited {
                parts.append(task.status.label)
            } else if let topic = task.agentTab?.topic, !topic.isEmpty {
                parts.append(topic)
            } else if parts.isEmpty {
                parts.append("Idle")
            }
        }
        return parts.joined(separator: " · ")
    }

    /// The colour of that line: the attention colour when it needs you.
    static func color(_ task: InboxTask, now: Date) -> Color {
        switch task.inboxGroup(now: now) {
        case .needsYou: .orange
        case .working: .blue
        default: .secondary
        }
    }
}
