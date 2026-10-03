import DevToolKit
import SwiftUI

/// A task the user asked to close, from a swipe or the task screen.
struct CloseTaskRequest: Identifiable, Equatable {
    let desktopId: String
    let taskId: String
    let name: String
    /// Set for a workspace task (§4.4).
    let branch: String?

    var id: String { "\(desktopId)/\(taskId)" }

    init(desktopId: String, task: InboxTask) {
        self.desktopId = desktopId
        self.taskId = task.id
        self.name = task.name
        self.branch = task.branch
    }

    var actionTitle: String { branch == nil ? "Close task" : "Close workspace" }
}

extension View {
    /// "Close task" / "Close workspace" (§8.3, §8.7): confirm, send `task.close`,
    /// and turn each blocker the desktop reports into a second confirmation that
    /// resends with the matching `discard*` flag. `onClosed` runs once the task is gone.
    func closeTaskFlow(_ request: Binding<CloseTaskRequest?>, onClosed: @escaping (CloseTaskRequest) -> Void = { _ in }) -> some View {
        modifier(CloseTaskFlow(request: request, onClosed: onClosed))
    }
}

private struct CloseTaskFlow: ViewModifier {
    @Environment(AppModel.self) private var model
    @Binding var request: CloseTaskRequest?
    let onClosed: (CloseTaskRequest) -> Void

    /// Confirmed and in flight, or waiting on a blocker's answer.
    @State private var active: CloseTaskRequest?
    @State private var params = TaskCloseParams(taskId: "")
    @State private var blocked: Blocked?
    @State private var notice: Notice?
    @State private var running = false

    struct Blocked: Equatable {
        let blocker: TaskCloseBlocker
        let branch: String?
        let baseBranch: String?
        let message: String?
    }

    struct Notice: Identifiable {
        let id = UUID()
        let title: String
        let message: String
    }

    func body(content: Content) -> some View {
        content
            .confirmationDialog(
                request.map { "\($0.actionTitle) “\($0.name)”?" } ?? "",
                isPresented: Binding(get: { request != nil }, set: { if !$0 { request = nil } }),
                titleVisibility: .visible,
                presenting: request
            ) { target in
                Button(target.actionTitle, role: .destructive) {
                    start(target)
                }
                Button("Cancel", role: .cancel) {}
            } message: { target in
                if let branch = target.branch {
                    Text("Its tabs close on the desktop, and the worktree of branch “\(branch)” is removed from disk.")
                } else {
                    Text("Its tabs close on the desktop.")
                }
            }
            .confirmationDialog(
                blockedTitle,
                isPresented: Binding(get: { blocked != nil }, set: { if !$0 { blocked = nil } }),
                titleVisibility: .visible,
                presenting: blocked
            ) { block in
                blockedButtons(block)
            } message: { block in
                Text(blockedMessage(block))
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
                case .closed(let warning):
                    active = nil
                    onClosed(target)
                    if let warning {
                        notice = Notice(title: target.branch == nil ? "Task closed" : "Workspace closed", message: warning)
                    }
                case .blocked(let blocker, let branch, let baseBranch, let message):
                    blocked = Blocked(blocker: blocker, branch: branch ?? target.branch, baseBranch: baseBranch, message: message)
                }
            } catch {
                active = nil
                notice = Notice(title: "Couldn't close “\(target.name)”", message: error.localizedDescription)
            }
        }
    }

    /// Resend with what the user just agreed to lose.
    private func resend(_ edit: (inout TaskCloseParams) -> Void) {
        edit(&params)
        blocked = nil
        send()
    }

    @ViewBuilder
    private func blockedButtons(_ block: Blocked) -> some View {
        switch block.blocker {
        case .unsaved:
            Button("Discard edits and close", role: .destructive) { resend { $0.discardUnsaved = true } }
        case .uncommitted:
            Button("Close anyway", role: .destructive) { resend { $0.discardWorkspace = true } }
        case .unmerged, .uncommittedAndUnmerged, .checkFailed:
            Button("Close, keep branch", role: .destructive) { resend { $0.discardWorkspace = true; $0.keepBranch = true } }
            Button("Close and delete branch", role: .destructive) { resend { $0.discardWorkspace = true; $0.keepBranch = false } }
        }
        Button("Cancel", role: .cancel) { active = nil }
    }

    private var blockedTitle: String {
        switch blocked?.blocker {
        case .unsaved: "Unsaved edits"
        case .uncommitted: "Uncommitted changes"
        case .unmerged: "Branch not merged"
        case .uncommittedAndUnmerged: "Uncommitted and unmerged"
        case .checkFailed: "Couldn't check the workspace"
        case nil: ""
        }
    }

    private func blockedMessage(_ block: Blocked) -> String {
        let branch = block.branch.map { "“\($0)”" } ?? "this workspace's branch"
        let base = block.baseBranch.map { "“\($0)”" } ?? "its base branch"
        switch block.blocker {
        case .unsaved:
            return "An editor in this task has unsaved changes on the desktop. They will be lost."
        case .uncommitted:
            return "The worktree has uncommitted changes. They will be lost."
        case .unmerged:
            return "Branch \(branch) isn't merged into \(base). Keep the branch to come back to it later."
        case .uncommittedAndUnmerged:
            return "The worktree has uncommitted changes, which will be lost, and branch \(branch) isn't merged into \(base)."
        case .checkFailed:
            let reason = block.message.map { "\n\n\($0)" } ?? ""
            return "DevTool couldn't check whether \(branch) is safe to delete. Uncommitted or unmerged work may be lost.\(reason)"
        }
    }
}
