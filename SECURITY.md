# Security audit (company-deploy readiness)

Snapshot of what this fork actually is, from a security point of view, before putting it on company machines. Dated against **`0.5.0`** (Phase 4 native notebooks). Not a pentest. Not a promise that later phases stay clean.

This repository is a fork of [join3r/claude-project](https://github.com/join3r/claude-project). Work stays on [join3r/claude-project](https://github.com/join3r/claude-project). Product direction is in [ROADMAP.md](./ROADMAP.md).

---

## What you are deploying

DevTool is a **privileged workstation orchestrator**, not a sandboxed product and not an agent runtime. Treat it like “a terminal + SSH + git + file tree + an embedded browser + a host for Pi/Claude/Codex,” all running **as the logged-in user**.

It will:

- Spawn Git Bash (and agent CLIs) with the user’s environment.
- Read, write, create, rename, and delete files under a project cwd.
- Commit / push / discard via git.
- Open SSH ControlMaster sessions, local port forwards, and a SOCKS proxy for the in-app browser.
- Inject Claude hooks into the project’s `.claude/settings.local.json` and load a Pi status extension.
- Persist layout, notes, and **full terminal scrollback** under `~/.devtool` (packaged) or `~/.devtool-dev` (dev).

It will **not**:

- Sandbox Pi (or Claude/Codex). Models, API keys, and base URL stay in Pi’s own config (Phase 0.5).
- Add SSO, audit logs, or DLP. The update check (below) talks to public GitHub Releases, not a managed company channel.
- Replace company SSH/PKI policy. Host-key checking is TOFU (`accept-new`).

If “an AI CLI with the developer’s credentials, on company source” is already a no, this app does not make that safer. If that is already accepted for a normal Git Bash window, the rest of this file is the *extra* surface DevTool adds.

**1.0.0** in the roadmap is “something you would tell a friend to unzip.” Company IT is a higher bar than that.

---

## Threat model (what to worry about)

| Attacker / situation | Why it matters here |
| --- | --- |
| Malicious or compromised **web page** in an in-app browser tab | Renderer has `webviewTag` and a large IPC surface (spawn, file I/O, git, SSH). |
| **Local** process or another user on the same machine | Hook POSTs need a per-process token, but the server is still plaintext HTTP on `127.0.0.1`. Config/scrollback are plaintext. |
| Process on an **SSH remote** (shared Linux box) | Hook port is reverse-forwarded (`ssh -R`). Inbox POSTs need the process token. Pi extension lives under `$HOME/.devtool-remote/`. |
| **Network** MITM on first SSH connect | `StrictHostKeyChecking=accept-new` trusts the first host key it sees. |
| **Supply chain / stale Chromium** | Keep Electron on a supported line (now **43.6.0**). Windows `DevTool.exe` is still **unsigned**. |
| The **agent itself** | By design it can read `.env`, run commands, and `git push`. Policy problem, not a missing `if`. |

Out of scope for this snapshot: a full dependency CVE dump, physical theft of an unlocked laptop (same as any editor), and “make Pi unable to see the repo.”

---

## Already in decent shape

Keep these; do not regress them.

- Preload uses `contextBridge`. `openExternal` allows only `http:` / `https:`.
- Main window sets `contextIsolation: true` and `nodeIntegration: false`. Guest `<webview>` pages cannot get Node or a preload (`will-attach-webview` plus `webpreferences` on the tag). New browser tabs default to `about:blank`, not Google.
- File-tree create / rename / delete goes through `resolveSafeProjectPath` (`src/main/project-fs-path.ts`) and rejects `..` / other-drive escapes **relative to the given project cwd**.
- Workspace delete refuses to recursively remove a path that is not a registered git worktree.
- Hook HTTP server binds **`127.0.0.1`**, not all interfaces. POSTs require `X-Devtool-Token`; bodies over 64 KiB are rejected. SOCKS and SSH `-L` are localhost-style binds by default.
- Markdown preview is sanitized with DOMPurify.
- Chrome DevTools Protocol (`DEVTOOL_CDP_PORT`) is opt-in; packaged runs do not open it.
- SSH remote commands are mostly `execFile` plus quoting (`shellQuote` in `ssh-connection-manager.ts`), not a local `sh -c` string built from untrusted pieces. Control-socket dir is `0700`. Host keys use `~/.ssh/known_hosts` (`StrictHostKeyChecking=accept-new`). Identity selection is left to ssh (optional `-i` key file, no `IdentitiesOnly`).
- Dev and packaged config dirs are split on purpose (`src/main/config-dir.ts`).
- Spectre-mitigated `node-pty` builds stay on; do not strip that to make compile easier (see README).
- Do not `chmod +s` `chrome-sandbox` (AGENTS.md).

---

## Findings

Severity is “what a company security review usually does with it,” not CVSS. **Blocker** = typical IT will not put this in Software Center as-is. **High** = fix or write an exception before a real rollout. **Medium** = do before you call it boring. **Policy** = code cannot save you; someone has to accept it.

### Blocker

**Unsigned Windows builds.** No certificate is configured: `npm run build:win` (`dist/win-unpacked`) and `npm run build:win:setup` (per-user NSIS Setup.exe) carry DevTool's icon and version resources but no Authenticode publisher. SmartScreen, AppLocker, WDAC, and “who shipped this?” all fire. No Electron fuses (`onlyLoadAppFromAsar`, `embeddedAsarIntegrityValidation`, `runAsNode`, cookie encryption). Anyone who can write into the install folder (per-user: `%LOCALAPPDATA%\Programs\DevTool`) can replace binaries.

**Update check.** Packaged builds request `https://github.com/join3r/claude-project/releases/latest` at launch and every 6 h (Settings → Updates turns it off). Unsigned builds only report a newer version and open its page; they never download or replace themselves. Only a build signed through `scripts/sign-win.cjs` and installed with Setup.exe self-updates via electron-updater, which checks the downloaded installer's publisher. Unsigned releases ship without `latest.yml`, so no install self-updates to one.

### High

**Renderer / webview: remaining gaps.** Main window still has `sandbox: false` and `webviewTag: true`. There is no CSP in `src/renderer/index.html`, no `setWindowOpenHandler`. DevTools are always available (app menu and the browser-tab button). Local browser tabs use the default session. Remote tabs use `persist:browser-${projectId}` plus SOCKS through the SSH host — company browsing can egress via that box. Guest Node is locked off (Phase 1.3); that does not sandbox the rest of the IPC surface.

**SSH first-connect is still TOFU, not company PKI.** Master, SOCKS, and spawn args keep `StrictHostKeyChecking=accept-new`. First connection to the wrong host is remembered in `~/.ssh/known_hosts` (same file as terminal `ssh`). A *changed* key fails with a message that names that file. No SSH CA. `projects.json` stores host / user / port / **path** to a key file. Remote directory is required.

**Privileged IPC is a wide main-process API.** After XSS or a webview escape, the renderer can already do what the user can do. Extra problems even then:

| Channel | Issue |
| --- | --- |
| `pty-spawn` | Arbitrary process; `extraEnv` is passed through (e.g. `LD_PRELOAD` / `NODE_OPTIONS`). |
| `fb-*` / git ops | Traversal is relative to **whatever cwd the renderer sent**, not an allow-list of known projects. |
| `hooks-inject` | Writes `.claude/settings.local.json` in any directory. |
| `scrollback-save` | `tabId` is joined into a filename with no sanitization (`src/main/scrollback-storage.ts`). UI uses UUIDs; main does not require that. |

Git `add` / `checkout` / `show` correctly use `--` (option injection), but paths are not forced under the project root.

**Secrets sit in plaintext home files.** Packaged: `~/.devtool`. Dev: `~/.devtool-dev`. Expect `projects.json`, `notes.json`, `scrollback/*.txt` (full agent/terminal output), `debug.log` (hook payloads), `backups/projects-*.json`. The Files tree lists `.env` and `.git` on purpose (Phase 1.1). No `chmod 700` on the config dir. Browser cookies live in Electron `userData`, a second location. Idle-task cleanup (off by default) can delete git worktrees — keep it off on shared machines.

### Medium

**macOS entitlements are wide** (if you ever ship Mac): hardened runtime is on, but JIT, unsigned executable memory, and `disable-library-validation` are enabled, plus mic/camera for agent voice. Linux `scripts/install.sh` copies to `/opt/DevTool`; do not setuid `chrome-sandbox` to chase sandbox errors.

**Supply chain / build machine.** From-source Windows still needs admin + VS 2022 + Spectre libs. Recipients of the portable folder skip compile (good). `npm install` still runs native rebuilds. Pin and vendor if you need a reproducible internal build. Leave `electron-winstaller` unapproved until you have signing.

**Claude hooks can be left on disk** if the app crashes before cleanup. They call `curl` at `localhost:<port>/hook/...`. Harmless if the port is dead; surprising if another DevTool instance reused a port (unlikely with `listen(0)` but not a protocol secret).

### Policy (accept or do not deploy)

Pi/Claude/Codex run as the user, in the project or worktree, with network. DevTool does not hold inference keys (good) and does not redact, log, or block `git push`, secret reads, or calls to internal APIs. Extra `aiToolArgs` are extra CLI flags, not a proxy.

Same review you would do for “developers already run Pi in Git Bash on laptops.” This app hosts that; it does not wrap it in a jail.

---

## Company-control gaps (not code bugs)

Typical IT checklist items this repo does not provide:

- SSO / device identity / “who ran this”
- Audit trail of SSH, git push, or agent sessions
- Network allow-list (browser + agent + SOCKS)
- Data classification for scrollback and notes
- Supported update / CVE process
- Encryption at rest for `~/.devtool`
- Two instances on the same config dir: last writer wins on `projects.json` (see AGENTS.md)

---

## Decisions after the 0.3.0 audit

Recorded so this file and [ROADMAP.md](./ROADMAP.md) stay aligned. Findings below the closeout paragraph are what is **still open** after Phase 2 (version stays `0.3.2`).

| Audit item | Decision | Where it lives |
| --- | --- | --- |
| 1. Policy (agent = user) | Accept. Same as running Pi in Git Bash. | Not a phase. |
| 2. Sign Windows build | Considered, not required yet. Stay unsigned portable folder until Phase 5. | Phase 5 (after NSIS) |
| 2. Upgrade Electron | **Done** in `0.3.1` (43.6.0). Stay on a supported major. | **Phase 1.3** |
| 3. Default browser page | **Done.** New tabs are `about:blank`, not Google. | **Phase 1.3** |
| 3. Webview / Node | **Done.** Webview kept; guest pages do not get Node. | **Phase 1.3** |
| 4. Hook secret, Pi off `/tmp`, SSH trust | **Done.** Token + body cap; `$HOME/.devtool-remote/`; `~/.ssh/known_hosts` (no `IdentitiesOnly`); socket dir `0700`; remote dir required. First-connect TOFU remains. | **Phase 2** |
| 5. Config dir `0700`, scrollback id, IPC cwd allow-list | Deferred. | Parking lot (not packaging) |
| 6. Company pilot / DLP | Deferred. | Parking lot / outside the repo |

---

## Suggested order if you want to deploy anyway

Work in this order so each step is demoable. Roadmap numbering after the audit:

1. **Policy accept** — done as “same as a terminal.”
2. **Phase 1.3** — **done** (`0.3.1`): Electron 43.6.0; blank browser tab; guest Node off; signing still off.
3. **Phase 1.4** — **done** (`0.3.2`): Windows shortcut labels. Labels only; no security change.
4. **Phase 2** — **done** (`0.3.2`, no minor bump): hook authentication; Pi extension off `/tmp`; SSH via `~/.ssh/known_hosts` (no `IdentitiesOnly`); required remote dir; socket dir `0700`.
5. Conda (Phase 3) is **done** (`0.4.0`). Native notebooks (Phase 4) ship as **`0.5.0`**. Next: packaging (Phase 5, `0.6.0`+). LSP is parked, not a numbered phase.
6. **Deferred:** config-dir ACLs, scrollback `tabId`, IPC cwd allow-list, a formal pilot. Authenticode is Phase 5 after NSIS, not a separate “later maybe” bucket.

Do not start parked LSP work, or a JupyterLab-in-browser launcher, instead of Phase 5 packaging.

Highest-leverage remaining engineering pass: **unsigned Windows folder** / Phase 5 packaging as the company-deploy blocker.

---

## Code map (where to look)

| Area | Where |
| --- | --- |
| Window / webPreferences | `src/main/index.ts` |
| IPC surface | `src/main/app-runtime.ts`, `src/preload/index.ts` |
| Hook HTTP | `src/main/hook-server.ts`, `src/main/hook-injector.ts`, `src/shared/hook-protocol.ts` |
| Pi extension path | `src/main/pi-extension-injector.ts` |
| SSH / SOCKS / tunnels | `src/main/ssh-connection-manager.ts` |
| File tree bounds | `src/main/project-fs-path.ts`, `src/main/file-browser-fs.ts` |
| Scrollback files | `src/main/scrollback-storage.ts` |
| Config dir | `src/main/config-dir.ts`, `src/main/storage.ts` |
| Embedded browser | `src/renderer/components/BrowserTab.tsx` |
| Native notebooks | `src/shared/notebook.ts`, `src/main/notebook-kernel.ts`, `src/main/notebook-cwd.ts`, `resources/notebook-kernel.py` |
| Packaging / signing | `package.json` `build.win` |

---

## How this file relates to the roadmap

Roadmap phases (conda, native notebooks, then packaging) add more child processes (an ipykernel per notebook tab) and an installer/updater. They do not remove anything above. Do not declare Phase 3–5 “company ready” without revisiting this file.

Parking-lot ideas that would *increase* surface if pulled in: Windows OpenSSH as a second remote stack, language servers talking stdio as the same user. Native notebook kernels (Phase 4) spawn `python` from the project default conda env (optional per-notebook override) as the logged-in user — same trust as a terminal running that env.

This audit started as a snapshot at `0.3.0`. **Phase 1.3 (`0.3.1`):** Electron 43.6.0, `about:blank` new tabs, guest webview Node locked off. **Phase 1.4 (`0.3.2`):** Windows shortcut labels only. **Phase 2 (`0.3.2`, no minor bump):** hook shared secret + 64 KiB body cap; remote Pi extension under `$HOME/.devtool-remote/` (`0700`); SSH uses `~/.ssh/known_hosts` and `accept-new` (no DevTool `UserKnownHostsFile` / `IdentitiesOnly`); remote directory required; control-socket dir `0700`. Still open: unsigned Windows folder, no CSP, first-connect TOFU, wide IPC, plaintext `~/.devtool`.
