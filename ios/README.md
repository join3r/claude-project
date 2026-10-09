# DevTool for iOS

The SwiftUI iPhone and iPad client for DevTool (pairing, inbox, chat, push notifications, and from M4 new tasks, Face ID for approvals and offline transcripts). The wire protocol is specified in [`protocol/SPEC.md`](../protocol/SPEC.md).

```
ios/
  project.yml            xcodegen spec (the .xcodeproj is generated and gitignored)
  DevTool/               app target: App/ (model, persistence, push, launch options), Views/, Chat/, Pairing/
  DevToolNotifications/  Notification Service Extension: decrypts pushes (SPEC.md §7.5)
  DevToolKit/            Swift package: protocol models, crypto, relay client, push, Keychain helper
```

`DevToolKit` holds everything that can be tested without a simulator:

- `Models/`: `PairingInvite` (parses and validates `devtool://pair?d=…`), `Inbox` and its parts, `Base64URL` (strict), `DeviceId`
- `Crypto/`: CryptoKit-only primitives (X25519, Ed25519, SHA-256, HKDF, HMAC, AES-256-GCM with the Noise nonce, big-endian counter), `Noise_IK_25519_AESGCM_SHA256` (`CipherState`, `SymmetricState`, `HandshakeState` initiator and responder, `NoiseTransport`), and `DeviceIdentity` (keys generated on first launch, raw private keys in the Keychain)
- `Protocol/`: relay messages (§3), frame envelope (§4.1), handshake payloads and app messages (§4.3–4.4) with the same tolerant parsing as `protocol/ts`, version negotiation, pairing-secret derivations. `JSONValue` serializes like `JSON.stringify`, so encoded messages match the TS bytes.
- `Relay/`: `RelayClient` (one `URLSessionWebSocketTask` per relay: challenge → hello, watch, ping every 25 s, reconnect with 1 s → 30 s backoff), `RelayHub` (one client per relay URL), `RelayDesktopConnection` (Noise handshake as initiator, `inbox.get`, inbox and pairing events) and `RelayDesktopConnectionFactory`
- `Connection/`: the `DesktopConnection` / `DesktopConnectionFactory` protocols the app depends on, plus `MockDesktopConnection`
- `Push/`: push crypto (§7.5 payloads, §7.1 registration signing), `PushGatewayClient` (`POST /v1/push/register`), `PushKeyStore` (per-desktop push keys, shared with the extension) and the `push.register` / `push.unregister` ops (§7.4)
- `Storage/ChatCache`: `CachedChat` (a chat's last transcript, at most 60 items) and the file / in-memory `ChatCacheStore`s (§8.3)
- `Storage/KeychainStore`: raw key bytes by label (`kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`), optionally in a shared access group

### One socket per relay

The relay allows one connection per device ID and closes the older one (4409) when another arrives (§3.5). A phone paired with several desktops on one relay therefore shares a single `RelayClient`: each `RelayDesktopConnection` subscribes with its desktop ID, and the client routes `frame`/`peer`/`error` by `from`/`id`/`to`. A `hello` can carry only one `pair` token, so when a pairing starts while the socket is already up, the client reconnects with the token and the other desktops simply handshake again (they do on every reconnect anyway).

## Requirements

- Xcode 16 or newer (built with Xcode 27 / Swift 6.4), iOS 17+ deployment target
- [xcodegen](https://github.com/yonaskolb/XcodeGen): `brew install xcodegen`

## Generate and build

```bash
cd ios
xcodegen generate                     # re-run after adding/removing files or editing project.yml
open DevTool.xcodeproj                # or build from the command line:
xcodebuild -project DevTool.xcodeproj -scheme DevTool \
  -destination 'generic/platform=iOS Simulator' -configuration Debug \
  build CODE_SIGNING_ALLOWED=NO
```

Signing is automatic with team `AX23G9CAL9` (set in `project.yml` for both targets). The App IDs `sk.awantech.devtool` (Push Notifications, App Groups) and `sk.awantech.devtool.notifications` (App Groups), and the App Group `group.sk.awantech.devtool`, are registered in the developer portal. `CODE_SIGNING_ALLOWED=NO` still builds for the simulator without an Apple account.

## Run on the simulator

```bash
cd ios
xcodebuild -project DevTool.xcodeproj -scheme DevTool \
  -destination 'generic/platform=iOS Simulator' -derivedDataPath build/DerivedData \
  build CODE_SIGNING_ALLOWED=NO
SIM=$(xcrun simctl list devices available | grep -m1 'iPhone 17 (' | grep -oE '[0-9A-F-]{36}')
xcrun simctl boot "$SIM"; open -a Simulator
xcrun simctl install "$SIM" build/DerivedData/Build/Products/Debug-iphonesimulator/DevTool.app
xcrun simctl launch "$SIM" sk.awantech.devtool -mockDesktop
```

That unsigned build runs, but the App Group entitlement is missing, so push keys fall back to the app's own keychain group and the notification extension can't decrypt (see Push notifications). Leave out `CODE_SIGNING_ALLOWED=NO` to sign ad hoc ("Sign to Run Locally") with the entitlements.

The simulator has no camera. Pair by pasting a link into **Paste pairing link**, or open one directly with `xcrun simctl openurl booted 'devtool://pair?d=…'`. The app registers the `devtool` URL scheme, so scanning the QR code with the system Camera app on a device opens it too.

## Mock mode

`-mockDesktop` (launch argument) or `DEVTOOL_MOCK_DESKTOP=1` (environment; with `simctl launch`, use `SIMCTL_CHILD_DEVTOOL_MOCK_DESKTOP=1`) preloads two paired desktops and keeps all state in memory:

- **join3r-mbp** is online. It serves a canned inbox with streams (*api-server* has `main`, the worktree stream `0.5.0` and `bugfixes`; a stream pin and a task pin) and flips one agent tab's status every 4 seconds. It lists `task.new`, `chat.settings`, `task.close`, `tab.close`, `chat.image`, `pin`, `task.triage`, `stream.new`, `branches.list` and `chat.commands` (the *fix-auth* chat has a screenshot tool row with two generated images), so project screens show **New stream** in the toolbar and a **+** on each stream that starts a task on a first prompt. *dotfiles* stands in for a shell-command project: `branches.list` answers `unsupported`, so its New stream sheet offers only the project folder. Tasks and tabs can be closed; a working task asks before it closes. It also lists `task.land`: *fix-auth* and *cache-headers* in `0.5.0` have worktrees of their own. Closing *fix-auth* stops on a conflict and shows the landing banner. Abort clears the conflict, Retry finds it again, and Ask agent to fix lands the task and closes it 3 s later. *cache-headers* starts blocked by local changes in `0.5.0`, and Retry lands it. `-demoRoute task -demoTask t-auth -demoCloseTask` opens fix-auth and closes it, so the conflict banner comes up without any taps. Its inbox starts with two unread tasks, one settled (*openapi-docs*) and one snoozed for three hours (*login-redesign*), and a tab turning to attention makes its task unread again.
- **studio-mini** is offline. It shows a cached inbox, dimmed, under the "offline · last seen" banner. Its *benchmark-suite* task has a Claude chat with a cached transcript, which opens read-only.

"Require Face ID for approvals" in mock mode uses a stand-in that always offers Face ID and passes after 0.4 s without a prompt. `-mockAuth cancel` or `-mockAuth fail` makes it refuse, and `-mockAuth real` uses `LAContext` (enrol under Features → Face ID in the Simulator). Mock mode keeps the switch in the `sk.awantech.devtool.mock` defaults suite.

The Xcode scheme passes `-mockDesktop` by default. Untick it under Product → Scheme → Edit Scheme → Arguments to use real, persisted pairings through the relay in the pairing link. In mock mode pairing runs against the mock and auto-accepts after 2 seconds.

## Against a local relay

```bash
cd relay && npm install && npm start                          # ws://localhost:8787
node protocol/tools/fake-desktop.ts ws://localhost:8787       # prints a devtool://pair link
xcrun simctl launch "$SIM" sk.awantech.devtool                # without -mockDesktop
xcrun simctl openurl "$SIM" 'devtool://pair?d=…'
```

Debug builds also accept `-pairLink '<devtool://pair?d=…>' [-autoConfirmPairing]` to open (and confirm) a pairing link at launch, which skips the system "Open in DevTool?" prompt in scripted runs, and `-demoRoute <route>` for screenshots: `desktop`, `project`, `newStream` and `newTask` (with `-demoProject <id>`), `task`, `taskStatus`, `taskInfo`, `chat` (with `-demoTab <id>`), `pair` (pairing sheet), `pairConfirm`, `pairWait`, `settings`, `sidebar`. With `chat`, `-demoComposerText '/'` opens the `/` menu and `-demoCommandSheet btw|permissions` opens that sheet. `LaunchOptions.swift` lists them all.

## New task, Face ID and offline (M4)

SPEC.md §8 is the contract.

- **Features:** the desktop's hello lists optional ops in `features` (§8.1). Each `.online` is preceded by a `.features` connection event, and the app keeps the list on the `DesktopRecord` (`desktops.json`), so an offline desktop keeps showing what it could do.
- **One agent per task:** `chat.new` is retired (§8.2): a task opens straight on its conversation (`TaskScreen`: `ChatScreen` for a Claude chat, else a status screen), and a second conversation is a new task. Terminals and browsers in the task are listed under **Also open in this task** in the task info sheet.
- **Chat controls:** above the composer, `ChatControlsBar` (`Chat/ChatControls.swift`) shows the desktop composer's permission mode, model and effort menus and the plan-limit meter (5-hour bar over the weekly one, then the 5-hour countdown). Tapping the meter shows each window's use and reset time, the context and the session cost. Picking a value sends `chat.settings`, and the chip changes when the next `evt chat` brings it back. The menus are read-only offline or for a desktop that doesn't list `chat.settings`. A desktop that sends neither `settings` nor `usage` gets no bar, and the subtitle shows the mode as before.
- **`/` commands:** for a desktop that lists `chat.commands` (§8.14), typing `/` and a word in the composer shows the matching commands above it (`Chat/SlashCommands.swift`), fetched once per open chat and ranked as the desktop composer ranks them. Tapping one puts `/name ` in the composer; terminal-only commands are greyed out, and sending one only shows a notice. `/btw <question>` opens a sheet with Claude's answer, which stays out of the conversation, and `/permissions` opens the allow, ask and deny rules editor (read-only offline; a remote project shows the desktop's message). The mock lists built-ins, two skills and two terminal-only commands, answers `/btw` after a pause and keeps permission rules in memory. Against an older desktop the composer sends `/` text like any other.
- **Streams (protocol v2, SPEC.md §9):** a project's tasks are grouped by stream under a header row (name and branch; long-press for **New task in …** and Pin), and rows outside a project's own screen lead with `project › stream` (the stream left out on `main`). A version 1 desktop answers `incompatible` and the app asks to update DevTool there; a version 1 app paired with a new desktop is told to update itself, and the desktop's Mobile settings say "Update DevTool on your iPhone".
- **New task:** for a desktop that lists `task.new`, each stream on the project screen has a **+**, and the Inbox has a compose button. Both open `NewTaskSheet`: the project first (a picker only from the compose button), the stream (defaults to the one tapped, else the project's `lastStreamId`), the agent (Claude chat), a permission mode (Default, Ask, Accept edits, Plan, Auto, Bypass) and the first prompt, which names the task. **Start** sends `task.new { projectId, streamId?, prompt, mode? }` (60 s timeout, since the desktop starts Claude and sends the prompt before answering). The result's `tabId` goes to `AppModel.requestedChat`, and `RootView` opens the chat once the tab shows up in the inbox, as it does for a tapped notification. A failure shows under the form and keeps the prompt.
- **New stream:** for a desktop that lists `stream.new`, the project screen's toolbar **+** opens `NewStreamSheet`: the name (prefilled with the next version, with suggestion chips), New worktree or Project folder, the branch (follows the name until edited) and From (`branches.list`). It sends `stream.new` (§8.12); the new stream shows up with the next inbox. Without `branches.list`, or when it answers `unsupported`, only the project folder is offered.
- **Close task:** for a desktop that lists `task.close`, a swipe on a task row, an Inbox row's context menu, or the button at the bottom of the task screen. `CloseTask.swift` confirms, sends `task.close` (which archives the task to its stream's Done list on the desktop), and turns a `working` or `unsaved` blocker into a second confirmation that resends with `stopWorking` or `discardUnsaved` (§8.7). The task screen pops once the task is gone. The phone doesn't browse or reopen archived tasks.
- **Inbox:** the sidebar's first row and the screen the app opens to (`InboxView`). It lists every paired desktop's tasks in the desktop inbox's groups (`InboxPartition` in DevToolKit): Needs you (longest wait first), then Ready: tasks waiting on your reply (a ring when read, the unread dot otherwise) and then the rest, each by last activity. Working, Settled and Snoozed follow as folded rows. Rows lead with the project tile and `project › stream`. The toolbar switches to one card per project (`inboxGroupedByProject`). Its badge counts unread tasks that aren't settled or snoozed, as the desktop's Inbox tab does. For a desktop that lists `task.triage`, swipe a row right to mark it read or unread, left to settle or snooze it (the desktop's presets, `SnoozePreset`), or long-press it; the task screen has the same actions under its tray button. Each action shows at once and is put back if `task.triage` fails (§8.11). Opening an unread task sends `read`, and so does an event arriving while its screen is open, so the desktop's unread dot goes too.
- **Pinned:** a Pinned section above the projects mirrors the desktop sidebar's Pinned list (a pinned project or stream opens in place to its tasks). For a desktop that lists `pin`, swipe a task or stream header right or long-press it to pin or unpin it, tap the pin in a project screen's toolbar, or use the pin button in the task screen.
- **Close tab:** for a desktop that lists `tab.close`, a swipe on a tab row in the task screen. A working or waiting tab is confirmed first.
- **Require Face ID for approvals:** Settings → Security, off by default, `UserDefaults` key `security.requireAuthForApprovals`. It shows only when the device can do device-owner authentication, and is named after the biometry (Face ID, Touch ID, Optic ID, or passcode). Turning it off asks for authentication too. When it is on, `ChatModel.answer`, which every in-app answer goes through, runs `.deviceOwnerAuthentication` first. Cancelling leaves the card as it was, and a failure shows on the card. The `permission` notification category is registered again with `.foreground` added to Allow and Deny, so they open the app, which authenticates, opens the chat and then answers. If one of those actions still arrives in the background (a category registered before the switch changed), the app posts "Couldn't send your answer" instead of answering.
- **Offline transcripts:** each opened chat's last transcript (at most 60 items, with title, status and prompts) is saved to `Application Support/DevTool/chats/<desktopId>/<tabId>.json`. It is written when the open succeeds, at most every 5 s while events arrive, when the session drops, when the chat closes and when the app leaves the foreground. When the first `chat.open` can't reach the desktop and a saved transcript exists, it shows read-only under the offline banner, marked "Saved transcript, read-only", with prompt cards, composer and Load earlier disabled, until the live open replaces it. Forgetting a desktop deletes its chats, and chats whose tab is gone from the latest inbox are removed.
- **Foreground:** returning to the foreground calls `reconnectNow()` on every connection. It ends the relay's reconnect backoff (`RelayClient.reconnectNow`), or pings the relay when the socket is up so a dead one fails at once. It also retries a handshake that is backing off, and refreshes the inbox of desktops that are online. Nothing is queued while offline.

## Push notifications (M3)

SPEC.md §7 is the contract. On the phone:

- **Settings → Notifications** has a master switch and toggles for *Permission requests* (`permission`), *Questions & plans* (`question`) and *Finished turns* (`done`). All three are on once the master switch is. They live in `UserDefaults` (`push.enabled`, `push.kinds`). Turning the switch on asks for notification permission. If iOS has notifications turned off for DevTool, the section says so and links to Settings.
- At launch, and when push is switched on, the app gets an APNs token and registers it with the gateway (`POST <gateway>/v1/push/register`, signed with the phone's relay key; the env is `sandbox` in Debug builds and `production` in Release). It keeps the returned `cap` in `UserDefaults` (`push.cap`), together with the token, env and gateway it was issued for. If registration fails, the error is logged and shown in Settings, and an older `cap` for the same token stays in use.
- After every session that ends its handshake with `ok`, and whenever the switches or the `cap` change, the app sends `push.register { cap, key, keyId, kinds }` to that desktop. With push off it sends `push.unregister` to the desktops it had registered with (`push.registeredDesktops`). A desktop from before M3 answers `unsupported`, which is only logged.
- **Keys:** each pairing gets its own 32-byte `key` and 8-byte `keyId` (random), created on first use and deleted when the pairing is forgotten. `PushKeyStore` keeps them as Keychain items under service `sk.awantech.devtool.push`, one per desktop ID, holding `{desktopId, key, keyId, desktopName}`, in access group `group.sk.awantech.devtool`. That is the App Group, which iOS also accepts as a keychain access group, so the extension can read the keys and nothing else of the app's. When the process isn't entitled to that group (an unsigned `CODE_SIGNING_ALLOWED=NO` build), the store falls back to the default group. The app keeps working, but the extension can't see the keys, so notifications keep their fallback text.
- **Extension:** `DevToolNotifications` reads `d`, looks up the key by the key ID in front of it, decrypts and replaces the alert with the payload's `title` and `body`. With more than one paired desktop, the desktop's name goes in the subtitle. It sets the category to `kind`, the thread to the tab, and `desktop` / `tab` / `prompt` in `userInfo`, taking `desktop` from the key rather than the payload. On any failure, or when time runs out, it delivers the original "An agent needs you".
- **Categories:** `permission` has *Allow* and *Deny* (destructive). Both require an unlocked device, and neither brings the app to the foreground unless "Require Face ID for approvals" is on (see M4). `question`, `plan` and `done` have no actions.
- **Tapping** a notification opens that chat, waiting briefly for the inbox on a cold launch. **Allow / Deny** wake the app in the background. It holds a background task, connects to the desktop through the same `AppModel` connection machinery, waits for a session and sends `chat.answer` with `{behavior:"allow"}` or `{behavior:"deny"}`. `gone` (already answered) counts as success. After 25 s it gives up and posts a local "Couldn't send your answer" notification that opens the chat.
- **In the foreground**, a push shows as a banner with sound unless that exact chat is on screen.

Entitlements are in `DevTool/DevTool.entitlements` (`aps-environment`, the App Group, and `keychain-access-groups`, which keeps the app's default keychain group at its own app ID) and `DevToolNotifications/DevToolNotifications.entitlements` (the App Group). To run on a device, the team you pick needs the Push Notifications and App Groups capabilities for both bundle IDs (`sk.awantech.devtool`, `sk.awantech.devtool.notifications`) and the group `group.sk.awantech.devtool`.

Mock mode (`-mockDesktop`) doesn't need any of this. It never contacts APNs or a gateway, and it keeps its switches in a separate defaults suite. The switch still asks for permission, so `simctl push` notifications show up, and tapping one or answering Allow/Deny works against the mock desktop.

### Launch options (Debug builds)

- `-pushGateway <url>` (or env `DEVTOOL_PUSH_GATEWAY`) registers with that gateway instead of `https://relay.devtool.awantech.sk`, e.g. a local relay's HTTP port: `-pushGateway http://127.0.0.1:8787`.
- `-fakePushToken <hex>` (or env `DEVTOOL_FAKE_PUSH_TOKEN`) skips APNs and registers that token (32 to 100 bytes of lowercase hex). A simulator can't get a token APNs accepts for our topic without our signing, but a gateway in simctl mode ignores the token.

### Testing on the simulator with a local gateway

Run the relay as a gateway that delivers with `xcrun simctl push` instead of APNs (`RELAY_APNS_MODE=simctl`, see `relay/README.md`), point the desktop at it, then:

```bash
xcrun simctl launch "$SIM" sk.awantech.devtool \
  -pushGateway http://127.0.0.1:8787 \
  -fakePushToken $(openssl rand -hex 32)
```

Pair (or resume), open Settings → Notifications and switch it on. The app registers with the gateway and sends `push.register` to the desktop. Pushes from the desktop then go through the gateway to `simctl push` and the extension. Build with the default signing ("Sign to Run Locally", no `CODE_SIGNING_ALLOWED=NO`) so the App Group entitlement is there and the extension can read the keys.

### Testing with `xcrun simctl push` directly

Without a desktop, `d` can't be sealed with a key the phone has, so the extension leaves the alert as it is. The top-level `desktop` / `tab` / `prompt` keys and `aps.category` still reach the app, which is enough to exercise tapping and Allow/Deny, e.g. against the mock desktop (`-mockDesktop`; `4f1c2b9e7d6a53108e2f9c4b1a7d3e60` is join3r-mbp):

```bash
cat > /tmp/permission.apns <<'JSON'
{
  "Simulator Target Bundle": "sk.awantech.devtool",
  "aps": { "alert": { "title": "DevTool", "body": "An agent needs you" }, "sound": "default",
           "mutable-content": 1, "category": "permission" },
  "d": "not-decryptable",
  "desktop": "4f1c2b9e7d6a53108e2f9c4b1a7d3e60", "tab": "<claude-chat tab id>", "prompt": "<prompt id>"
}
JSON
xcrun simctl push "$SIM" sk.awantech.devtool /tmp/permission.apns
```

Log output: `log stream --predicate 'subsystem == "sk.awantech.devtool"'` (categories `push`, `notifications`, `notification-service`).

## Release and TestFlight

A Release build talks to `wss://relay.devtool.awantech.sk` and registers for **production** APNs (`env: "production"`, SPEC.md §7.1); distribution signing switches `aps-environment` in the entitlements to `production`. `ITSAppUsesNonExemptEncryption` is `false` because all cryptography is Apple's (CryptoKit, Security, TLS), so uploads need no export compliance answer. The app icon is the single 1024 px `AppIcon` in `DevTool/Assets.xcassets`. The privacy policy is at https://devtool.awantech.sk/privacy/ (source in `site/`).

The App Store Connect app record for `sk.awantech.devtool` must exist before the first upload. Bump `CURRENT_PROJECT_VERSION` in `project.yml` for every upload (App Store Connect refuses a build number twice), then:

```bash
cd ios
xcodegen generate
xcodebuild -project DevTool.xcodeproj -scheme DevTool -configuration Release \
  -destination 'generic/platform=iOS' -archivePath build/DevTool.xcarchive \
  -allowProvisioningUpdates archive
# /usr/bin first: Xcode's IPA step breaks on Homebrew's rsync 3.x ("Copy failed").
PATH=/usr/bin:/bin:/usr/sbin:/sbin xcodebuild -exportArchive \
  -archivePath build/DevTool.xcarchive -exportPath build/upload \
  -exportOptionsPlist ExportOptions.plist -allowProvisioningUpdates
```

`ExportOptions.plist` signs for App Store Connect (automatic, team `AX23G9CAL9`) and uploads with the Apple ID signed in to Xcode. Change `destination` to `export` to get a local `DevTool.ipa` instead. After processing, the build shows under TestFlight → Internal Testing.

## Tests

```bash
cd ios/DevToolKit
swift test
```

These run on macOS with no simulator. They load `protocol/vectors/*.json` and `protocol/vectors/official/*.json` straight from the repo (official cacophony/snow/noise-c and generated Noise IK vectors byte for byte, derivations, relay auth, pairing URIs, app-message samples), and drive `RelayDesktopConnection` against an in-process fake relay and desktop (`FakeRelay.swift`).

CryptoKit's Ed25519 signatures are randomized, not deterministic RFC 8032, so `relay-auth.json` and `push.json` signatures are checked by verification both ways instead of byte equality. Everything else in `push.json` (the signed message, the registration body with the vector's signature, payload decryption for every case, sealing with the fixed nonce, `push.*` params) matches byte for byte.

`LiveRelayIntegrationTests` runs the real pair → accept → inbox → resume flow against a live relay and `fake-desktop.ts`. It is skipped unless `DEVTOOL_RELAY_URL` is set:

```bash
DEVTOOL_RELAY_URL=ws://localhost:8787 DEVTOOL_PAIRING_URI='devtool://pair?d=…' swift test --filter LiveRelayIntegrationTests
```

## Storage

- Paired desktops go in `Application Support/DevTool/desktops.json`, each desktop's last inbox goes in `Application Support/DevTool/inbox/<desktopId>.json`, and opened chats' last transcripts go in `Application Support/DevTool/chats/<desktopId>/<tabId>.json`. All use file protection until first unlock.
- Private keys go in the Keychain under service `sk.awantech.devtool.keys` through `KeychainStore`, as `device.x25519` and `device.ed25519` (raw 32 bytes each).
- Push keys go in the Keychain under service `sk.awantech.devtool.push`, access group `group.sk.awantech.devtool` (see Push notifications). The push switches, the current `cap` and `security.requireAuthForApprovals` go in `UserDefaults`.
