import DevToolKit
import SwiftUI

/// The oldest open prompt, pinned above the composer.
struct PromptCard: View {
    let prompt: ChatPrompt
    /// Other prompts waiting behind this one.
    let moreCount: Int
    let answering: Bool
    let error: String?
    let enabled: Bool
    /// Taller cards scroll inside this height, so the transcript stays in view.
    var maxHeight: CGFloat = .infinity
    let onAnswer: (ChatAnswer) -> Void
    @State private var contentHeight: CGFloat = 0

    var body: some View {
        ScrollView {
            card
                .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { if abs(contentHeight - $0) > 1 { contentHeight = $0 } }
        }
        .scrollBounceBehavior(.basedOnSize)
        .frame(height: min(contentHeight, maxHeight))
        .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .strokeBorder(Color.orange.opacity(0.45), lineWidth: 1)
        }
        .shadow(color: .black.opacity(0.08), radius: 8, y: 2)
        .accessibilityElement(children: .contain)
    }

    private var card: some View {
        VStack(alignment: .leading, spacing: 10) {
            switch prompt.content {
            case .permission(let permission):
                PermissionPromptView(permission: permission, busy: answering, enabled: enabled, onAnswer: onAnswer)
            case .question(let questions):
                QuestionPromptView(questions: questions, busy: answering, enabled: enabled, onAnswer: onAnswer)
            case .plan(let markdown):
                PlanPromptView(markdown: markdown, busy: answering, enabled: enabled, onAnswer: onAnswer)
            case .unknown:
                Label("The agent is waiting for an answer this app can't show. Answer it on the desktop, or update the app.",
                      systemImage: "arrow.up.circle")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
            if let error {
                Label(error, systemImage: "exclamationmark.triangle.fill")
                    .font(.footnote)
                    .foregroundStyle(.red)
            }
            if moreCount > 0 {
                Text(moreCount == 1 ? "1 more request waiting" : "\(moreCount) more requests waiting")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// Header shared by the cards: icon, eyebrow, title.
private struct PromptHeader: View {
    let symbol: String
    let eyebrow: String
    let title: String
    var badge: String?

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: symbol)
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(.orange)
                .frame(width: 30, height: 30)
                .background(Color.orange.opacity(0.15), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(eyebrow.uppercased())
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(.secondary)
                    if let badge {
                        Text(badge)
                            .font(.caption2.weight(.semibold))
                            .padding(.horizontal, 6)
                            .padding(.vertical, 1)
                            .background(.quaternary, in: Capsule())
                    }
                }
                Text(title)
                    .font(.subheadline.weight(.semibold))
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }
}

/// Buttons in a row that wrap to a column when they don't fit.
private struct AnswerButtons<Content: View>: View {
    let busy: Bool
    @ViewBuilder let content: () -> Content

    var body: some View {
        ZStack {
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 8) { content() }
                VStack(spacing: 8) { content() }
            }
            .opacity(busy ? 0 : 1)
            if busy {
                ProgressView()
                    .controlSize(.regular)
                    .accessibilityLabel("Sending answer")
            }
        }
        .frame(maxWidth: .infinity)
        .animation(.default, value: busy)
    }
}

struct PermissionPromptView: View {
    let permission: ChatPermission
    let busy: Bool
    let enabled: Bool
    let onAnswer: (ChatAnswer) -> Void
    @State private var showDetail = false

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            PromptHeader(symbol: ChatTool(name: permission.toolName, summary: "", status: .waiting, hasDetail: false).symbol,
                         eyebrow: "Permission · \(permission.toolName)", title: permission.title,
                         badge: permission.agent ? "Subagent" : nil)
            if !permission.summary.isEmpty {
                Text(permission.summary)
                    .font(.footnote.monospaced())
                    .lineLimit(showDetail ? nil : 3)
                    .padding(8)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color(.tertiarySystemFill), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
            }
            if let detail = permission.detail, !detail.isEmpty {
                Button {
                    withAnimation(.snappy) { showDetail.toggle() }
                } label: {
                    Label(showDetail ? "Hide details" : "Show details", systemImage: showDetail ? "chevron.up" : "chevron.down")
                        .font(.footnote.weight(.medium))
                }
                .buttonStyle(.borderless)
                if showDetail {
                    ScrollView {
                        Text(detail)
                            .font(.caption.monospaced())
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(8)
                    }
                    .frame(maxHeight: 180)
                    .background(Color(.tertiarySystemFill), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                }
            }
            // Deny and Allow share a row; "Always allow" gets its own, since three equal
            // buttons on a phone cut it to "Always…".
            AnswerButtons(busy: busy) {
                VStack(spacing: 8) {
                    HStack(spacing: 8) {
                        Button(role: .destructive) { onAnswer(.deny(message: nil)) } label: {
                            Text("Deny").frame(maxWidth: .infinity)
                        }
                        .buttonStyle(.bordered)
                        Button { onAnswer(.allow(always: false)) } label: {
                            Text("Allow").bold().frame(maxWidth: .infinity)
                        }
                        .buttonStyle(.borderedProminent)
                    }
                    if permission.canAlwaysAllow {
                        Button { onAnswer(.allow(always: true)) } label: {
                            Text("Always allow").frame(maxWidth: .infinity)
                        }
                        .buttonStyle(.bordered)
                    }
                }
            }
            .controlSize(.large)
            .disabled(!enabled || busy)
        }
    }
}

struct QuestionPromptView: View {
    let questions: [ChatQuestion]
    let busy: Bool
    let enabled: Bool
    let onAnswer: (ChatAnswer) -> Void
    /// Selected labels per question index.
    @State private var selections: [Int: [String]] = [:]

    /// One single-select question answers on tap; anything else needs Submit.
    private var answersOnTap: Bool {
        questions.count == 1 && !(questions.first?.multiSelect ?? false)
    }

    private var complete: Bool {
        questions.indices.allSatisfy { !(selections[$0] ?? []).isEmpty }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            ForEach(Array(questions.enumerated()), id: \.offset) { index, question in
                VStack(alignment: .leading, spacing: 8) {
                    PromptHeader(symbol: "questionmark.bubble", eyebrow: question.header ?? "Question", title: question.question)
                    if question.multiSelect {
                        Text("Choose any")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    VStack(spacing: 6) {
                        ForEach(question.options, id: \.self) { option in
                            optionButton(option, question: question, index: index)
                        }
                    }
                }
            }
            if !answersOnTap {
                AnswerButtons(busy: busy) {
                    Button { submit() } label: {
                        Text("Submit").bold().frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(!complete)
                }
                .controlSize(.large)
            } else if busy {
                ProgressView().frame(maxWidth: .infinity)
            }
        }
        .disabled(!enabled || busy)
    }

    private func optionButton(_ option: ChatQuestionOption, question: ChatQuestion, index: Int) -> some View {
        let selected = (selections[index] ?? []).contains(option.label)
        return Button {
            toggle(option.label, question: question, index: index)
        } label: {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                Image(systemName: question.multiSelect
                      ? (selected ? "checkmark.square.fill" : "square")
                      : (selected ? "largecircle.fill.circle" : "circle"))
                    .foregroundStyle(selected ? Color.accentColor : .secondary)
                VStack(alignment: .leading, spacing: 2) {
                    Text(option.label)
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(.primary)
                    if let description = option.description, !description.isEmpty {
                        Text(description)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .background(selected ? Color.accentColor.opacity(0.12) : Color(.tertiarySystemFill),
                        in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .strokeBorder(selected ? Color.accentColor : .clear, lineWidth: 1.5)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }

    private func toggle(_ label: String, question: ChatQuestion, index: Int) {
        var current = selections[index] ?? []
        if question.multiSelect {
            if let at = current.firstIndex(of: label) { current.remove(at: at) } else { current.append(label) }
        } else {
            current = [label]
        }
        selections[index] = current
        if answersOnTap { submit() }
    }

    private func submit() {
        guard complete else { return }
        let answers = questions.enumerated().map { index, question in
            // Keep the options' order, as the desktop does when it joins labels.
            let chosen = question.options.map(\.label).filter { (selections[index] ?? []).contains($0) }
            return (question: question.question, answer: ChatAnswer.joined(chosen))
        }
        onAnswer(.answers(answers))
    }
}

struct PlanPromptView: View {
    let markdown: String
    let busy: Bool
    let enabled: Bool
    let onAnswer: (ChatAnswer) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            PromptHeader(symbol: "list.bullet.clipboard", eyebrow: "Plan", title: "Claude is ready to start with this plan")
            ScrollView {
                MarkdownText(markdown: markdown, font: .subheadline)
                    .textSelection(.enabled)
                    .padding(10)
            }
            .frame(maxHeight: 240)
            .fixedSize(horizontal: false, vertical: true)
            .background(Color(.tertiarySystemFill), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
            AnswerButtons(busy: busy) {
                Button { onAnswer(.deny(message: nil)) } label: {
                    Text("Keep planning").frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)
                Button { onAnswer(.approvePlan) } label: {
                    Text("Approve").bold().frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
            }
            .controlSize(.large)
            .disabled(!enabled || busy)
        }
    }
}
