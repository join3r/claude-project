import Foundation

/// Project Home's prompt queue on the phone (§4.4 `queue`, §8.16): how the
/// project screen groups it, and the edits it shows before the desktop's next
/// inbox confirms them.
extension InboxProject {
    /// The streams the Queue section shows, each with its prompts in queue
    /// order. With one stream, that stream; with more, those with prompts or
    /// with auto-run on, as the desktop's Project Home groups them.
    public var queueGroups: [(stream: InboxStream, prompts: [InboxQueuedPrompt])] {
        let groups = streams.map { (stream: $0, prompts: queue(in: $0)) }
        if streams.count <= 1 { return groups }
        return groups.filter { !$0.prompts.isEmpty || $0.stream.queueAutoRun }
    }

    /// The task an auto-run stream waits for before it starts its next prompt.
    public func queueWaitingTask(in stream: InboxStream) -> InboxTask? {
        guard stream.queueAutoRun, let id = stream.queueTaskId else { return nil }
        return tasks.first { $0.id == id }
    }

    /// The `move` that swaps `item` with its stream's previous (`up`) or next
    /// prompt, as a position in the whole queue; nil at that end.
    public func queueMove(_ item: InboxQueuedPrompt, up: Bool) -> QueueUpdateParams.Action? {
        let mine = queue(in: InboxStream(id: item.streamId, name: ""))
        guard let at = mine.firstIndex(where: { $0.id == item.id }) else { return nil }
        let neighbour = up ? at - 1 : at + 1
        guard mine.indices.contains(neighbour),
              let toIndex = queue.firstIndex(where: { $0.id == mine[neighbour].id }) else { return nil }
        return .move(itemId: item.id, toIndex: Int64(toIndex))
    }

    /// The project with `action` applied as the desktop applies it
    /// (`applyPromptQueueOp`). `add` needs the desktop's id, so it changes nothing.
    public func applying(_ action: QueueUpdateParams.Action) -> InboxProject {
        var next = self
        switch action {
        case .add:
            break
        case .edit(let itemId, let text):
            if let i = next.queue.firstIndex(where: { $0.id == itemId }) { next.queue[i].text = text }
        case .remove(let itemId):
            next.queue.removeAll { $0.id == itemId }
        case .move(let itemId, let toIndex):
            guard let from = next.queue.firstIndex(where: { $0.id == itemId }) else { break }
            let to = max(0, min(Int(clamping: toIndex), next.queue.count - 1))
            let item = next.queue.remove(at: from)
            next.queue.insert(item, at: to)
        case .autoRun(let streamId, let on):
            guard let i = next.streams.firstIndex(where: { $0.id == streamId }) else { break }
            next.streams[i].queueAutoRun = on
            // Off means "stop after this one": nothing is waited on any more.
            if !on { next.streams[i].queueTaskId = nil }
        }
        return next
    }
}
