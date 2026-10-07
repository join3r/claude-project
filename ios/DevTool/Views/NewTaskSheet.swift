import DevToolKit
import SwiftUI

/// What a "New task" sheet opens with: the desktops it may pick a project
/// from, and optionally a project already picked.
struct NewTaskTarget: Identifiable, Hashable {
    /// The desktops whose projects the picker lists.
    let desktopIds: [String]
    /// Picked up front by a project's own "New task" button; otherwise the
    /// sheet picks the last project a task went to.
    var project: NewTaskProject?
    /// Picked up front by a stream's own "New task"; otherwise the project's
    /// most recently used stream.
    var streamId: String?

    var id: String { "\(desktopIds.joined(separator: ","))/\(project?.id ?? "")/\(streamId ?? "")" }

    /// One project's (or stream's) own "New task" button.
    init(desktopId: String, projectId: String, streamId: String? = nil) {
        desktopIds = [desktopId]
        project = NewTaskProject(desktopId: desktopId, projectId: projectId)
        self.streamId = streamId
    }

    /// The toolbar's compose button: any project of these desktops.
    init(desktopIds: [String]) {
        self.desktopIds = desktopIds
    }

    static func == (a: NewTaskTarget, b: NewTaskTarget) -> Bool { a.id == b.id }
    func hash(into hasher: inout Hasher) { hasher.combine(id) }
}

/// A project on one desktop: the picker's selection.
struct NewTaskProject: Hashable {
    let desktopId: String
    let projectId: String

    var id: String { "\(desktopId)/\(projectId)" }

    init(desktopId: String, projectId: String) {
        self.desktopId = desktopId
        self.projectId = projectId
    }

    /// Back from `id`, for the remembered last project.
    init?(id: String) {
        let parts = id.split(separator: "/", maxSplits: 1).map(String.init)
        guard parts.count == 2 else { return nil }
        self.init(desktopId: parts[0], projectId: parts[1])
    }
}

extension AppModel {
    /// The desktops among `desktopIds` that take `task.new` and have sent an
    /// inbox, with their projects: what the New task picker lists.
    func newTaskDesktops(_ desktopIds: [String]) -> [(desktop: DesktopRecord, projects: [InboxProject])] {
        desktops.compactMap { desktop in
            guard desktopIds.contains(desktop.id),
                  supports(DesktopFeature.taskNew, on: desktop.id),
                  let projects = inboxes[desktop.id]?.projects, !projects.isEmpty
            else { return nil }
            return (desktop, projects)
        }
    }
}

/// The toolbar's compose button, for the Inbox and the project lists. Hidden
/// until one of the desktops can start a task.
struct NewTaskToolbarButton: View {
    @Environment(AppModel.self) private var model
    let desktopIds: [String]
    @Binding var newTask: NewTaskTarget?

    var body: some View {
        let desktops = model.newTaskDesktops(desktopIds)
        if !desktops.isEmpty {
            Button("New task", systemImage: "square.and.pencil") {
                newTask = NewTaskTarget(desktopIds: desktopIds)
            }
            .disabled(desktops.allSatisfy { model.isOffline($0.desktop.id) })
        }
    }
}

/// "New task" (§8.3, §8.4), project first: the project, its stream, the
/// agent (a Claude chat: what `task.new` starts), a permission mode and the
/// first prompt. The stream defaults to the one the project was last used
/// in. The desktop names the task after the prompt and starts Claude on it in
/// the stream's folder; the chat opens as soon as the task shows up in the inbox.
struct NewTaskSheet: View {
    static let lastProjectKey = "newTask.lastProject"

    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let target: NewTaskTarget

    @AppStorage(NewTaskSheet.lastProjectKey) private var lastProject = ""
    @State private var selection: NewTaskProject?
    /// nil until a project is picked; then its default stream.
    @State private var streamId: String?
    @State private var prompt = ""
    /// "" leaves Claude's own default mode.
    @State private var mode = ""
    @State private var sending = false
    @State private var error: String?
    @FocusState private var focused: Bool

    init(target: NewTaskTarget) {
        self.target = target
        _selection = State(initialValue: target.project)
        _streamId = State(initialValue: target.streamId)
    }

    var body: some View {
        let desktops = model.newTaskDesktops(target.desktopIds)
        NavigationStack {
            Form {
                Section {
                    projectRow(desktops)
                    let streams = selectedProject?.streams ?? []
                    if streams.count > 1 {
                        Picker("Stream", selection: $streamId) {
                            ForEach(streams) { stream in
                                StreamLabel(stream: stream)
                                    .tag(Optional(stream.id))
                            }
                        }
                        .pickerStyle(.navigationLink)
                        .disabled(sending)
                    } else if let stream = selectedStream ?? streams.first {
                        LabeledContent("Stream") { StreamLabel(stream: stream) }
                    }
                } footer: {
                    if let selection, model.isOffline(selection.desktopId) {
                        Text("\(model.desktop(selection.desktopId)?.name ?? "This desktop") is offline.")
                    } else if let stream = selectedStream, let branch = stream.branch {
                        Text("Works in the \(stream.name) worktree, on \(branch).")
                    }
                }
                Section {
                    // `task.new` starts a Claude chat; other agents start on the desktop.
                    LabeledContent("Agent") {
                        HStack(spacing: 6) {
                            Image(systemName: "bubble.left")
                            Text("Claude chat")
                        }
                    }
                    Picker("Mode", selection: $mode) {
                        Text("Default").tag("")
                        ForEach(TaskOp.modes, id: \.self) { value in
                            Text(PermissionModes.labels[value] ?? value).tag(value)
                        }
                    }
                    .disabled(sending)
                }
                Section {
                    TextField("What should Claude work on?", text: $prompt, axis: .vertical)
                        .lineLimit(5...12)
                        .focused($focused)
                        .disabled(sending)
                } header: {
                    Text("What should it do?")
                } footer: {
                    Text("The task is named from this prompt.")
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
                            .disabled(trimmed.isEmpty || selection == nil || offline)
                    }
                }
            }
            .interactiveDismissDisabled(sending)
            .onAppear {
                if selection == nil { selection = defaultProject(desktops) }
                if streamId == nil || selectedStream == nil { streamId = selectedProject?.defaultStream?.id }
                focused = true
            }
            .onChange(of: selection) {
                // Another project: its own most recently used stream.
                streamId = selectedProject?.defaultStream?.id
            }
        }
    }

    /// The project, first and bold with its tile: fixed when the sheet came
    /// from a project or stream, else a picker.
    @ViewBuilder
    private func projectRow(_ desktops: [(desktop: DesktopRecord, projects: [InboxProject])]) -> some View {
        if target.project != nil, let project = selectedProject {
            LabeledContent("Project") { ProjectNameLabel(project: project) }
        } else {
            Picker("Project", selection: $selection) {
                if desktops.count > 1 {
                    ForEach(desktops, id: \.desktop.id) { entry in
                        Section(entry.desktop.name) {
                            projectRows(entry.projects, desktopId: entry.desktop.id)
                        }
                    }
                } else if let entry = desktops.first {
                    projectRows(entry.projects, desktopId: entry.desktop.id)
                }
            }
            .pickerStyle(.navigationLink)
            .disabled(sending)
        }
    }

    private func projectRows(_ projects: [InboxProject], desktopId: String) -> some View {
        ForEach(projects) { project in
            ProjectNameLabel(project: project)
                .tag(Optional(NewTaskProject(desktopId: desktopId, projectId: project.id)))
        }
    }

    /// The last project a task went to, if this sheet lists it; else the
    /// first project of an online desktop; else the first one.
    private func defaultProject(_ desktops: [(desktop: DesktopRecord, projects: [InboxProject])]) -> NewTaskProject? {
        let listed = desktops.flatMap { entry in
            entry.projects.map { NewTaskProject(desktopId: entry.desktop.id, projectId: $0.id) }
        }
        if let last = NewTaskProject(id: lastProject), listed.contains(last) { return last }
        return listed.first { !model.isOffline($0.desktopId) } ?? listed.first
    }

    private var selectedProject: InboxProject? {
        guard let selection else { return nil }
        return model.inboxes[selection.desktopId]?.projects.first { $0.id == selection.projectId }
    }

    private var selectedStream: InboxStream? {
        selectedProject?.streams.first { $0.id == streamId }
    }
    private var trimmed: String { prompt.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var offline: Bool { selection.map { model.isOffline($0.desktopId) } ?? true }

    private func start() async {
        guard !sending, !trimmed.isEmpty, let selection else { return }
        sending = true
        error = nil
        do {
            // A stream that has gone since the picker was filled: let the desktop pick.
            let route = try await model.newTask(
                desktopId: selection.desktopId, projectId: selection.projectId, streamId: selectedStream?.id,
                prompt: trimmed, mode: mode.isEmpty ? nil : mode
            )
            lastProject = selection.id
            dismiss()
            // RootView waits for the task to appear in the inbox, then pushes the chat.
            model.requestedChat = route
        } catch {
            self.error = error.localizedDescription
            sending = false
        }
    }
}

/// A project's tile and bold name, as the New task sheet leads with it.
struct ProjectNameLabel: View {
    let project: InboxProject

    var body: some View {
        HStack(spacing: 8) {
            ProjectTileView(tile: project.tile, size: 22)
            Text(project.name)
                .fontWeight(.semibold)
                .foregroundStyle(.primary)
            if project.remote {
                Image(systemName: "network")
                    .foregroundStyle(.secondary)
                    .accessibilityLabel("Remote")
            }
        }
        .lineLimit(1)
    }
}
