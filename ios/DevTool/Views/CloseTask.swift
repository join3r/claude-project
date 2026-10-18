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
    /// Remove task (the desktop Inbox's ✕): a task with a worktree of its own
    /// closes without landing, its branch and uncommitted work deleted.
    let remove: Bool

    var id: String { "\(desktopId)/\(taskId)" }

    init(desktopId: String, task: InboxTask, remove: Bool = false) {
        self.desktopId = desktopId
        self.taskId = task.id
        self.name = task.name
        self.streamName = task.streamName
        self.branch = task.branch
        self.remove = remove
    }
}

extension View {
    /// "Close task" (§8.3, §8.7): send `task.close`, which archives the task,
    /// asking what the desktop asks. For a desktop that lists
    /// `task.close.choice` that is nothing for a quiet task, the working
    /// blocker for a busy one, and for a task with its own worktree the
    /// desktop's close question: Land & close, Keep branch or Discard. An
    /// older desktop gets a confirmation first, then lands. Each blocker
    /// becomes a confirmation that resends with the matching flag. `onClosed`
    /// runs once the task is archived. When a landing stops the task stays
    /// open, and `onLanding` gets its state (a screen showing the task's
    /// banner), or, without it, an alert says why.
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
    @State private var question: TaskCloseQuestion?
    @State private var notice: Notice?
    @State private var running = false

    struct Notice: Identifiable {
        let id = UUID()
        let title: String
        let message: String
    }

    func body(content: Content) -> some View {
        content
            .onChange(of: request) { _, target in
                // What the desktop closes without a word goes straight out.
                guard let target, !needsConfirmation(target) else { return }
                request = nil
                start(target, TaskCloseParams(taskId: target.taskId, ask: true))
            }
            .confirmationDialog(
                request.map { $0.remove ? "Remove “\($0.name)”?" : "Close “\($0.name)”?" } ?? "",
                isPresented: Binding(get: { request.map(needsConfirmation) ?? false }, set: { if !$0 { request = nil } }),
                titleVisibility: .visible,
                presenting: request
            ) { target in
                if target.remove {
                    Button("Remove task", role: .destructive) {
                        start(target, TaskCloseParams(taskId: target.taskId, stopWorking: true, discardUnsaved: true, mode: .discard))
                    }
                } else {
                    Button("Close task", role: .destructive) {
                        start(target, TaskCloseParams(taskId: target.taskId))
                    }
                }
                Button("Cancel", role: .cancel) {}
            } message: { target in
                if target.remove {
                    let branch = target.branch.map { " and branch “\($0)”" } ?? ""
                    Text("Its worktree\(branch) are deleted, uncommitted work with them. Nothing is landed.")
                } else {
                    let done = target.streamName.isEmpty ? "Done" : "Done in \(target.streamName)"
                    if let branch = target.branch, !target.streamName.isEmpty {
                        Text("Its work on \(branch) lands in \(target.streamName) as one commit. Then its tabs close and it moves to \(done), where it can be reopened.")
                    } else {
                        Text("Its tabs close on the desktop and it moves to \(done), where it can be reopened.")
                    }
                }
            }
            .confirmationDialog(
                active.map { "Close task “\($0.name)”?" } ?? "",
                isPresented: Binding(get: { question != nil }, set: { if !$0 { question = nil } }),
                titleVisibility: .visible,
                presenting: question
            ) { question in
                if question.landBlocked == nil {
                    Button("Land & close") { answer(.land) }
                }
                Button("Keep branch") { answer(.keep) }
                Button("Discard", role: .destructive) { answer(.discard) }
                Button("Cancel", role: .cancel) { active = nil }
            } message: { question in
                Text(Self.message(question, branch: active?.branch))
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

    /// An older desktop lands without asking, so the phone asks first; Remove
    /// of a task with its own worktree deletes work, so it always asks.
    private func needsConfirmation(_ target: CloseTaskRequest) -> Bool {
        if target.remove && target.branch != nil { return true }
        return !model.supports(DesktopFeature.taskCloseChoice, on: target.desktopId)
    }

    private func start(_ target: CloseTaskRequest, _ first: TaskCloseParams) {
        active = target
        params = first
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
                case .question(let next):
                    question = next
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

    /// The close question's answer. Keep branch and Discard stop a working agent themselves.
    private func answer(_ mode: TaskCloseParams.Mode) {
        question = nil
        params.mode = mode
        send()
    }

    /// Resend with what the user just agreed to.
    private func resend(_ edit: (inout TaskCloseParams) -> Void) {
        edit(&params)
        blocked = nil
        send()
    }

    /// The desktop dialog's text, its reason when Land & close is out, and what the other two do.
    private static func message(_ question: TaskCloseQuestion, branch: String?) -> String {
        var lines = [question.message]
        if let landBlocked = question.landBlocked {
            lines.append("Land & close isn’t available: \(landBlocked.prefix(1).lowercased() + landBlocked.dropFirst()).")
        }
        let kept = branch.map { "leaves \($0) in the repository" } ?? "keeps its branch"
        lines.append("Keep branch commits what is uncommitted and \(kept), without landing it. Discard deletes the branch and the uncommitted work.")
        return lines.joined(separator: "\n\n")
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
