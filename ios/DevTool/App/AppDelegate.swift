import DevToolKit
import OSLog
import UIKit
import UserNotifications

/// Owns the app model and push, and handles APNs and notification callbacks.
/// Created before any scene, so a notification action that launches the app
/// in the background finds the model ready.
@MainActor
final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    let model: AppModel
    let push: PushManager
    let security: SecuritySettings
    private let log = Logger(subsystem: "sk.awantech.devtool", category: "notifications")

    override init() {
        let options = LaunchOptions.current
        if options.mockDesktop {
            model = AppModel.mock(offlineIsServer: options.mockServer)
            // Mock mode keeps its switches apart from the real ones.
            let defaults = UserDefaults(suiteName: "sk.awantech.devtool.mock") ?? .standard
            push = PushManager(live: false, identity: DeviceIdentity.generate(), options: options, defaults: defaults,
                               keys: PushKeyStore(store: InMemorySecretStore()))
            security = SecuritySettings(authenticator: Self.mockAuthenticator(options.mockAuth), defaults: defaults)
        } else {
            let identity = Self.loadIdentity()
            let store = FileAppStore()
            model = AppModel(factory: Self.relayFactory(identity: identity), store: store, chatCache: store.chatCache)
            push = PushManager(live: true, identity: identity, options: options)
            security = SecuritySettings(authenticator: LocalAuthenticator())
        }
        super.init()
        model.push = push
        model.security = security
        push.model = model
        push.security = security
        security.onChange = { [weak push] in push?.updateCategories() }
    }

    private static func mockAuthenticator(_ mode: String?) -> any DeviceOwnerAuthenticator {
        switch mode {
        case "real": LocalAuthenticator()
        case "cancel": MockAuthenticator(outcome: .cancelled)
        case "fail": MockAuthenticator(outcome: .failed("Face ID didn't recognise you (mock)."))
        default: MockAuthenticator()
        }
    }

    private static func loadIdentity() -> DeviceIdentity {
        do {
            return try DeviceIdentity.loadOrCreate()
        } catch {
            // Without the Keychain nothing can stay paired; run with a
            // throwaway identity rather than not at all.
            Logger(subsystem: "sk.awantech.devtool", category: "identity")
                .error("Keychain unavailable, using a temporary identity: \(error.localizedDescription, privacy: .public)")
            return DeviceIdentity.generate()
        }
    }

    /// Real connections through the relay, with this phone's Keychain identity.
    private static func relayFactory(identity: DeviceIdentity) -> RelayDesktopConnectionFactory {
        let version = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0.0.0"
        return RelayDesktopConnectionFactory(
            identity: identity,
            deviceName: UIDevice.current.name,
            appVersion: "ios/\(version)"
        )
    }

    // MARK: UIApplicationDelegate

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        push.start()
        InboxSettings.dropRetiredKeys()
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        push.didRegister(deviceToken: deviceToken)
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: any Error) {
        push.didFailToRegister(error)
    }

    // MARK: UNUserNotificationCenterDelegate

    /// What a notification points at, read from its `userInfo`.
    private struct Target: Sendable {
        var desktop: String
        var tab: String
        var prompt: String?

        init?(_ userInfo: [AnyHashable: Any]) {
            guard let desktop = userInfo[Push.UserInfoKey.desktop] as? String,
                  let tab = userInfo[Push.UserInfoKey.tab] as? String else { return nil }
            self.desktop = desktop
            self.tab = tab
            prompt = userInfo[Push.UserInfoKey.prompt] as? String
        }

        var route: ChatRoute { ChatRoute(desktopId: desktop, tabId: tab) }
    }

    /// Foreground: a banner and sound, unless that exact chat is on screen.
    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping @Sendable (UNNotificationPresentationOptions) -> Void
    ) {
        let target = Target(notification.request.content.userInfo)
        Task { @MainActor in
            if let target, self.model.visibleChat == target.route, UIApplication.shared.applicationState == .active {
                completionHandler([])
            } else {
                completionHandler([.banner, .list, .sound])
            }
        }
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping @Sendable () -> Void
    ) {
        let action = response.actionIdentifier
        let target = Target(response.notification.request.content.userInfo)
        Task { @MainActor in
            await self.handle(action: action, target: target)
            completionHandler()
        }
    }

    private func handle(action: String, target: Target?) async {
        guard let target else { return }
        switch action {
        case NotificationCategories.allowAction, NotificationCategories.denyAction:
            guard let prompt = target.prompt else { return }
            let allow = action == NotificationCategories.allowAction
            if security.requireAuthForApprovals {
                await answerAfterAuthenticating(target: target, prompt: prompt, allow: allow)
            } else {
                await answer(target: target, prompt: prompt, allow: allow)
            }
        case UNNotificationDefaultActionIdentifier:
            model.requestedChat = target.route
        default:
            break // dismissed
        }
    }

    /// Allow / Deny from the notification (§7.7): the app runs in the
    /// background, so it holds a background task while it connects and answers.
    private func answer(target: Target, prompt: String, allow: Bool) async {
        let log = log
        var taskId = UIBackgroundTaskIdentifier.invalid
        taskId = UIApplication.shared.beginBackgroundTask(withName: "answer-prompt") {
            log.notice("Background time ran out while answering a prompt")
        }
        defer { if taskId != .invalid { UIApplication.shared.endBackgroundTask(taskId) } }
        let ok = await model.answerFromNotification(
            desktopId: target.desktop, tabId: target.tab, promptId: prompt, allow: allow,
            deadline: .now + .seconds(25)
        )
        if ok {
            log.notice("Answered \(prompt, privacy: .public) from a notification (\(allow ? "allow" : "deny", privacy: .public))")
        } else {
            log.error("Couldn't answer \(prompt, privacy: .public) from a notification")
            await notifyAnswerFailed(target: target)
        }
    }

    /// "Require Face ID for approvals" is on (§8.3): the actions carry
    /// `.foreground`, so the app is coming up. Authenticate once it is active,
    /// then answer, and show the chat either way. An action that still
    /// arrives in the background (categories registered before the switch)
    /// can't authenticate, so it only posts "open the chat to answer".
    private func answerAfterAuthenticating(target: Target, prompt: String, allow: Bool) async {
        for _ in 0..<30 where UIApplication.shared.applicationState != .active {
            try? await Task.sleep(for: .milliseconds(100))
        }
        guard UIApplication.shared.applicationState == .active else {
            log.notice("Can't authenticate a notification answer in the background")
            await notifyAnswerFailed(target: target)
            return
        }
        model.requestedChat = target.route
        switch await security.authorizeAnswer() {
        case .success:
            await answer(target: target, prompt: prompt, allow: allow)
        case .cancelled:
            log.notice("Authentication for a notification answer was cancelled")
        case .failed(let message):
            log.error("Authentication for a notification answer failed: \(message, privacy: .public)")
        }
    }

    /// Tells the user the answer didn't go through; tapping it opens the chat.
    private func notifyAnswerFailed(target: Target) async {
        let content = UNMutableNotificationContent()
        content.title = model.desktop(target.desktop)?.name ?? "DevTool"
        content.body = "Couldn't send your answer. Open the chat to try again."
        content.userInfo = [Push.UserInfoKey.desktop: target.desktop, Push.UserInfoKey.tab: target.tab]
        content.threadIdentifier = target.tab
        let request = UNNotificationRequest(identifier: "answer-failed-\(target.tab)", content: content, trigger: nil)
        try? await UNUserNotificationCenter.current().add(request)
    }
}
