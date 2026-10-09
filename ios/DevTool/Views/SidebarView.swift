import DevToolKit
import SwiftUI

struct SidebarView: View {
    @Environment(AppModel.self) private var model
    @Binding var selection: SidebarSelection?
    let onSettings: () -> Void
    let onPair: () -> Void

    var body: some View {
        List(selection: $selection) {
            Label("Inbox", systemImage: "tray")
                .badge(model.inboxPartition(now: Date()).unreadCount)
                .tag(SidebarSelection.inbox)
            if model.desktops.count > 1 {
                Label("All desktops", systemImage: "square.stack.3d.up")
                    .badge(model.desktops.reduce(0) { $0 + model.attentionCount(for: $1.id) })
                    .tag(SidebarSelection.all)
            }
            Section("Desktops") {
                ForEach(model.desktops) { desktop in
                    DesktopRow(desktop: desktop)
                        .badge(model.attentionCount(for: desktop.id))
                        .tag(SidebarSelection.desktop(desktop.id))
                }
            }
        }
        .navigationTitle("DevTool")
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                Button("Settings", systemImage: "gear", action: onSettings)
            }
            ToolbarItem(placement: .topBarTrailing) {
                Button("Pair a desktop", systemImage: "plus", action: onPair)
            }
        }
    }
}

struct DesktopRow: View {
    @Environment(AppModel.self) private var model
    let desktop: DesktopRecord

    var body: some View {
        let state = model.state(of: desktop.id)
        HStack(spacing: 12) {
            // A DevTool server shows its rack where a desktop shows the computer.
            Image(systemName: desktop.isServer ? "server.rack" : "desktopcomputer")
                .font(.title3)
                .foregroundStyle(.secondary)
                .overlay(alignment: .bottomTrailing) {
                    Circle()
                        .fill(state.dotColor)
                        .frame(width: 9, height: 9)
                        .overlay(Circle().stroke(Color(.systemBackground), lineWidth: 1.5))
                        .offset(x: 3, y: 2)
                }
                .accessibilityLabel(desktop.isServer ? "Server" : "")
                .accessibilityHidden(!desktop.isServer)
            VStack(alignment: .leading, spacing: 2) {
                Text(desktop.name)
                Text(state.summary(lastSeen: desktop.lastSeen))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .accessibilityElement(children: .combine)
    }
}

extension ConnectionState {
    var dotColor: Color {
        switch self {
        case .online: .green
        case .connecting, .handshaking, .awaitingApproval: .yellow
        case .revoked, .incompatible, .unknownDevice, .failed: .red
        case .offline, .idle: .gray
        }
    }

    func summary(lastSeen: Date?) -> String {
        switch self {
        case .online: return "Online"
        case .idle, .connecting, .handshaking: return "Connecting…"
        case .awaitingApproval: return "Waiting for approval"
        case .offline(let seen):
            guard let date = seen ?? lastSeen else { return "Offline" }
            return "Last seen \(date.lastSeenText)"
        case .revoked: return "Access revoked"
        case .incompatible(let updateDesktop): return updateDesktop ? "Update DevTool" : "Update the app"
        case .unknownDevice: return "Pair again"
        case .failed(let message): return message
        }
    }
}

extension Date {
    /// "14:02" today, "Yesterday 14:02", otherwise "3 Sep 14:02".
    var lastSeenText: String {
        let time = formatted(date: .omitted, time: .shortened)
        let calendar = Calendar.current
        if calendar.isDateInToday(self) { return time }
        if calendar.isDateInYesterday(self) { return "yesterday \(time)" }
        return formatted(.dateTime.day().month(.abbreviated).hour().minute())
    }
}
