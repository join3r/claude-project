import Foundation

/// Launch arguments and environment switches.
///
/// - `-mockDesktop` (or env `DEVTOOL_MOCK_DESKTOP=1`): preload two mock paired
///   desktops (one online, one offline) and keep all state in memory, so the
///   UI can be exercised and screenshotted without a relay.
/// - `-demoRoute sidebar|desktop|project|task|taskStatus|pair|pairConfirm|pairWait|settings`
///   (Debug builds, with `-mockDesktop`): open a screen directly, for screenshots.
/// - `-demoRoute project|newStream|newTask [-demoProject <projectId>]`: the first
///   desktop's first project (or `-demoProject`), with the New stream sheet or
///   (on its last stream) the New task sheet up.
/// - `-demoRoute taskInfo [-demoTab <tabId>]`: as `chat`, with the task info sheet up.
/// - `-demoRoute task [-demoTask <taskId>] [-demoCloseTask]`: that task's screen
///   (the first task without `-demoTask`); `-demoCloseTask` then sends it
///   `task.close`, so a worktree task's landing banner shows (mock: `t-auth`
///   conflicts, `t-cache` is blocked).
/// - `-demoRoute chat [-demoTab <tabId>]` (Debug builds): open a claude-chat tab
///   (the first one that needs attention when `-demoTab` is absent). Works
///   against mock and real desktops. With `-demoToolDetail <itemId>` the item's
///   detail sheet opens too. `-demoChatScript` then sends `-demoMessage <text>`
///   (default "Hello from the phone") and answers each prompt after
///   `-demoAnswerDelay <seconds>` (default 6): Allow, the first option(s), Approve.
///   `-demoComposerText <text>` puts text in the composer (`/` shows the command
///   menu), and `-demoCommandSheet btw|permissions` opens that sheet (`btw` asks
///   `-demoMessage`, or a canned question).
/// - `-pairLink <devtool://pair?d=…>` (Debug builds): open that pairing link at
///   launch, as if tapped; add `-autoConfirmPairing` to also press Pair. Lets
///   scripts pair the simulator without the system "Open in DevTool?" prompt.
/// - `-pushGateway <url>` (or env `DEVTOOL_PUSH_GATEWAY`; Debug builds): the push
///   gateway to register with (SPEC.md §7.1) instead of
///   `https://relay.devtool.awantech.sk`, e.g. `http://127.0.0.1:8791`.
/// - `-fakePushToken <hex>` (or env `DEVTOOL_FAKE_PUSH_TOKEN`; Debug builds): skip
///   APNs and register this device token (32–100 bytes of lowercase hex). The
///   simulator can't get a token APNs accepts for our topic, but a gateway in
///   simctl mode ignores it, so the whole chain can run on a simulator.
/// - `-mockAuth succeed|cancel|fail|real` (with `-mockDesktop`): what "Require
///   Face ID for approvals" does in mock mode. The default `succeed` passes
///   after a short pause without a prompt; `cancel` and `fail` refuse; `real`
///   uses `LAContext` (enrol Face ID under Features → Face ID in the Simulator).
struct LaunchOptions: Sendable {
    enum DemoRoute: String, Sendable {
        case sidebar
        /// The first desktop's screen (Pinned, Active, Quiet projects).
        case desktop
        /// Same as `desktop` (its name before the project screen).
        case projects
        /// The first desktop's first project.
        case project
        /// `project` with the New stream sheet up.
        case newStream
        /// `project` with the New task sheet up, on the project's last stream.
        case newTask
        /// The first task of the first desktop.
        case task
        /// The first terminal agent's task: its status screen.
        case taskStatus
        /// A claude-chat tab (as `chat`) with the task info sheet up.
        case taskInfo
        case pair
        case settings
        /// Confirm step for a canned invite.
        case pairConfirm
        /// Confirm a canned invite and show the waiting step (mock accepts after 2 s).
        case pairWait
        /// A claude-chat tab (`-demoTab`).
        case chat
    }

    var mockDesktop: Bool
    var demoRoute: DemoRoute?
    var pairLink: String?
    var autoConfirmPairing = false
    var demoTab: String?
    var demoTask: String?
    var demoCloseTask = false
    var demoProject: String?
    var demoToolDetail: String?
    var demoChatScript = false
    var demoMessage: String?
    var demoAnswerDelay: Double?
    var demoComposerText: String?
    var demoCommandSheet: String?
    var pushGateway: URL?
    var fakePushToken: String?
    var mockAuth: String?

    static let current = LaunchOptions(processInfo: .processInfo)

    init(processInfo: ProcessInfo) {
        let args = processInfo.arguments
        let env = processInfo.environment
        mockDesktop = args.contains("-mockDesktop") || env["DEVTOOL_MOCK_DESKTOP"] == "1"
        if let index = args.firstIndex(of: "-mockAuth"), index + 1 < args.count {
            mockAuth = args[index + 1]
        }

        #if DEBUG
        if let index = args.firstIndex(of: "-demoRoute"), index + 1 < args.count {
            demoRoute = DemoRoute(rawValue: args[index + 1])
        } else {
            demoRoute = env["DEVTOOL_DEMO_ROUTE"].flatMap(DemoRoute.init(rawValue:))
        }
        if let index = args.firstIndex(of: "-pairLink"), index + 1 < args.count {
            pairLink = args[index + 1]
        }
        autoConfirmPairing = args.contains("-autoConfirmPairing")
        func value(_ flag: String) -> String? {
            guard let index = args.firstIndex(of: flag), index + 1 < args.count else { return nil }
            return args[index + 1]
        }
        demoTab = value("-demoTab")
        demoTask = value("-demoTask")
        demoCloseTask = args.contains("-demoCloseTask")
        demoProject = value("-demoProject")
        demoToolDetail = value("-demoToolDetail")
        demoChatScript = args.contains("-demoChatScript")
        demoMessage = value("-demoMessage")
        demoAnswerDelay = value("-demoAnswerDelay").flatMap(Double.init)
        demoComposerText = value("-demoComposerText")
        demoCommandSheet = value("-demoCommandSheet")
        pushGateway = (value("-pushGateway") ?? env["DEVTOOL_PUSH_GATEWAY"]).flatMap { URL(string: $0) }
        fakePushToken = (value("-fakePushToken") ?? env["DEVTOOL_FAKE_PUSH_TOKEN"])?.lowercased()
        #else
        demoRoute = nil
        #endif
    }
}
