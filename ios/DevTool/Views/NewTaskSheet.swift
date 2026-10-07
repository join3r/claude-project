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
    /// "New workspace" (§8.6): the task gets its own worktree and branch.
    var workspace = false

    var id: String { "\(desktopIds.joined(separator: ","))/\(project?.id ?? "")/\(workspace)" }

    /// One project's own "New task" or "New workspace" button.
    init(desktopId: String, projectId: String, workspace: Bool) {
        desktopIds = [desktopId]
        project = NewTaskProject(desktopId: desktopId, projectId: projectId)
        self.workspace = workspace
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

/// "New task" and "New workspace" (§8.3, §8.4, §8.6): the project, the first
/// prompt and a permission mode. The desktop names the task (and a
/// workspace's branch) after the prompt and starts Claude on it; the chat
/// opens as soon as the task shows up in the inbox.
struct NewTaskSheet: View {
    static let lastProjectKey = "newTask.lastProject"

    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let target: NewTaskTarget

    @AppStorage(NewTaskSheet.lastProjectKey) private var lastProject = ""
    @State private var selection: NewTaskProject?
    @State private var workspace: Bool
    @State private var prompt = ""
    /// "" leaves Claude's own default mode.
    @State private var mode = ""
    @State private var sending = false
    @State private var error: String?
    @FocusState private var focused: Bool

    init(target: NewTaskTarget) {
        self.target = target
        _selection = State(initialValue: target.project)
        _workspace = State(initialValue: target.workspace)
    }

    var body: some View {
        let desktops = model.newTaskDesktops(target.desktopIds)
        NavigationStack {
            Form {
                Section {
                    TextField("What should Claude work on?", text: $prompt, axis: .vertical)
                        .lineLimit(4...12)
                        .focused($focused)
                        .disabled(sending)
                } footer: {
                    if workspaceOn {
                        Text("The task and a new branch are named after the prompt's first line. Claude works in its own worktree, forked from main or master.")
                    } else {
                        Text("The task is named after the prompt's first line.")
                    }
                }
                Section {
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
                    if canWorkspace {
                        Toggle("New workspace", isOn: $workspace)
                            .disabled(sending)
                    }
                    Picker("Mode", selection: $mode) {
                        Text("Default").tag("")
                        ForEach(TaskOp.modes, id: \.self) { value in
                            Text(PermissionModes.labels[value] ?? value).tag(value)
                        }
                    }
                    .disabled(sending)
                } footer: {
                    if let selection, model.isOffline(selection.desktopId) {
                        Text("\(model.desktop(selection.desktopId)?.name ?? "This desktop") is offline.")
                    }
                }
                if let error {
                    Section {
                        Text(error).foregroundStyle(.red)
                    }
                }
            }
            .navigationTitle(workspaceOn ? "New workspace" : "New task")
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
                focused = true
            }
        }
    }

    private func projectRows(_ projects: [InboxProject], desktopId: String) -> some View {
        ForEach(projects) { project in
            ProjectHeader(project: project, desktopName: nil)
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

    private var canWorkspace: Bool {
        guard let selection else { return false }
        return model.supports(DesktopFeature.taskWorkspace, on: selection.desktopId)
    }

    private var workspaceOn: Bool { workspace && canWorkspace }
    private var trimmed: String { prompt.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var offline: Bool { selection.map { model.isOffline($0.desktopId) } ?? true }

    private func start() async {
        guard !sending, !trimmed.isEmpty, let selection else { return }
        sending = true
        error = nil
        do {
            let route = try await model.newTask(
                desktopId: selection.desktopId, projectId: selection.projectId, prompt: trimmed,
                mode: mode.isEmpty ? nil : mode, workspace: workspaceOn
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
