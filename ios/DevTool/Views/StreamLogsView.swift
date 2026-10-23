import DevToolKit
import SwiftUI
import UIKit

/// The stream a Logs screen follows.
struct StreamLogsTarget: Hashable, Identifiable {
    var desktopId: String
    var projectId: String
    var streamId: String

    var id: String { "\(desktopId)/\(streamId)" }
}

// MARK: - Run status text

extension InboxStreamRun {
    /// "Running · 25m", "Exited with code 1 · 13m ago", "Stopped · 1h ago".
    func line(now: Date) -> String {
        let nowMs = now.unixMilliseconds
        func ago() -> String {
            guard let endedAt else { return "" }
            let ms = nowMs - endedAt
            return ms < 60_000 ? " · just now" : " · \(InboxClock.wait(ms)) ago"
        }
        switch status {
        case .running: return "Running · \(InboxClock.wait(nowMs - startedAt))"
        case .exited: return (exitCode.map { "Exited with code \($0)" } ?? "Exited") + ago()
        case .stopped: return "Stopped" + ago()
        }
    }

    /// Green while it runs, red when it exited with an error, grey otherwise.
    var color: Color {
        switch status {
        case .running: .green
        case .exited: exitCode == 0 ? .secondary : .red
        case .stopped: .secondary
        }
    }
}

/// A run's status dot: filled in its color, a ring when it hasn't run.
struct RunDot: View {
    let run: InboxStreamRun?

    var body: some View {
        Group {
            if let run {
                Circle().fill(run.color == .secondary ? Color.secondary.opacity(0.6) : run.color)
            } else {
                Circle().strokeBorder(Color.secondary.opacity(0.6), lineWidth: 1.5)
            }
        }
        .frame(width: 8, height: 8)
        .accessibilityHidden(true)
    }
}

/// Run when it isn't running; Stop and Restart while it is; a spinner while
/// one of them is in flight. Nothing without a command to run.
struct RunControls: View {
    @Environment(AppModel.self) private var model
    let target: StreamLogsTarget
    let stream: InboxStream
    /// Toolbar buttons rather than the stream row's borderless icons.
    var toolbar = false

    var body: some View {
        if stream.runCommand != nil {
            let offline = model.isOffline(target.desktopId)
            if model.pendingRun(streamId: stream.id, desktopId: target.desktopId) != nil {
                ProgressView()
                    .frame(width: 36, height: 28)
                    .accessibilityLabel("Working")
            } else if stream.run?.isRunning == true {
                button("Stop", systemImage: "stop.fill", tint: .red, action: .stop)
                    .disabled(offline)
                button("Restart", systemImage: "arrow.clockwise", tint: .accentColor, action: .restart)
                    .disabled(offline)
            } else {
                button("Run", systemImage: "play.fill", tint: .green, action: .start)
                    .disabled(offline)
            }
        }
    }

    private func button(_ title: String, systemImage: String, tint: Color, action: StreamRunParams.Action) -> some View {
        Button {
            Task { await model.controlRun(action, projectId: target.projectId, streamId: stream.id, desktopId: target.desktopId) }
        } label: {
            if toolbar {
                Label(title, systemImage: systemImage)
            } else {
                Image(systemName: systemImage)
                    .font(.body.weight(.semibold))
                    .frame(width: 36, height: 28)
                    .contentShape(Rectangle())
            }
        }
        .buttonStyle(.borderless)
        .tint(tint)
        .accessibilityLabel("\(title) app")
    }
}

/// A stream's app run in its project screen (§8.3, §8.19): status dot, the
/// command and how the run is doing, Run / Stop / Restart, and the row opens Logs.
struct StreamRunRow: View {
    let target: StreamLogsTarget
    let stream: InboxStream
    let now: Date
    let onLogs: () -> Void

    var body: some View {
        HStack(spacing: 10) {
            Button(action: onLogs) {
                HStack(spacing: 10) {
                    RunDot(run: stream.run)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(stream.runCommand ?? "App run")
                            .font(.subheadline.monospaced())
                            .lineLimit(1)
                            .truncationMode(.middle)
                        Text(stream.run?.line(now: now) ?? "Not running")
                            .font(.footnote)
                            .foregroundStyle(stream.run?.color ?? .secondary)
                            .lineLimit(1)
                    }
                    Spacer(minLength: 4)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityElement(children: .combine)
            .accessibilityHint("Opens the app's logs")
            RunControls(target: target, stream: stream)
            Image(systemName: "chevron.right")
                .font(.footnote.weight(.semibold))
                .foregroundStyle(.tertiary)
                .accessibilityHidden(true)
        }
        .padding(.vertical, 1)
    }
}

// MARK: - Logs screen

/// A stream's app run output (§8.19): monospaced, selectable, scrolled to the
/// end and kept there while new output arrives (unless you scrolled up). Asks
/// `stream.logs` again every 2 seconds while it is open and the desktop online.
struct StreamLogsView: View {
    @Environment(AppModel.self) private var model
    let target: StreamLogsTarget

    @State private var text = ""
    @State private var truncated = false
    @State private var loaded = false
    @State private var loadError: String?

    static let pollInterval: Duration = .seconds(2)

    var body: some View {
        let stream = currentStream
        content
            .safeAreaInset(edge: .top, spacing: 0) { notes }
            .navigationTitle("Logs")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .principal) {
                    TimelineView(.periodic(from: .now, by: 30)) { context in
                        VStack(spacing: 0) {
                            Text(stream.map { $0.name.isEmpty ? "Logs" : "\($0.name) logs" } ?? "Logs")
                                .font(.headline)
                                .lineLimit(1)
                            HStack(spacing: 5) {
                                RunDot(run: stream?.run)
                                Text(stream?.run?.line(now: context.date) ?? "Not running")
                                    .lineLimit(1)
                            }
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        }
                        .accessibilityElement(children: .combine)
                    }
                }
                if let stream {
                    ToolbarItemGroup(placement: .topBarTrailing) {
                        RunControls(target: target, stream: stream, toolbar: true)
                    }
                }
                ToolbarItem(placement: .secondaryAction) {
                    Button("Copy all", systemImage: "doc.on.doc") { UIPasteboard.general.string = text }
                        .disabled(text.isEmpty)
                }
            }
            .task(id: model.isOffline(target.desktopId)) { await poll() }
            // A new run starts with fresh output: fetch it now rather than on the next tick.
            .onChange(of: stream?.run?.startedAt) { _, _ in
                Task { await load() }
            }
    }

    private var currentStream: InboxStream? {
        model.inboxes[target.desktopId]?.projects.first { $0.id == target.projectId }?.streams.first { $0.id == target.streamId }
    }

    @ViewBuilder
    private var content: some View {
        if !text.isEmpty {
            LogTextView(text: text)
                .ignoresSafeArea(.container, edges: .bottom)
        } else if !loaded {
            if let loadError {
                ContentUnavailableView("Couldn't load the logs", systemImage: "exclamationmark.triangle", description: Text(loadError))
            } else {
                ProgressView()
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        } else {
            ContentUnavailableView("No output yet", systemImage: "terminal",
                                   description: Text(currentStream?.run == nil ? "Run the app to see its output here." : "The app hasn't printed anything."))
        }
    }

    @ViewBuilder
    private var notes: some View {
        let offline = model.isOffline(target.desktopId)
        if truncated || offline || (loadError != nil && !text.isEmpty) {
            VStack(alignment: .leading, spacing: 2) {
                if offline {
                    Label("Desktop offline: showing the output last fetched", systemImage: "wifi.slash")
                } else if let loadError, !text.isEmpty {
                    Label(loadError, systemImage: "exclamationmark.triangle")
                }
                if truncated {
                    Label("Showing the last part of the log", systemImage: "scissors")
                }
            }
            .font(.footnote)
            .foregroundStyle(.secondary)
            .lineLimit(2)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 16)
            .padding(.vertical, 6)
            .background(.bar)
        }
    }

    /// Fetches now, then every `pollInterval` until the screen goes away or the desktop goes offline.
    private func poll() async {
        guard !model.isOffline(target.desktopId) else { return }
        while !Task.isCancelled {
            await load()
            guard (try? await Task.sleep(for: Self.pollInterval)) != nil else { return }
        }
    }

    private func load() async {
        do {
            let result = try await model.runLogs(projectId: target.projectId, streamId: target.streamId, desktopId: target.desktopId)
            guard !Task.isCancelled else { return }
            if result.text != text { text = result.text }
            truncated = result.truncated
            loadError = nil
            loaded = true
        } catch is CancellationError {
        } catch {
            loadError = error.localizedDescription
        }
    }
}

/// Read-only, selectable monospaced text that starts at its end and follows
/// new output while it is scrolled to the bottom. A `UITextView`, so 200k
/// characters of log stay smooth to scroll and select.
struct LogTextView: UIViewRepresentable {
    let text: String

    func makeUIView(context: Context) -> FollowingTextView {
        let view = FollowingTextView(usingTextLayoutManager: false)
        view.isEditable = false
        view.isSelectable = true
        view.dataDetectorTypes = []
        view.alwaysBounceVertical = true
        view.backgroundColor = .systemBackground
        view.textColor = .label
        view.font = .monospacedSystemFont(ofSize: 12, weight: .regular)
        view.adjustsFontForContentSizeCategory = true
        view.textContainerInset = UIEdgeInsets(top: 10, left: 8, bottom: 24, right: 8)
        view.delegate = context.coordinator
        view.accessibilityLabel = "Log"
        return view
    }

    func updateUIView(_ view: FollowingTextView, context: Context) {
        guard view.text != text else { return }
        let follow = context.coordinator.pinned
        context.coordinator.updating = true
        view.text = text
        context.coordinator.updating = false
        if follow { view.scrollToEnd() }
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    final class Coordinator: NSObject, UITextViewDelegate {
        /// At the bottom: new output scrolls into view.
        var pinned = true
        var updating = false

        func scrollViewDidScroll(_ scrollView: UIScrollView) {
            guard !updating, let view = scrollView as? FollowingTextView, !view.pendingScrollToEnd else { return }
            pinned = view.isAtEnd
        }
    }
}

final class FollowingTextView: UITextView {
    /// Set until a laid-out pass has scrolled to the end (the first one has no height yet).
    private(set) var pendingScrollToEnd = false

    var isAtEnd: Bool {
        contentOffset.y + bounds.height - adjustedContentInset.bottom >= contentSize.height - 24
    }

    func scrollToEnd() {
        pendingScrollToEnd = true
        setNeedsLayout()
        layoutIfNeeded()
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        guard pendingScrollToEnd, bounds.height > 0 else { return }
        layoutManager.ensureLayout(for: textContainer)
        let bottom = contentSize.height - bounds.height + adjustedContentInset.bottom
        setContentOffset(CGPoint(x: 0, y: max(-adjustedContentInset.top, bottom)), animated: false)
        pendingScrollToEnd = false
    }
}
