import DevToolKit
import SwiftUI

/// The glyph a task row puts before its line while the task lands into its
/// stream or has stopped doing so (§4.4 `landing`); the line itself says where.
struct LandingGlyph: View {
    let landing: TaskLanding

    var body: some View {
        Image(systemName: symbol)
            .imageScale(.small)
            .accessibilityLabel(landing.badge)
    }

    private var symbol: String {
        switch landing.state {
        case .conflict: "exclamationmark.triangle.fill"
        case .blocked: "hand.raised.fill"
        case .landing, .fixing, .unknown: "arrow.triangle.merge"
        }
    }
}

/// A task screen's landing banner, as the desktop's (§8.3): where the landing
/// is, the files in the way, and the buttons `task.land` offers (§8.15).
/// "I'll fix it" stays on the desktop. A result worth saying stays a few
/// seconds after the landing itself is gone.
struct TaskLandingBanner: View {
    @Environment(AppModel.self) private var model
    let ref: TaskRef
    let task: InboxTask
    /// A retry finished a close: the task went to Done.
    let onClosed: () -> Void

    @State private var running: TaskLandParams.Action?
    @State private var notice: Notice?

    struct Notice: Equatable {
        let text: String
        var isError = false
    }

    var body: some View {
        if task.landing != nil || notice != nil {
            VStack(alignment: .leading, spacing: 10) {
                if let landing = task.landing {
                    header(landing)
                    files(landing)
                    buttons(landing)
                }
                if let notice {
                    Text(notice.text)
                        .font(.footnote.weight(.medium))
                        .foregroundStyle(notice.isError ? AnyShapeStyle(.red) : AnyShapeStyle(.secondary))
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .padding(14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(tint.opacity(0.12), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            .animation(.snappy, value: task.landing)
            .task(id: notice) {
                guard let notice, !notice.isError else { return }
                try? await Task.sleep(for: .seconds(6))
                if self.notice == notice { self.notice = nil }
            }
        }
    }

    private var streamName: String { task.streamName.isEmpty ? "its stream" : task.streamName }

    private var tint: Color {
        guard let landing = task.landing else { return .secondary }
        return landing.needsYou ? .orange : .blue
    }

    private func header(_ landing: TaskLanding) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Group {
                switch landing.state {
                case .landing, .fixing:
                    ProgressView().controlSize(.small)
                default:
                    LandingGlyph(landing: landing).foregroundStyle(tint)
                }
            }
            .frame(width: 20)
            VStack(alignment: .leading, spacing: 2) {
                Text(landing.label(streamName: streamName))
                    .font(.subheadline.weight(.semibold))
                if let hint = hint(landing) {
                    Text(hint)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        .accessibilityElement(children: .combine)
    }

    private func hint(_ landing: TaskLanding) -> String? {
        switch landing.state {
        case .conflict: "Ask the agent to resolve it, or resolve it on the desktop and retry."
        case .fixing: "The landing goes on once the agent has resolved it."
        case .blocked: "Commit or stash those changes in \(streamName) on the desktop, then retry."
        case .landing: landing.intent == .update ? nil : "\(task.branch ?? "The task's branch") goes into \(streamName) as one commit."
        case .unknown: nil
        }
    }

    @ViewBuilder
    private func files(_ landing: TaskLanding) -> some View {
        let shown = landing.files.prefix(4)
        if !shown.isEmpty {
            VStack(alignment: .leading, spacing: 2) {
                ForEach(Array(shown), id: \.self) { file in
                    Text(file)
                        .font(.caption.monospaced())
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
                if landing.count > shown.count {
                    Text("and \(landing.count - shown.count) more")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            .padding(.leading, 30)
        } else if landing.state == .blocked, let message = landing.message {
            Text(message)
                .font(.caption.monospaced())
                .foregroundStyle(.secondary)
                .lineLimit(4)
                .padding(.leading, 30)
        }
    }

    @ViewBuilder
    private func buttons(_ landing: TaskLanding) -> some View {
        let actions = Self.actions(landing)
        if !actions.isEmpty, model.supports(DesktopFeature.taskLand, on: ref.desktopId) {
            let disabled = model.isOffline(ref.desktopId) || running != nil
            HStack(spacing: 8) {
                ForEach(actions, id: \.self) { action in
                    button(action, primary: action == actions.first && landing.state == .conflict)
                        .disabled(disabled)
                }
            }
            .padding(.leading, 30)
        }
    }

    @ViewBuilder
    private func button(_ action: TaskLandParams.Action, primary: Bool) -> some View {
        let label = HStack(spacing: 6) {
            if running == action { ProgressView().controlSize(.mini) }
            Text(Self.title(action))
        }
        if primary {
            Button { run(action) } label: { label }
                .buttonStyle(.borderedProminent)
                .controlSize(.small)
        } else {
            Button(role: action == .abort ? .destructive : nil) { run(action) } label: { label }
                .buttonStyle(.bordered)
                .controlSize(.small)
        }
    }

    /// The desktop banner's buttons for each state, the main one first.
    static func actions(_ landing: TaskLanding) -> [TaskLandParams.Action] {
        switch landing.state {
        case .conflict: [.fixWithAgent, .retry, .abort]
        case .fixing, .blocked: [.retry, .abort]
        case .landing, .unknown: []
        }
    }

    static func title(_ action: TaskLandParams.Action) -> String {
        switch action {
        case .fixWithAgent: "Ask agent to fix"
        case .retry: "Retry"
        case .abort: "Abort"
        }
    }

    private func run(_ action: TaskLandParams.Action) {
        guard running == nil else { return }
        running = action
        notice = nil
        Task {
            defer { running = nil }
            do {
                let result = try await model.landTask(desktopId: ref.desktopId, TaskLandParams(taskId: task.id, action: action))
                if result.closed {
                    onClosed()
                    return
                }
                notice = Self.notice(result, streamName: streamName)
            } catch {
                notice = Notice(text: error.localizedDescription, isError: true)
            }
        }
    }

    /// What a result leaves to say; the banner itself shows the new state.
    static func notice(_ result: TaskLandResult, streamName: String) -> Notice? {
        switch result.status {
        case .landed: Notice(text: "Landed into \(streamName).")
        case .updated: Notice(text: "Updated from \(streamName).")
        case .nothing: Notice(text: "Nothing to land.")
        case .working: Notice(text: "The agent is working. Try again when it stops.", isError: true)
        case .conflict: Notice(text: "It still conflicts.")
        case .blocked: Notice(text: "\(streamName) still has local changes in the way.")
        case .aborted, .fixing: nil
        }
    }
}
