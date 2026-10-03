import DevToolKit
import SwiftUI

/// The project a "New task" sheet starts a task in.
struct NewTaskTarget: Identifiable, Hashable {
    let desktopId: String
    let project: InboxProject

    var id: String { "\(desktopId)/\(project.id)" }

    static func == (a: NewTaskTarget, b: NewTaskTarget) -> Bool { a.id == b.id }
    func hash(into hasher: inout Hasher) { hasher.combine(id) }
}

/// "New task" (§8.3, §8.4): the first prompt and a permission mode. The desktop
/// names the task after the prompt and starts Claude on it; the chat opens as
/// soon as the task shows up in the inbox.
struct NewTaskSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let target: NewTaskTarget

    @State private var prompt = ""
    /// "" leaves Claude's own default mode.
    @State private var mode = ""
    @State private var sending = false
    @State private var error: String?
    @FocusState private var focused: Bool

    /// The desktop's labels for `TaskOp.modes`.
    private static let modeLabels: [String: String] = [
        "default": "Ask", "acceptEdits": "Accept edits", "plan": "Plan", "auto": "Auto", "bypassPermissions": "Bypass",
    ]

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("What should Claude work on?", text: $prompt, axis: .vertical)
                        .lineLimit(4...12)
                        .focused($focused)
                        .disabled(sending)
                } header: {
                    ProjectHeader(project: target.project, desktopName: nil)
                } footer: {
                    Text("The task is named after the prompt's first line.")
                }
                Section {
                    Picker("Mode", selection: $mode) {
                        Text("Default").tag("")
                        ForEach(TaskOp.modes, id: \.self) { value in
                            Text(Self.modeLabels[value] ?? value).tag(value)
                        }
                    }
                    .disabled(sending)
                }
                if let error {
                    Section {
                        Text(error).foregroundStyle(.red)
                    }
                }
            }
            .navigationTitle("New task")
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
                        Button("Start") { Task { await start() } }
                            .disabled(trimmed.isEmpty || offline)
                    }
                }
            }
            .interactiveDismissDisabled(sending)
            .onAppear { focused = true }
        }
    }

    private var trimmed: String { prompt.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var offline: Bool { model.isOffline(target.desktopId) }

    private func start() async {
        guard !sending, !trimmed.isEmpty else { return }
        sending = true
        error = nil
        do {
            let route = try await model.newTask(
                desktopId: target.desktopId, projectId: target.project.id, prompt: trimmed, mode: mode.isEmpty ? nil : mode
            )
            dismiss()
            // RootView waits for the task to appear in the inbox, then pushes the chat.
            model.requestedChat = route
        } catch {
            self.error = error.localizedDescription
            sending = false
        }
    }
}
