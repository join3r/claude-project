import DevToolKit
import SwiftUI

/// The `/` menu above the composer (§8.14): the commands matching what's typed,
/// ranked as the desktop does. Terminal-only commands show, disabled.
struct CommandSuggestions: View {
    let commands: [ChatCommand]
    /// Room left above the keyboard; at least two rows show.
    let maxHeight: CGFloat
    let pick: (ChatCommand) -> Void

    private static let rowHeight: CGFloat = 48

    var body: some View {
        ScrollView {
            LazyVStack(spacing: 0) {
                ForEach(commands) { command in
                    Button { pick(command) } label: { row(command) }
                        .buttonStyle(.plain)
                        .disabled(command.terminalOnly)
                        .overlay(alignment: .bottom) {
                            if command.id != commands.last?.id { Divider().padding(.leading, 12) }
                        }
                }
            }
        }
        .scrollBounceBehavior(.basedOnSize)
        // Half a row past five says there's more.
        .frame(height: min(Self.rowHeight * (commands.count > 5 ? 5.5 : CGFloat(commands.count)),
                           max(Self.rowHeight * 2, maxHeight)))
        .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .accessibilityLabel("Commands")
    }

    private func row(_ command: ChatCommand) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text("/\(command.name)")
                    .font(.subheadline.monospaced().weight(.medium))
                    .lineLimit(1)
                    .layoutPriority(1)
                if let hint = command.argumentHint {
                    Text(hint)
                        .font(.caption.monospaced())
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
            if let description = command.terminalOnly ? "Terminal only — use the desktop" : command.description?.nonEmpty {
                Text(description)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
        }
        .frame(maxWidth: .infinity, minHeight: Self.rowHeight, maxHeight: Self.rowHeight, alignment: .leading)
        .padding(.horizontal, 12)
        .contentShape(Rectangle())
        .opacity(command.terminalOnly ? 0.45 : 1)
    }
}

/// `/btw <question>`: answered from the conversation without joining it.
struct SideQuestionSheet: View {
    let question: String
    let ask: () async throws -> ChatBtwResult
    @Environment(\.dismiss) private var dismiss
    @State private var answer: String?
    @State private var error: String?

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Text("/btw")
                            .font(.subheadline.monospaced().weight(.semibold))
                            .foregroundStyle(.tint)
                        Text(question)
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                            .textSelection(.enabled)
                    }
                    if let answer {
                        MarkdownText(markdown: answer)
                            .textSelection(.enabled)
                    } else if let error {
                        VStack(alignment: .leading, spacing: 10) {
                            Label(error, systemImage: "exclamationmark.triangle")
                                .foregroundStyle(.red)
                            Button("Ask again") { Task { await fetch() } }
                                .buttonStyle(.bordered)
                        }
                    } else {
                        HStack(spacing: 8) {
                            ProgressView()
                            Text("Thinking…")
                                .foregroundStyle(.secondary)
                        }
                    }
                    Text("Not added to the conversation")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                .padding()
                .frame(maxWidth: 780, alignment: .leading)
                .frame(maxWidth: .infinity)
            }
            .navigationTitle("Side question")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
                if let answer {
                    ToolbarItem(placement: .topBarLeading) {
                        Button("Copy", systemImage: "doc.on.doc") { UIPasteboard.general.string = answer }
                    }
                }
            }
        }
        .task { await fetch() }
    }

    private func fetch() async {
        error = nil
        do {
            let result = try await ask()
            if let response = result.response { answer = response } else { error = "No answer came back." }
        } catch is CancellationError {
            return
        } catch {
            self.error = error.localizedDescription
        }
    }
}

/// `/permissions`: the allow, ask and deny rules of the chat's settings files,
/// as the desktop's dialog edits them. The running session picks up changes.
struct PermissionsSheet: View {
    /// The chat's permission mode.
    let mode: String?
    /// False while the desktop is offline.
    let editable: Bool
    let load: () async throws -> [ChatPermissionSource]
    let update: (ChatPermissionKind, ChatPermissionBehavior, String, ChatPermissionAction) async throws -> [ChatPermissionSource]

    @Environment(\.dismiss) private var dismiss
    @State private var sources: [ChatPermissionSource]?
    @State private var loadError: String?
    @State private var error: String?
    @State private var behavior: ChatPermissionBehavior = .allow
    @State private var rule = ""
    @State private var destination: ChatPermissionKind = .localSettings
    @State private var busy = false

    /// The desktop dialog's help (`BEHAVIOR_HELP`).
    private static let help: [ChatPermissionBehavior: String] = [
        .allow: "Claude uses these without asking.",
        .ask: "Claude always asks first, even when another rule would allow it.",
        .deny: "Claude may never use these. Deny wins over allow and ask.",
    ]

    var body: some View {
        NavigationStack {
            Group {
                if let sources {
                    form(sources)
                } else if let loadError {
                    ContentUnavailableView {
                        Label("Can't show permissions", systemImage: "lock.shield")
                    } description: {
                        Text(loadError)
                    } actions: {
                        Button("Try again") { Task { await fetch() } }
                            .buttonStyle(.bordered)
                            .disabled(!editable)
                    }
                } else {
                    ProgressView("Loading…")
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            }
            .navigationTitle("Permissions")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
        .task { await fetch() }
    }

    private func form(_ sources: [ChatPermissionSource]) -> some View {
        List {
            Section {
                Picker("Rules", selection: $behavior) {
                    ForEach(ChatPermissionBehavior.allCases, id: \.self) { behavior in
                        Text(behavior.rawValue.capitalized).tag(behavior)
                    }
                }
                .pickerStyle(.segmented)
                .listRowInsets(EdgeInsets())
                .listRowBackground(Color.clear)
            } footer: {
                VStack(alignment: .leading, spacing: 4) {
                    Text("\(Self.help[behavior] ?? "") Changes apply to the running session.")
                    Text("Mode for this chat: \(PermissionModes.label(mode))")
                }
            }

            Section {
                TextField("Bash(npm test:*)", text: $rule)
                    .font(.body.monospaced())
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .submitLabel(.done)
                    .onSubmit(add)
                HStack {
                    Menu {
                        Picker("Save in", selection: $destination) {
                            ForEach(ChatPermissionKind.allCases, id: \.self) { kind in
                                Text(kind.title).tag(kind)
                            }
                        }
                    } label: {
                        Label(destination.title, systemImage: "folder")
                            .font(.subheadline)
                    }
                    Spacer()
                    if busy { ProgressView().controlSize(.small) }
                    Button("Add", action: add)
                        .buttonStyle(.borderedProminent)
                        .disabled(!canAdd)
                }
                if let error {
                    Text(error)
                        .font(.footnote)
                        .foregroundStyle(.red)
                }
            } header: {
                Text("New \(behavior.rawValue) rule")
            }
            .disabled(!editable)

            ForEach(sources) { source in
                Section {
                    let rules = source.rules(behavior)
                    if let error = source.error {
                        Text(error)
                            .font(.footnote)
                            .foregroundStyle(.red)
                    } else if rules.isEmpty {
                        Text("No \(behavior.rawValue) rules")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    } else {
                        ForEach(rules, id: \.self) { value in
                            Text(value)
                                .font(.footnote.monospaced())
                                .textSelection(.enabled)
                                .swipeActions {
                                    if editable {
                                        Button("Remove", systemImage: "trash", role: .destructive) {
                                            change(source.kind, value, .remove)
                                        }
                                    }
                                }
                        }
                    }
                } header: {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(source.kind.title)
                        Text(source.kind.hint)
                            .font(.caption2.monospaced())
                            .textCase(nil)
                    }
                }
            }
        }
        .animation(.default, value: behavior)
    }

    private var canAdd: Bool {
        editable && !busy && !rule.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && rule.utf16.count <= ChatOp.maxRuleLength
    }

    private func add() {
        guard canAdd else { return }
        change(destination, rule, .add)
    }

    private func change(_ kind: ChatPermissionKind, _ value: String, _ action: ChatPermissionAction) {
        guard editable, !busy else { return }
        busy = true
        error = nil
        Task {
            defer { busy = false }
            do {
                sources = try await update(kind, behavior, value, action)
                if action == .add { rule = "" }
            } catch {
                self.error = error.localizedDescription
            }
        }
    }

    private func fetch() async {
        loadError = nil
        do {
            sources = try await load()
        } catch is CancellationError {
            return
        } catch {
            loadError = error.localizedDescription
        }
    }
}
