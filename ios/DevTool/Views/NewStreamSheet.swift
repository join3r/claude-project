import DevToolKit
import SwiftUI

/// What the project screen's + opens the New stream sheet with.
struct NewStreamTarget: Identifiable, Hashable {
    let desktopId: String
    let projectId: String

    var id: String { "\(desktopId)/\(projectId)" }
}

/// "New stream" (§8.12): a name, and whether it works in a new worktree or
/// the project folder. The desktop names the branch after the stream and forks
/// it from its default base. The stream shows up with the next inbox.
struct NewStreamSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let target: NewStreamTarget

    @State private var name = ""
    @State private var worktree = true
    @State private var sending = false
    @State private var error: String?
    @FocusState private var focused: Bool

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Name", text: $name)
                        .focused($focused)
                        .disabled(sending)
                }
                Section {
                    Picker("Works in", selection: $worktree) {
                        Text("New worktree").tag(true)
                        Text("Project folder").tag(false)
                    }
                    .pickerStyle(.inline)
                    .labelsHidden()
                    .disabled(sending)
                } header: {
                    Text("Works in")
                } footer: {
                    Text(worktree
                         ? "A new branch named after the stream, from the project's default branch."
                         : "Shares the project folder with main.")
                }
                if let error {
                    Section {
                        Text(error).foregroundStyle(.red)
                    }
                }
            }
            .navigationTitle(projectName.map { "New stream in \($0)" } ?? "New stream")
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
                        Button("Create") { Task { await create() } }
                            .disabled(trimmed.isEmpty || model.isOffline(target.desktopId))
                    }
                }
            }
            .interactiveDismissDisabled(sending)
            .onAppear { focused = true }
        }
    }

    private var trimmed: String { name.trimmingCharacters(in: .whitespacesAndNewlines) }

    private var projectName: String? {
        model.inboxes[target.desktopId]?.projects.first { $0.id == target.projectId }?.name
    }

    private func create() async {
        guard !sending, !trimmed.isEmpty else { return }
        sending = true
        error = nil
        do {
            _ = try await model.newStream(desktopId: target.desktopId, projectId: target.projectId, name: trimmed,
                                          worktree: worktree, branch: nil, baseBranch: nil)
            dismiss()
        } catch {
            self.error = error.localizedDescription
            sending = false
        }
    }
}
