import DevToolKit
import SwiftUI

/// What the project screen's + opens the New stream sheet with.
struct NewStreamTarget: Identifiable, Hashable {
    let desktopId: String
    let projectId: String

    var id: String { "\(desktopId)/\(projectId)" }
}

/// "New stream" (§8.3, §8.12), as the desktop's New stream dialog: a name
/// (prefilled with the next version after the project's last stream), and
/// where it works: a new worktree on a branch (following the name until
/// edited) forked from a base branch (`branches.list`, §8.13), or the project
/// folder. The stream shows up with the next inbox.
struct NewStreamSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let target: NewStreamTarget
    /// The new stream's ID, once the desktop made it.
    var onCreated: (String) -> Void = { _ in }

    private enum Branches: Equatable {
        case loading
        case loaded([String])
        /// No worktrees for this project or desktop; the reason.
        case unsupported(String)
        case failed(String)
    }

    @State private var name: String
    @State private var suggestions: [String]
    @State private var worktree = true
    /// nil while the branch follows the name.
    @State private var editedBranch: String?
    @State private var branches: Branches = .loading
    @State private var baseBranch = ""
    @State private var sending = false
    @State private var error: String?
    @FocusState private var focused: Bool

    init(target: NewStreamTarget, streams: [InboxStream], onCreated: @escaping (String) -> Void = { _ in }) {
        self.target = target
        self.onCreated = onCreated
        let suggestion = StreamNaming.suggestion(after: streams)
        _name = State(initialValue: suggestion.name)
        _suggestions = State(initialValue: [suggestion.name, suggestion.minor].compactMap { $0 }.filter { !$0.isEmpty })
    }

    var body: some View {
        NavigationStack {
            Form {
                nameSection
                placeSection
                if worktreeChosen {
                    branchSection
                }
                if let error {
                    Section {
                        Text(error).foregroundStyle(.red)
                    }
                }
            }
            .navigationTitle("New stream")
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
                            .disabled(!valid || model.isOffline(target.desktopId))
                    }
                }
            }
            .interactiveDismissDisabled(sending)
            .onAppear { focused = name.isEmpty }
            .task { await loadBranches() }
        }
    }

    // MARK: Sections

    private var nameSection: some View {
        Section {
            LabeledContent("Name") {
                TextField("0.5.0, bugfixes, …", text: $name)
                    .focused($focused)
                    .autocorrectionDisabled()
                    .textInputAutocapitalization(.never)
                    .submitLabel(.done)
                    .onSubmit { Task { await create() } }
                    .disabled(sending)
            }
        } header: {
            Text(projectName.map { "In \($0)" } ?? "Name")
        } footer: {
            if !suggestions.isEmpty {
                HStack(spacing: 8) {
                    ForEach(suggestions, id: \.self) { suggestion in
                        Button(suggestion) { name = suggestion }
                            .buttonStyle(SuggestionChipStyle(selected: name == suggestion))
                            .disabled(sending)
                            .accessibilityLabel("Name it \(suggestion)")
                    }
                }
                .padding(.top, 4)
            }
        }
    }

    private var placeSection: some View {
        Section {
            Picker("Works in", selection: $worktree) {
                Text("New worktree").tag(true)
                Text("Project folder").tag(false)
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .disabled(!worktreeSupported || sending)
            .listRowBackground(Color.clear)
            .listRowInsets(EdgeInsets())
        } header: {
            Text("Works in")
        } footer: {
            if case .unsupported(let reason) = branches {
                Text(reason)
            } else if !worktree {
                Text("The stream works in the project folder, like main.")
            }
        }
    }

    private var branchSection: some View {
        Section {
            LabeledContent("Branch") {
                TextField("Branch", text: branchBinding)
                    .font(.body.monospaced())
                    .foregroundStyle(.secondary)
                    .autocorrectionDisabled()
                    .textInputAutocapitalization(.never)
                    .disabled(sending)
            }
            switch branches {
            case .loading:
                LabeledContent("From") { ProgressView() }
            case .loaded(let list) where list.isEmpty:
                LabeledContent("From", value: "no branch")
            case .loaded(let list):
                Picker("From", selection: $baseBranch) {
                    ForEach(list, id: \.self) { branch in
                        Text(branch).font(.body.monospaced()).tag(branch)
                    }
                }
                .pickerStyle(.menu)
                .disabled(sending)
            case .failed:
                LabeledContent("From") {
                    Button("Retry") { Task { await loadBranches() } }
                }
            case .unsupported:
                EmptyView()
            }
        } footer: {
            Text(branchFooter)
        }
    }

    /// The desktop dialog's helper line.
    private var branchFooter: String {
        if sending { return "Creating worktree \(branchName.trimmed)…" }
        switch branches {
        case .failed(let message): return message
        case .loaded(let list) where list.isEmpty:
            return "No branch to fork a worktree from. Is this a git repository with a commit?"
        default:
            return "The stream gets its own worktree on a new branch. Renaming the stream later keeps the branch."
        }
    }

    // MARK: State

    private var projectName: String? {
        model.inboxes[target.desktopId]?.projects.first { $0.id == target.projectId }?.name
    }

    private var worktreeSupported: Bool {
        if case .unsupported = branches { return false }
        return true
    }

    private var worktreeChosen: Bool { worktree && worktreeSupported }

    private var branchName: String { editedBranch ?? StreamNaming.branchSlug(name) }

    private var branchBinding: Binding<String> {
        Binding(get: { branchName }, set: { editedBranch = $0 })
    }

    private var valid: Bool {
        guard !name.trimmed.isEmpty else { return false }
        guard worktreeChosen else { return true }
        guard case .loaded = branches else { return false }
        return !branchName.trimmed.isEmpty && !baseBranch.isEmpty
    }

    private func loadBranches() async {
        guard model.supports(DesktopFeature.branchesList, on: target.desktopId) else {
            branches = .unsupported("This desktop can't make worktrees from the phone. Update DevTool on it.")
            worktree = false
            return
        }
        branches = .loading
        do {
            let result = try await model.listBranches(desktopId: target.desktopId, projectId: target.projectId)
            branches = .loaded(result.branches)
            if baseBranch.isEmpty || !result.branches.contains(baseBranch) {
                baseBranch = result.branches.contains(result.defaultBase)
                    ? result.defaultBase : StreamNaming.defaultBaseBranch(result.branches)
            }
        } catch DesktopConnectionError.remote(AppErrorCode.unsupported, let message) {
            // A shell-command project: no folder to make a worktree in.
            branches = .unsupported(message.isEmpty ? "Custom shell projects have no folder to make a worktree in." : message)
            worktree = false
        } catch {
            branches = .failed(error.localizedDescription)
        }
    }

    private func create() async {
        guard !sending, valid else { return }
        sending = true
        error = nil
        let worktree = worktreeChosen
        do {
            let streamId = try await model.newStream(
                desktopId: target.desktopId, projectId: target.projectId, name: name.trimmed, worktree: worktree,
                branch: worktree ? branchName.trimmed : nil, baseBranch: worktree ? baseBranch : nil
            )
            onCreated(streamId)
            dismiss()
        } catch {
            self.error = error.localizedDescription
            sending = false
        }
    }
}

/// A rounded suggestion under a field, filled when it is the field's value.
private struct SuggestionChipStyle: ButtonStyle {
    let selected: Bool
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.subheadline.monospacedDigit())
            .foregroundStyle(selected ? Color.accentColor : Color.primary)
            .padding(.horizontal, 12)
            .frame(height: 30)
            .background(Capsule().fill(Color(.secondarySystemGroupedBackground)))
            .overlay(Capsule().strokeBorder(selected ? Color.accentColor : Color(.separator), lineWidth: 1))
            .opacity(configuration.isPressed ? 0.6 : isEnabled ? 1 : 0.5)
            .textCase(nil)
    }
}

private extension String {
    var trimmed: String { trimmingCharacters(in: .whitespacesAndNewlines) }
}
