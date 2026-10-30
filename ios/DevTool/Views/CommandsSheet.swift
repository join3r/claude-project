import DevToolKit
import SwiftUI

/// Whose commands the Commands sheet edits: the project's own (`streamId`
/// nil, what every stream runs) or a stream's own.
struct CommandsTarget: Identifiable, Hashable {
    let desktopId: String
    let projectId: String
    let streamId: String?

    var id: String { "\(desktopId)/\(projectId)/\(streamId ?? "")" }

    /// `main`'s commands are the project's; any other stream's are its own.
    static func of(_ stream: InboxStream, desktopId: String, projectId: String) -> CommandsTarget {
        CommandsTarget(desktopId: desktopId, projectId: projectId, streamId: stream.isMain ? nil : stream.id)
    }
}

/// Commands… (§8.3, §8.21): the project's or a stream's named commands, as the
/// desktop's Project settings and stream Commands… edit them. A stream shows
/// the project's commands it gets above its own. Suggest with Claude fills the
/// rows for the user to check; nothing is saved until Save.
struct CommandsSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let target: CommandsTarget

    private enum SuggestState: Equatable {
        case idle
        case busy
        case done(count: Int)
        case failed(String)
    }

    @State private var rows: [RunCommandDraft] = []
    @State private var saved: [StreamCommandEntry] = []
    @State private var inherited: [InboxRunCommand] = []
    @State private var loaded = false
    @State private var loadError: String?
    @State private var saving = false
    @State private var saveError: String?
    @State private var suggest: SuggestState = .idle
    /// Rows Suggest set or added, highlighted until saved.
    @State private var marked: Set<String> = []
    /// The project's own Commands, opened from a stream's inherited list.
    @State private var projectTarget: CommandsTarget?
    @FocusState private var focused: String?

    var body: some View {
        NavigationStack {
            Form {
                placeSection
                if !loaded {
                    Section {
                        if let loadError {
                            Text(loadError).foregroundStyle(.red)
                            Button("Try again", systemImage: "arrow.clockwise") { Task { await load() } }
                                .disabled(offline)
                        } else {
                            HStack(spacing: 10) {
                                ProgressView()
                                Text("Loading commands…").foregroundStyle(.secondary)
                            }
                        }
                    }
                } else {
                    if !inherited.isEmpty { inheritedSection }
                    commandsSection
                    if canSuggest { suggestSection }
                    if let saveError {
                        Section {
                            Text(saveError).foregroundStyle(.red)
                        }
                    }
                }
            }
            .navigationTitle("Commands")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                        .disabled(saving)
                }
                ToolbarItem(placement: .confirmationAction) {
                    if saving {
                        ProgressView()
                    } else {
                        Button("Save") { Task { await save() } }
                            .disabled(!loaded || offline || problem != nil || !changed)
                    }
                }
            }
            .interactiveDismissDisabled(saving || (loaded && changed))
            .task { await load() }
            .sheet(item: $projectTarget, onDismiss: { Task { await reloadInherited() } }) { CommandsSheet(target: $0) }
        }
    }

    // MARK: Sections

    private var placeSection: some View {
        Section {
            if let project {
                LabeledContent("Project") { ProjectNameLabel(project: project) }
            }
            if let stream {
                LabeledContent("Stream") { StreamLabel(stream: stream) }
            }
        } footer: {
            if offline {
                Text("\(model.desktop(target.desktopId)?.name ?? "This desktop") is offline.")
            } else if target.streamId == nil {
                Text("Every stream runs these, in its own folder or a task’s worktree.")
            }
        }
    }

    private var inheritedSection: some View {
        Section {
            ForEach(inherited) { command in
                VStack(alignment: .leading, spacing: 2) {
                    Text(command.name)
                        .font(.subheadline.weight(.semibold))
                    Text(command.command)
                        .font(.footnote.monospaced())
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                        .truncationMode(.middle)
                }
                .accessibilityElement(children: .combine)
            }
            Button("Edit project commands", systemImage: "pencil") {
                projectTarget = CommandsTarget(desktopId: target.desktopId, projectId: target.projectId, streamId: nil)
            }
            .disabled(locked)
        } header: {
            Text("From the project")
        } footer: {
            Text("This stream runs these too. Give one of yours the same name to replace it here.")
        }
    }

    private var commandsSection: some View {
        Section {
            ForEach($rows) { $row in
                CommandRowEditor(row: $row, namePlaceholder: inherited.first?.name ?? "run", focused: $focused)
                    .disabled(locked)
                    .listRowBackground(marked.contains(row.key) ? Color.accentColor.opacity(0.12) : nil)
                    .contextMenu {
                        Button("Move up", systemImage: "arrow.up") { move(row.key, by: -1) }
                            .disabled(rows.first?.key == row.key)
                        Button("Move down", systemImage: "arrow.down") { move(row.key, by: 1) }
                            .disabled(rows.last?.key == row.key)
                        Button("Delete", systemImage: "trash", role: .destructive) { rows.removeAll { $0.key == row.key } }
                    }
            }
            .onDelete { rows.remove(atOffsets: $0) }
            .onMove { rows.move(fromOffsets: $0, toOffset: $1) }
            .deleteDisabled(locked)
            .moveDisabled(locked)
            Button("Add command", systemImage: "plus") {
                let row = RunCommandDraft()
                rows.append(row)
                focused = row.key
            }
            .disabled(locked || rows.count >= StreamCommandsSetParams.maxCommands)
        } header: {
            Text(target.streamId == nil ? "Commands" : "This stream’s commands")
        } footer: {
            if let problem {
                Text(problem).foregroundStyle(.red)
            } else if target.streamId != nil {
                Text("Only in this stream. A name used by a project command replaces it here; other names are added.")
            } else {
                Text("Run offers them in this order. Long-press one to move it.")
            }
        }
    }

    private var suggestSection: some View {
        Section {
            Button {
                Task { await runSuggest() }
            } label: {
                if suggest == .busy {
                    HStack(spacing: 10) {
                        ProgressView()
                        Text("Claude is reading the project…")
                    }
                } else {
                    Label("Suggest with Claude", systemImage: "sparkles")
                }
            }
            .disabled(locked || suggest == .busy)
        } footer: {
            switch suggest {
            case .idle:
                Text("Claude reads the project and fills in its install and run commands for you to check.")
            case .busy:
                Text("This can take a minute or two.")
            case .done(let count) where count > 0:
                Text("Claude filled in \(count == 1 ? "1 command" : "\(count) commands"), marked above. Check them before saving: DevTool runs them as written.")
            case .done:
                Text("Claude has nothing to add here.")
            case .failed(let message):
                Text(message).foregroundStyle(.red)
            }
        }
    }

    // MARK: State

    private var project: InboxProject? {
        model.inboxes[target.desktopId]?.projects.first { $0.id == target.projectId }
    }

    private var stream: InboxStream? {
        guard let streamId = target.streamId else { return nil }
        return project?.streams.first { $0.id == streamId }
    }

    private var offline: Bool { model.isOffline(target.desktopId) }
    private var locked: Bool { offline || saving }
    /// Claude can't read an SSH project's folder yet (§8.21).
    private var canSuggest: Bool { project?.remote != true }
    private var problem: String? { RunCommandDrafts.problem(rows) }
    private var changed: Bool { RunCommandDrafts.entries(rows) != saved }

    private func move(_ key: String, by offset: Int) {
        guard let index = rows.firstIndex(where: { $0.key == key }) else { return }
        let to = index + offset
        guard rows.indices.contains(to) else { return }
        rows.swapAt(index, to)
    }

    private func load() async {
        loadError = nil
        do {
            let result = try await model.streamCommands(projectId: target.projectId, streamId: target.streamId, desktopId: target.desktopId)
            rows = result.commands.map(RunCommandDraft.init)
            saved = RunCommandDrafts.entries(rows)
            inherited = result.inherited
            loaded = true
            // Typing commands on a phone is slow: with nothing here yet, ask Claude first.
            if rows.isEmpty, inherited.isEmpty, canSuggest, !offline { await runSuggest() }
        } catch {
            loadError = error.localizedDescription
        }
    }

    /// After the project's commands were edited: only the inherited list changes, the rows stay as typed.
    private func reloadInherited() async {
        guard let result = try? await model.streamCommands(projectId: target.projectId, streamId: target.streamId, desktopId: target.desktopId)
        else { return }
        inherited = result.inherited
    }

    private func runSuggest() async {
        guard suggest != .busy else { return }
        suggest = .busy
        do {
            let suggested = try await model.suggestStreamCommands(projectId: target.projectId, streamId: target.streamId, desktopId: target.desktopId)
            // Into the rows as they are now: they may have been edited meanwhile.
            let (next, changedKeys) = RunCommandDrafts.merge(rows, suggested: suggested, inherited: inherited)
            if !changedKeys.isEmpty { rows = next }
            marked = Set(changedKeys)
            suggest = .done(count: changedKeys.count)
        } catch {
            suggest = .failed(error.localizedDescription)
        }
    }

    private func save() async {
        guard !saving, problem == nil else { return }
        saving = true
        saveError = nil
        do {
            try await model.setStreamCommands(RunCommandDrafts.entries(rows), projectId: target.projectId, streamId: target.streamId,
                                              desktopId: target.desktopId)
            dismiss()
        } catch {
            saveError = error.localizedDescription
            saving = false
        }
    }
}

/// One command: its name, and the command line in monospace, neither
/// autocorrected nor capitalized.
private struct CommandRowEditor: View {
    @Binding var row: RunCommandDraft
    let namePlaceholder: String
    var focused: FocusState<String?>.Binding

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            TextField("Name (\(namePlaceholder))", text: $row.name)
                .font(.subheadline.weight(.semibold))
                .focused(focused, equals: row.key)
            TextField("Command, e.g. npm run dev", text: $row.command, axis: .vertical)
                .font(.footnote.monospaced())
                .lineLimit(1...4)
        }
        .textInputAutocapitalization(.never)
        .autocorrectionDisabled()
        .padding(.vertical, 2)
    }
}
