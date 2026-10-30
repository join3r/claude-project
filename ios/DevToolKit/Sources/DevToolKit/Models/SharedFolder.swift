import Foundation

/// New task's same-folder warning, as the desktop's (`busyInSameFolder`):
/// another task's agent already working in the folder a new task would start in.
extension InboxProject {
    /// Whether a new task in `stream` gets a worktree of its own: a worktree
    /// stream (`branch`) in a project that isn't over SSH (§11).
    public func startsInOwnWorktree(_ stream: InboxStream?) -> Bool {
        stream?.branch != nil && !remote
    }

    /// The working tasks in the folder a new task in `stream` (nil: `main`)
    /// would start in: the stream's worktree, which its tasks without a
    /// `branch` share, or the project folder, shared by every task without a
    /// `branch` in a stream without one. Empty when the task gets its own worktree.
    public func busyInSameFolder(_ stream: InboxStream?) -> [InboxTask] {
        let target = stream ?? mainStream
        if startsInOwnWorktree(target) { return [] }
        let worktreeStreams = Set(streams.filter { $0.branch != nil }.map(\.id))
        return tasks.filter { task in
            guard task.status == .working, task.branch == nil else { return false }
            if let target, target.branch != nil { return task.streamId == target.id }
            return !worktreeStreams.contains(task.streamId)
        }
    }

    /// The warning's line: who works where, and what to do about it.
    public func sameFolderWarning(_ stream: InboxStream?, busy: [InboxTask]) -> String {
        let target = stream ?? mainStream
        let place = target?.branch != nil ? "the \(target?.name ?? "stream") worktree" : "the project folder"
        let who = busy.count == 1 ? "“\(busy[0].name)” is" : "\(busy.count) agents are"
        return "\(who) already working in \(place). Two agents there edit the same files; a new stream gives this one its own worktree."
    }
}
