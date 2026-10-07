import DevToolKit
import SwiftUI
import UIKit

struct SettingsView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let onPair: () -> Void

    @State private var pendingForget: DesktopRecord?

    var body: some View {
        NavigationStack {
            List {
                Section {
                    ForEach(model.desktops) { desktop in
                        PairedDesktopRow(desktop: desktop)
                            .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                                Button("Forget", role: .destructive) { pendingForget = desktop }
                            }
                            .contextMenu {
                                Button("Forget", systemImage: "trash", role: .destructive) { pendingForget = desktop }
                            }
                    }
                    Button("Pair a desktop", systemImage: "plus.circle", action: onPair)
                } header: {
                    Text("Paired desktops")
                } footer: {
                    Text("Forgetting removes the desktop from this device. To cut off access completely, also revoke this device in DevTool → Settings → Mobile.")
                }

                NotificationsSection()

                SecuritySection()

                Section("About") {
                    LabeledContent("Version", value: Self.version)
                }
            }
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .confirmationDialog(
                pendingForget.map { "Forget \($0.name)?" } ?? "",
                isPresented: Binding(get: { pendingForget != nil }, set: { if !$0 { pendingForget = nil } }),
                titleVisibility: .visible,
                presenting: pendingForget
            ) { desktop in
                Button("Forget", role: .destructive) { model.forget(desktop.id) }
            } message: { _ in
                Text("You'll need to scan a new pairing code to see it again.")
            }
        }
    }

    static var version: String {
        let info = Bundle.main.infoDictionary
        let short = info?["CFBundleShortVersionString"] as? String ?? "?"
        let build = info?["CFBundleVersion"] as? String ?? "?"
        return "\(short) (\(build))"
    }
}

/// "Require Face ID for approvals" (SPEC.md §8.3), named after what the
/// device would use. Hidden when the device has no passcode (unless it is on).
private struct SecuritySection: View {
    @Environment(SecuritySettings.self) private var security
    @State private var changing = false

    var body: some View {
        if security.canOffer {
            Section {
                Toggle(isOn: Binding(get: { security.requireAuthForApprovals }, set: { on in
                    changing = true
                    Task {
                        await security.setRequireAuth(on)
                        changing = false
                    }
                })) {
                    Label("Require \(methodName) for approvals", systemImage: security.method?.symbol ?? "lock")
                }
                .disabled(changing)
            } header: {
                Text("Security")
            } footer: {
                Text(footer)
            }
        }
    }

    private var methodName: String {
        security.method?.name ?? "authentication"
    }

    private var footer: String {
        if security.method == nil {
            return "Set a passcode in iOS Settings to use this, or turn it off."
        }
        return "Ask for \(methodName) before answering a permission request, question or plan. Allow and Deny on a notification then open the app first."
    }
}

/// Master switch plus one toggle per push kind (SPEC.md §7.7).
private struct NotificationsSection: View {
    @Environment(PushManager.self) private var push
    @Environment(\.openURL) private var openURL

    var body: some View {
        Section {
            Toggle("Notifications", isOn: Binding(get: { push.enabled }, set: { push.setEnabled($0) }))
            if push.enabled {
                kindToggle("Permission requests", .permission)
                kindToggle("Questions & plans", .question)
                kindToggle("Finished turns", .done)
            }
        } header: {
            Text("Notifications")
        } footer: {
            footer
        }
    }

    private func kindToggle(_ title: String, _ kind: PushKind) -> some View {
        Toggle(title, isOn: Binding(get: { push.isOn(kind) }, set: { push.set(kind, on: $0) }))
            .disabled(push.isDenied)
    }

    @ViewBuilder
    private var footer: some View {
        if push.enabled, push.isDenied {
            VStack(alignment: .leading, spacing: 6) {
                Text("Notifications are turned off for DevTool in iOS Settings.")
                Button("Open Settings") {
                    if let url = URL(string: UIApplication.openNotificationSettingsURLString) { openURL(url) }
                }
                .font(.footnote)
            }
        } else if push.enabled, let error = push.lastError {
            Text(error)
        } else {
            Text("Get notified when an agent asks for permission, asks a question or presents a plan, and when a turn you started here finishes. Only this phone can read them.")
        }
    }
}

private struct PairedDesktopRow: View {
    @Environment(AppModel.self) private var model
    let desktop: DesktopRecord

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 8) {
                Circle()
                    .fill(model.state(of: desktop.id).dotColor)
                    .frame(width: 8, height: 8)
                Text(desktop.name)
            }
            Text(detail)
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .accessibilityElement(children: .combine)
    }

    private var detail: String {
        let relay = desktop.relayURL.host() ?? desktop.relayURL.absoluteString
        let paired = desktop.pairedAt.formatted(date: .abbreviated, time: .omitted)
        return "\(relay) · paired \(paired)"
    }
}
