import DevToolKit
import SwiftUI

/// A task the user asked to close, from a swipe or the task screen.
struct CloseTaskRequest: Identifiable, Equatable {
    let desktopId: String
    let taskId: String
    let name: String
    /// The stream it is archived to (its Done list on the desktop).
    let streamName: String
    /// The task's own worktree branch: closing lands it into the stream (§8.7).
    let branch: String?

    var id: String { "\(desktopId)/\(taskId)" }

    init(desktopId: String, task: InboxTask) {
        self.desktopId = desktopId
        self.taskId = task.id
        self.name = task.name
        self.streamName = task.streamName
        self.branch = task.branch
    }
}

extension View {
    /// "Close task" (§8.3, §8.7): confirm, send `task.close`, which archives
    /// the task, and turn each blocker the desktop reports into a second
    /// confirmation that resends with the matching flag. `onClosed` runs once
    /// the task is archived. A task with its own worktree lands first; when
    /// the landing stops it stays open, and `onLanding` gets its state (a
    /// screen showing the task's banner), or, without it, an alert says why.
    func closeTaskFlow(
        _ request: Binding<CloseTaskRequest?>,
        onClosed: @escaping (CloseTaskRequest) -> Void = { _ in },
        onLanding: ((CloseTaskRequest, TaskLanding) -> Void)? = nil
    ) -> some View {
        modifier(CloseTaskFlow(request: request, onLanding: onLanding, onClosed: onClosed))
    }
}

private struct CloseTaskFlow: ViewModifier {
    @Environment(AppModel.self) private var model
    @Binding var request: CloseTaskRequest?
    let onLanding: ((CloseTaskRequest, TaskLanding) -> Void)?
    let onClosed: (CloseTaskRequest) -> Void

    /// Confirmed and in flight, or waiting on a blocker's answer.
    @State private var active: CloseTaskRequest?
    @State private var params = TaskCloseParams(taskId: "")
    @State private var blocked: TaskCloseBlocker?
    @State private var notice: Notice?
    @State private var running = false

    struct Notice: Identifiable {
        let id = UUID()
        let title: String
        let message: String
    }

    func body(content: Content) -> some View {
        content
            .confirmationDialog(
                request.map { "Close “\($0.name)”?" } ?? "",
                isPresented: Binding(get: { request != nil }, set: { if !$0 { request = nil } }),
                titleVisibility: .visible,
                presenting: request
            ) { target in
                Button("Close task", role: .destructive) {
                    start(target)
                }
                Button("Cancel", role: .cancel) {}
            } message: { target in
                let done = target.streamName.isEmpty ? "Done" : "Done in \(target.streamName)"
                if let branch = target.branch, !target.streamName.isEmpty {
                    Text("Its work on \(branch) lands in \(target.streamName) as one commit. Then its tabs close and it moves to \(done), where it can be reopened.")
                } else {
                    Text("Its tabs close on the desktop and it moves to \(done), where it can be reopened.")
                }
            }
            .confirmationDialog(
                blocked.map(Self.title) ?? "",
                isPresented: Binding(get: { blocked != nil }, set: { if !$0 { blocked = nil } }),
                titleVisibility: .visible,
                presenting: blocked
            ) { blocker in
                switch blocker {
                case .working:
                    Button("Stop it and close", role: .destructive) { resend { $0.stopWorking = true } }
                case .unsaved:
                    Button("Discard edits and close", role: .destructive) { resend { $0.discardUnsaved = true } }
                }
                Button("Cancel", role: .cancel) { active = nil }
            } message: { blocker in
                Text(Self.message(blocker))
            }
            .alert(item: $notice) { notice in
                Alert(title: Text(notice.title), message: Text(notice.message))
            }
    }

    private func start(_ target: CloseTaskRequest) {
        active = target
        params = TaskCloseParams(taskId: target.taskId)
        send()
    }

    private func send() {
        guard let target = active, !running else { return }
        running = true
        Task {
            defer { running = false }
            do {
                switch try await model.closeTask(desktopId: target.desktopId, params) {
                case .closed:
                    active = nil
                    onClosed(target)
                case .blocked(let blocker):
                    blocked = blocker
                case .landing(let landing):
                    active = nil
                    if let onLanding {
                        onLanding(target, landing)
                    } else {
                        let stream = target.streamName.isEmpty ? "its stream" : target.streamName
                        notice = Notice(title: "“\(target.name)” didn’t land",
                                        message: "\(landing.label(streamName: stream)). Open the task to sort it out; it stays open until then.")
                    }
                }
            } catch {
                active = nil
                notice = Notice(title: "Couldn't close “\(target.name)”", message: error.localizedDescription)
            }
        }
    }

    /// Resend with what the user just agreed to.
    private func resend(_ edit: (inout TaskCloseParams) -> Void) {
        edit(&params)
        blocked = nil
        send()
    }

    private static func title(_ blocker: TaskCloseBlocker) -> String {
        switch blocker {
        case .working: "Still working"
        case .unsaved: "Unsaved edits"
        }
    }

    private static func message(_ blocker: TaskCloseBlocker) -> String {
        switch blocker {
        case .working: "The agent in this task is still working. Closing stops it."
        case .unsaved: "An editor in this task has unsaved changes on the desktop. They will be lost."
        }
    }
}
