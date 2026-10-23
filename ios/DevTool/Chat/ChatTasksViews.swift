import DevToolKit
import SwiftUI

// What Claude runs beside the turn (§8.20), as the desktop chat's task pill:
// a pill above the composer, a sheet listing the tasks, and a workflow's phases
// and agents one tap further.

/// Unix ms now; the views tick once a second.
private func nowMs(_ date: Date) -> Int64 { date.unixMilliseconds }

extension ChatTaskKind {
    var symbol: String {
        switch self {
        case .subagent: "sparkles"
        case .shell: "terminal"
        case .workflow: "point.3.connected.trianglepath.dotted"
        case .monitor: "waveform.path.ecg"
        case .mcp: "powerplug"
        case .other: "checklist"
        }
    }
}

/// A small pulsing dot: still running.
private struct RunningDot: View {
    var body: some View {
        Image(systemName: "circle.fill")
            .font(.system(size: 7))
            .foregroundStyle(.tint)
            .symbolEffect(.pulse, options: .repeating)
            .frame(width: 14)
            .accessibilityHidden(true)
    }
}

private struct TaskOutcome: View {
    let status: ChatTaskStatus

    var body: some View {
        switch status {
        case .running: RunningDot()
        case .completed: Image(systemName: "checkmark").foregroundStyle(.green).accessibilityLabel("Completed")
        case .failed: Image(systemName: "xmark").foregroundStyle(.red).accessibilityLabel("Failed")
        case .stopped: Image(systemName: "slash.circle").foregroundStyle(.secondary).accessibilityLabel("Stopped")
        }
    }
}

/// "2 agents · 1 shell" over the transcript's top right, while anything runs and for a
/// minute after the last one finished. Hidden when there is nothing to show.
///
/// It shows no clock, so it redraws only when a finished task ages out: a
/// once-a-second redraw of the bottom bar throws the transcript's scroll off.
struct ChatTasksPill: View {
    let tasks: [ChatTask]
    let open: () -> Void

    @State private var now = Date()

    /// When the next finished task leaves the list, in unix ms.
    private var nextExpiry: Int64? {
        let at = nowMs(now)
        return tasks.compactMap { task in task.running ? nil : task.endedAt.map { $0 + ChatTasks.lingerMs } }
            .filter { $0 > at }
            .min()
    }

    var body: some View {
        let shown = ChatTasks.visible(tasks, now: nowMs(now))
        Group {
            if !shown.isEmpty {
                pill(shown)
            }
        }
        .onChange(of: tasks) { now = Date() }
        .task(id: nextExpiry) {
            guard let expiry = nextExpiry else { return }
            let wait = max(0, expiry - nowMs(Date()))
            guard (try? await Task.sleep(for: .milliseconds(wait + 50))) != nil else { return }
            now = Date()
        }
    }

    private func pill(_ shown: [ChatTask]) -> some View {
        let running = shown.filter(\.running)
        let label = running.isEmpty ? "\(ChatTasks.countLabel(shown)) done" : ChatTasks.countLabel(running)
        return Button(action: open) {
            HStack(spacing: 5) {
                if !running.isEmpty {
                    RunningDot()
                } else if shown.contains(where: { $0.status == .failed }) {
                    Image(systemName: "xmark").foregroundStyle(.red).imageScale(.small)
                } else {
                    Image(systemName: "checkmark").foregroundStyle(.green).imageScale(.small)
                }
                Text(label).lineLimit(1).monospacedDigit()
                Image(systemName: "chevron.up").imageScale(.small).foregroundStyle(.tertiary)
            }
            .font(.caption)
            .foregroundStyle(.secondary)
            .padding(.horizontal, 10)
            .padding(.vertical, 5)
            .background(.regularMaterial, in: Capsule())
            .shadow(color: .black.opacity(0.12), radius: 4, y: 1)
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(running.isEmpty ? "Finished" : "Running"): \(label)")
        .accessibilityHint("Shows the tasks Claude is running")
    }
}

/// The sheet behind the pill: every task, Stop on a running one, and a
/// workflow's phases and agents.
struct ChatTasksSheet: View {
    let model: ChatModel
    /// Offline or a saved transcript: nothing can be stopped.
    let readOnly: Bool

    @Environment(\.dismiss) private var dismiss
    @State private var confirmStop: ChatTask?
    @State private var path: [String]

    init(model: ChatModel, readOnly: Bool, workflow: String? = nil) {
        self.model = model
        self.readOnly = readOnly
        _path = State(initialValue: workflow.map { [$0] } ?? [])
    }

    private var tasks: [ChatTask] { model.view?.status.tasks ?? [] }

    var body: some View {
        NavigationStack(path: $path) {
            TimelineView(.periodic(from: .now, by: 1)) { context in
                let now = nowMs(context.date)
                let shown = ChatTasks.visible(tasks, now: now)
                List {
                    ForEach(shown) { task in
                        Group {
                            if task.workflow != nil {
                                NavigationLink(value: task.id) { TaskRow(task: task, now: now) }
                            } else {
                                TaskRow(task: task, now: now)
                            }
                        }
                        .swipeActions(edge: .trailing) {
                            if task.running, !readOnly {
                                Button("Stop", role: .destructive) { confirmStop = task }
                            }
                        }
                    }
                }
                .overlay {
                    if shown.isEmpty {
                        ContentUnavailableView("Nothing running", systemImage: "checkmark.circle",
                                               description: Text("Subagents, shells and workflows Claude starts show up here."))
                    }
                }
            }
            .navigationDestination(for: String.self) { id in
                WorkflowScreen(taskId: id, model: model, readOnly: readOnly, confirmStop: $confirmStop)
            }
            .navigationTitle("Tasks")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
            }
            .confirmationDialog(
                "Stop \(confirmStop?.description ?? "this task")?",
                isPresented: Binding(get: { confirmStop != nil }, set: { if !$0 { confirmStop = nil } }),
                titleVisibility: .visible,
                presenting: confirmStop
            ) { task in
                Button("Stop", role: .destructive) { Task { await model.stopTask(task.id) } }
            } message: { _ in
                Text("Whatever it has done so far is thrown away.")
            }
        }
    }
}

/// One task, as the desktop pill's row: what it is, how long it has run, what it is doing.
private struct TaskRow: View {
    let task: ChatTask
    let now: Int64

    private var elapsed: String? {
        task.startedAt.map { ChatTasks.elapsed(ms: (task.endedAt ?? now) - $0) }
    }

    private var meta: String {
        [
            task.agentType,
            elapsed,
            task.toolUses.map { "\($0) \($0 == 1 ? "tool" : "tools")" },
            task.tokens.map { "\(ChatTasks.tokens($0)) tokens" },
        ].compactMap { $0 }.joined(separator: " · ")
    }

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Image(systemName: task.kind.symbol)
                .foregroundStyle(.secondary)
                .frame(width: 20)
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Text(task.description)
                        .font(.subheadline)
                        .foregroundStyle(task.running ? .primary : .secondary)
                        .lineLimit(2)
                    if task.background {
                        Text("bg")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                            .padding(.horizontal, 4)
                            .background(Color(.tertiarySystemFill), in: RoundedRectangle(cornerRadius: 3))
                    }
                }
                if let command = task.command {
                    Text("$ \(command)").font(.caption.monospaced()).foregroundStyle(.secondary).lineLimit(1)
                }
                if !meta.isEmpty {
                    Text(meta).font(.caption).foregroundStyle(.secondary).monospacedDigit().lineLimit(1)
                }
                if let detail = task.detail {
                    Text(detail).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                }
                if let workflow = task.workflow {
                    WorkflowSummary(workflow: workflow, running: task.running)
                }
            }
            Spacer(minLength: 0)
            TaskOutcome(status: task.status)
                .font(.caption.weight(.semibold))
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
    }
}

/// "Phase 2 of 3 · Verify", "5 of 12 agents done · 1 failed" and a bar.
private struct WorkflowSummary: View {
    let workflow: ChatWorkflow
    let running: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            if let phase = workflow.phaseLabel {
                Text(phase).font(.caption).foregroundStyle(running ? .primary : .secondary).lineLimit(1)
            }
            if let agents = workflow.agentsLabel {
                Text(agents).font(.caption).foregroundStyle(.secondary).monospacedDigit().lineLimit(1)
                ProgressBar(counts: workflow.counts)
            }
        }
        .padding(.top, 2)
    }
}

/// Done in the accent colour, failed in red, the rest empty.
private struct ProgressBar: View {
    let counts: ChatWorkflow.Counts

    var body: some View {
        GeometryReader { geometry in
            let total = CGFloat(max(1, counts.total))
            HStack(spacing: 0) {
                Rectangle().fill(.tint).frame(width: geometry.size.width * CGFloat(counts.done) / total)
                Rectangle().fill(.red).frame(width: geometry.size.width * CGFloat(counts.failed) / total)
                Spacer(minLength: 0)
            }
        }
        .frame(height: 4)
        .background(Color(.tertiarySystemFill))
        .clipShape(Capsule())
        .accessibilityHidden(true)
    }
}

/// A workflow's phases, each a section of its agents.
private struct WorkflowScreen: View {
    let taskId: String
    let model: ChatModel
    let readOnly: Bool
    @Binding var confirmStop: ChatTask?

    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { context in
            let now = nowMs(context.date)
            if let task = model.view?.status.tasks.first(where: { $0.id == taskId }), let workflow = task.workflow {
                List {
                    Section {
                        TaskRow(task: task, now: now)
                    }
                    ForEach(Array(workflow.phases.enumerated()), id: \.offset) { index, phase in
                        PhaseSection(title: phase.title, detail: phase.detail, started: phase.started,
                                     agents: workflow.agents(inPhase: index), now: now)
                    }
                    if !workflow.looseAgents.isEmpty {
                        PhaseSection(title: workflow.phases.isEmpty ? "Agents" : "Other agents", detail: nil, started: true,
                                     agents: workflow.looseAgents, now: now)
                    }
                    if workflow.moreAgents > 0 {
                        Section {
                            Text("\(workflow.moreAgents) more finished \(workflow.moreAgents == 1 ? "agent" : "agents") not listed")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                }
                .navigationTitle(task.description)
                .toolbar {
                    if task.running, !readOnly {
                        ToolbarItem(placement: .bottomBar) {
                            Button("Stop workflow", role: .destructive) { confirmStop = task }
                                .tint(.red)
                                .disabled(model.stoppingTasks.contains(task.id))
                        }
                    }
                }
            } else {
                ContentUnavailableView("Workflow finished", systemImage: "checkmark.circle",
                                       description: Text("It's no longer in the task list."))
            }
        }
        .navigationBarTitleDisplayMode(.inline)
    }
}

private struct PhaseSection: View {
    let title: String
    let detail: String?
    let started: Bool
    let agents: [ChatWorkflowAgent]
    let now: Int64

    var body: some View {
        let counts = ChatWorkflow.counts(agents)
        Section {
            if agents.isEmpty {
                Text(started ? "No agents yet" : "Not started")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            ForEach(Array(agents.enumerated()), id: \.offset) { _, agent in
                AgentRow(agent: agent, now: now)
            }
        } header: {
            HStack {
                Text(title)
                Spacer()
                if !agents.isEmpty {
                    Text("\(counts.done)/\(counts.total)").monospacedDigit()
                }
            }
        } footer: {
            if let detail { Text(detail) }
        }
    }
}

private struct AgentRow: View {
    let agent: ChatWorkflowAgent
    let now: Int64

    private var elapsed: String? {
        if agent.state == .running, let startedAt = agent.startedAt { return ChatTasks.elapsed(ms: now - startedAt) }
        return agent.durationMs.map { ChatTasks.elapsed(ms: $0) }
    }

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            state.frame(width: 16)
            VStack(alignment: .leading, spacing: 2) {
                Text(agent.label)
                    .font(.subheadline)
                    .foregroundStyle(agent.state == .running ? .primary : .secondary)
                    .lineLimit(2)
                if agent.state == .running, let tool = agent.lastTool {
                    Text(tool).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                }
            }
            Spacer(minLength: 0)
            VStack(alignment: .trailing, spacing: 2) {
                if let elapsed { Text(elapsed).monospacedDigit() }
                if let attempt = agent.attempt { Text("try \(attempt)") }
                if let tokens = agent.tokens { Text("\(ChatTasks.tokens(tokens)) tokens").monospacedDigit() }
            }
            .font(.caption2)
            .foregroundStyle(.secondary)
        }
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder private var state: some View {
        switch agent.state {
        case .running: RunningDot()
        case .queued: Image(systemName: "circle").font(.caption2).foregroundStyle(.secondary).accessibilityLabel("Queued")
        case .done: Image(systemName: "checkmark").font(.caption.weight(.semibold)).foregroundStyle(.green).accessibilityLabel("Done")
        case .failed: Image(systemName: "xmark").font(.caption.weight(.semibold)).foregroundStyle(.red).accessibilityLabel("Failed")
        case .skipped: Image(systemName: "slash.circle").font(.caption).foregroundStyle(.secondary).accessibilityLabel("Skipped")
        }
    }
}
