import DevToolKit
import SwiftUI

/// One transcript row.
struct ChatItemRow: View {
    let item: ChatItem
    /// Fetches and opens tool-result images; nil shows only how many there are.
    var images: ChatImageActions? = nil
    let onOpenDetail: (ChatItem) -> Void

    var body: some View {
        switch item.content {
        case .user(let text, let images, let queued, let failed):
            UserBubble(text: text, images: images ?? 0, queued: queued, failed: failed)
        case .text(let markdown, let streaming):
            AssistantText(markdown: markdown, streaming: streaming)
        case .thinking(let preview, let streaming):
            ThinkingRow(preview: preview, streaming: streaming)
        case .tool(let tool):
            if let count = tool.images, count > 0 {
                VStack(alignment: .leading, spacing: 6) {
                    ToolRow(tool: tool) { onOpenDetail(item) }
                    ToolImages(itemId: item.id, count: min(count, 4), actions: images)
                }
            } else {
                ToolRow(tool: tool) { onOpenDetail(item) }
            }
        case .notice(let text, let tone):
            NoticeRow(text: text, tone: tone)
        case .unknown:
            NoticeRow(text: "Needs a newer app to show this", tone: .muted, symbol: "arrow.up.circle")
        }
    }
}

struct UserBubble: View {
    let text: String
    let images: Int
    let queued: Bool
    let failed: Bool

    var body: some View {
        VStack(alignment: .trailing, spacing: 4) {
            VStack(alignment: .leading, spacing: 6) {
                if images > 0 {
                    Label(images == 1 ? "1 image" : "\(images) images", systemImage: "photo")
                        .font(.caption.weight(.medium))
                        .foregroundStyle(.white.opacity(0.85))
                }
                Text(text)
                    .foregroundStyle(.white)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            .background(Color.accentColor.opacity(queued ? 0.55 : 1), in: BubbleShape())
            if queued || failed {
                Label(failed ? "Not sent" : "Queued", systemImage: failed ? "exclamationmark.circle" : "clock")
                    .font(.caption2)
                    .foregroundStyle(failed ? .red : .secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .trailing)
        .padding(.leading, 48)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("You: \(text)")
    }
}

private struct BubbleShape: Shape {
    func path(in rect: CGRect) -> Path {
        Path(roundedRect: rect, cornerRadii: RectangleCornerRadii(topLeading: 18, bottomLeading: 18, bottomTrailing: 6, topTrailing: 18), style: .continuous)
    }
}

struct AssistantText: View {
    let markdown: String
    let streaming: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            MarkdownText(markdown: markdown)
                .textSelection(.enabled)
            if streaming {
                StreamingDots()
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// Three pulsing dots: text is still arriving.
struct StreamingDots: View {
    var body: some View {
        HStack(spacing: 4) {
            ForEach(0..<3) { index in
                Circle()
                    .frame(width: 6, height: 6)
                    .phaseAnimator([0.25, 1.0]) { dot, phase in
                        dot.opacity(phase)
                    } animation: { _ in
                        .easeInOut(duration: 0.6).delay(Double(index) * 0.2)
                    }
            }
        }
        .foregroundStyle(.secondary)
        .accessibilityLabel("Typing")
    }
}

struct ThinkingRow: View {
    let preview: String
    let streaming: Bool
    @State private var expanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Button {
                withAnimation(.snappy) { expanded.toggle() }
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: "brain")
                    Text(streaming ? "Thinking…" : "Thought")
                    Image(systemName: "chevron.right")
                        .font(.caption2.weight(.semibold))
                        .rotationEffect(.degrees(expanded ? 90 : 0))
                }
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            if expanded {
                Text(preview)
                    .font(.subheadline)
                    .italic()
                    .foregroundStyle(.secondary)
                    .padding(.leading, 10)
                    .overlay(alignment: .leading) { Capsule().fill(.quaternary).frame(width: 2) }
                    .fixedSize(horizontal: false, vertical: true)
                    .transition(.opacity)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

struct ToolRow: View {
    let tool: ChatTool
    let onTap: () -> Void

    var body: some View {
        Button(action: onTap) {
            HStack(spacing: 10) {
                Image(systemName: tool.symbol)
                    .font(.footnote.weight(.medium))
                    .foregroundStyle(.secondary)
                    .frame(width: 18)
                VStack(alignment: .leading, spacing: 2) {
                    Text(tool.summary.isEmpty ? tool.name : tool.summary)
                        .font(.footnote.monospaced())
                        .foregroundStyle(.primary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    if let childCount = tool.childCount, childCount > 0 {
                        Text(tool.lastChild.map { "\(childCount) steps · \($0)" } ?? "\(childCount) steps")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                }
                Spacer(minLength: 4)
                ToolStatusIcon(status: tool.status)
                if tool.hasDetail {
                    Image(systemName: "chevron.right")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(.tertiary)
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!tool.hasDetail)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(tool.name): \(tool.summary), \(tool.status.label)")
        .accessibilityHint(tool.hasDetail ? "Shows the input and output" : "")
    }
}

struct ToolStatusIcon: View {
    let status: ChatToolStatus

    var body: some View {
        switch status {
        case .running:
            ProgressView().controlSize(.mini)
        case .pending:
            Image(systemName: "circle.dotted").foregroundStyle(.secondary)
        case .waiting:
            Image(systemName: "hand.raised.fill").foregroundStyle(.orange)
        case .done:
            Image(systemName: "checkmark.circle.fill").foregroundStyle(.green)
        case .error:
            Image(systemName: "xmark.octagon.fill").foregroundStyle(.red)
        case .denied:
            Image(systemName: "nosign").foregroundStyle(.secondary)
        }
    }
}

struct NoticeRow: View {
    let text: String
    let tone: ChatNoticeTone
    var symbol: String?

    var body: some View {
        Label {
            Text(text)
                .fixedSize(horizontal: false, vertical: true)
        } icon: {
            Image(systemName: symbol ?? tone.symbol)
        }
        .font(.footnote)
        .foregroundStyle(tone.color)
        .padding(.horizontal, tone == .muted ? 0 : 10)
        .padding(.vertical, tone == .muted ? 0 : 6)
        .background {
            if tone != .muted {
                RoundedRectangle(cornerRadius: 8, style: .continuous).fill(tone.color.opacity(0.12))
            }
        }
        .frame(maxWidth: .infinity, alignment: tone == .muted ? .center : .leading)
    }
}

/// "Working · 1:35" while a turn runs.
struct WorkingRow: View {
    let since: Date?

    var body: some View {
        HStack(spacing: 8) {
            ProgressView().controlSize(.small)
            if let since {
                TimelineView(.periodic(from: .now, by: 1)) { context in
                    Text("Working · \(Self.elapsed(from: since, to: context.date))")
                        .monospacedDigit()
                }
            } else {
                Text("Working…")
            }
        }
        .font(.footnote)
        .foregroundStyle(.secondary)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    static func elapsed(from start: Date, to now: Date) -> String {
        let seconds = max(0, Int(now.timeIntervalSince(start)))
        return seconds >= 3600
            ? String(format: "%d:%02d:%02d", seconds / 3600, seconds / 60 % 60, seconds % 60)
            : String(format: "%d:%02d", seconds / 60, seconds % 60)
    }
}

extension ChatNoticeTone {
    var color: Color {
        switch self {
        case .muted: .secondary
        case .warning: .orange
        case .error: .red
        }
    }

    var symbol: String {
        switch self {
        case .muted: "info.circle"
        case .warning: "exclamationmark.triangle"
        case .error: "xmark.octagon"
        }
    }
}

extension ChatToolStatus {
    var label: String {
        switch self {
        case .pending: "pending"
        case .running: "running"
        case .waiting: "waiting for you"
        case .done: "done"
        case .error: "failed"
        case .denied: "denied"
        }
    }
}

extension ChatTool {
    var symbol: String {
        switch name {
        case "Bash", "BashOutput", "KillShell", "KillBash": "terminal"
        case "Read", "NotebookRead": "doc.text"
        case "Edit", "MultiEdit", "NotebookEdit": "pencil"
        case "Write": "square.and.pencil"
        case "Grep", "Glob", "LS", "ToolSearch": "magnifyingglass"
        case "Task", "Agent": "person.2"
        case "WebFetch", "WebSearch": "globe"
        case "TodoWrite": "checklist"
        case "AskUserQuestion": "questionmark.bubble"
        case "ExitPlanMode", "EnterPlanMode": "list.bullet.clipboard"
        case "Skill": "wand.and.stars"
        default: name.hasPrefix("mcp__") ? "puzzlepiece.extension" : "wrench.and.screwdriver"
        }
    }
}
