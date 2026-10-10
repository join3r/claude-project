import DevToolKit
import SwiftUI

/// What the queue sheet opens on: a new prompt for a project (optionally
/// for one stream), or one already queued.
struct QueuePromptTarget: Identifiable, Hashable {
    let desktopId: String
    let projectId: String
    /// The prompt to edit; nil adds one.
    var item: InboxQueuedPrompt?
    /// Add only: the stream picked up front.
    var streamId: String?

    var id: String { "\(desktopId)/\(projectId)/\(item?.id ?? "new")/\(streamId ?? "")" }
}

/// Add to queue and Edit (§8.3, §8.16): the prompt and, when adding to a
/// project with more than one stream, the stream it will run in. Editing also
/// offers Run now and Remove. The desktop answers each change; the queue
/// itself comes back with the next inbox.
struct QueueSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let target: QueuePromptTarget

    @State private var text: String
    @State private var streamId: String?
    @State private var sending = false
    @State private var error: String?
    @State private var focused = false

    init(target: QueuePromptTarget) {
        self.target = target
        _text = State(initialValue: target.item?.text ?? "")
        _streamId = State(initialValue: target.item?.streamId ?? target.streamId)
    }

    var body: some View {
        NavigationStack {
            Form {
                if let project {
                    Section {
                        LabeledContent("Project") { ProjectNameLabel(project: project) }
                        if target.item == nil, project.streams.count > 1 {
                            Picker("Stream", selection: $streamId) {
                                ForEach(project.streams) { stream in
                                    StreamLabel(stream: stream).tag(Optional(stream.id))
                                }
                            }
                            .pickerStyle(.navigationLink)
                            .disabled(sending)
                        } else if let stream {
                            LabeledContent("Stream") { StreamLabel(stream: stream) }
                        }
                    } footer: {
                        if offline {
                            Text("\(model.desktop(target.desktopId)?.name ?? "This desktop") is offline.")
                        }
                    }
                }
                Section {
                    PromptTextView(text: $text, focused: $focused, placeholder: "What should Claude work on?",
                                   disabled: sending, onPasteImages: nil)
                } header: {
                    Text("Prompt")
                } footer: {
                    Text("It becomes a new Claude chat task in its stream when it runs.")
                }
                if target.item != nil, gone {
                    Section {
                        Text("This prompt is no longer queued. It may have started or been removed on the desktop.")
                            .foregroundStyle(.secondary)
                    }
                } else if let item = target.item {
                    Section {
                        Button("Run now", systemImage: "play.fill") { Task { await runNow(item) } }
                            .disabled(sending || offline || tooLong || trimmed.isEmpty)
                        Button("Remove from queue", systemImage: "trash", role: .destructive) { Task { await remove(item) } }
                            .disabled(sending || offline)
                    } footer: {
                        Text("Run now starts it as a task right away, whether or not its stream runs the queue automatically.")
                    }
                }
                if let error {
                    Section {
                        Text(error).foregroundStyle(.red)
                    }
                }
            }
            .navigationTitle(target.item == nil ? "Add to queue" : "Queued prompt")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                        .disabled(sending)
                }
                ToolbarItem(placement: .confirmationAction) {
                    if sending {
                        ProgressView()
                    } else {
                        Button(target.item == nil ? "Add" : "Save") { Task { await save() } }
                            .disabled(trimmed.isEmpty || tooLong || offline || (target.item != nil && (!changed || gone)))
                    }
                }
            }
            .interactiveDismissDisabled(sending)
            .onAppear {
                if streamId == nil { streamId = project?.mainStream?.id }
                focused = target.item == nil
            }
        }
    }

    private var project: InboxProject? {
        model.inboxes[target.desktopId]?.projects.first { $0.id == target.projectId }
    }

    private var stream: InboxStream? {
        project?.streams.first { $0.id == streamId }
    }

    /// The prompt left the queue meanwhile (it ran, or the desktop removed it).
    private var gone: Bool {
        guard let item = target.item, let project else { return false }
        return !project.queue.contains { $0.id == item.id }
    }

    private var trimmed: String { text.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var tooLong: Bool { trimmed.utf16.count > QueueUpdateParams.textLimit }
    private var changed: Bool { trimmed != target.item?.text }
    private var offline: Bool { model.isOffline(target.desktopId) }

    private func save() async {
        let action: QueueUpdateParams.Action
        if let item = target.item {
            action = .edit(itemId: item.id, text: trimmed)
        } else {
            // A stream that has gone since the picker was filled: `main`.
            action = .add(text: trimmed, streamId: stream?.isMain == false ? stream?.id : nil)
        }
        await send { try await model.updateQueue(action, projectId: target.projectId, desktopId: target.desktopId) }
    }

    private func runNow(_ item: InboxQueuedPrompt) async {
        await send {
            if changed { try await model.updateQueue(.edit(itemId: item.id, text: trimmed), projectId: target.projectId, desktopId: target.desktopId) }
            guard let connection = model.connection(for: target.desktopId) else { throw DesktopConnectionError.notConnected }
            try await connection.runQueued(projectId: target.projectId, itemId: item.id)
        }
    }

    private func remove(_ item: InboxQueuedPrompt) async {
        await send { try await model.updateQueue(.remove(itemId: item.id), projectId: target.projectId, desktopId: target.desktopId) }
    }

    /// Runs one request with the sheet locked, and closes it once the desktop says yes.
    private func send(_ work: () async throws -> Void) async {
        guard !sending else { return }
        sending = true
        error = nil
        do {
            try await work()
            dismiss()
        } catch {
            self.error = error.localizedDescription
            sending = false
        }
    }
}
