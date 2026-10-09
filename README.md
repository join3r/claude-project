# DevTool

A desktop application for managing development workspaces. Organize projects, tasks, and tabs in a unified interface with integrated terminals, editors, browsers, and AI tool support.

Built with Electron, React, and TypeScript.

Windows support (Git Bash terminals, portable Node, `.cmd` agent shims) was contributed from the [join3r/claude-project](https://github.com/join3r/claude-project) fork. Their Windows/Pi direction is in [ROADMAP.md](./ROADMAP.md); a company-deploy security snapshot is in [SECURITY.md](./SECURITY.md).

## Features

**Project Management** -- Add, organize, and switch between projects. Group projects into folders. Support for local directories, remote SSH projects, and shell command projects.

**Task Organization** -- Create tasks within projects. Each task maintains its own set of tabs and layout state independently.

**Split-Pane Layout** -- Horizontal split view with independent left and right panes. Drag tabs between panes.

**Terminal Tabs** -- Full terminal emulation via xterm.js and node-pty. On Windows, tabs are **Git Bash** only (auto-detected `Git\bin\bash.exe`; optional path in Settings). PowerShell and Command Prompt are not offered. WebGL-accelerated rendering, scrollback preservation, search, clipboard integration, and copy-on-select.

**Browser Tabs** -- Embedded Chromium browser with URL bar, navigation, and DevTools. SOCKS proxy support for remote project access.

**Editor Tabs** -- Monaco editor with syntax highlighting, configurable fonts, line numbers, minimap, word wrap, and auto-save.

**Notebook Tabs** -- Native `.ipynb` editor. Only the focused cell mounts Monaco; idle code cells are syntax-highlighted read-only previews. Run cells against ipykernel in the project's conda env, or a per-notebook override (`jupyter_client`). Stream text, plain text, PNG and errors. Collapsible cells, run all / run all above, clear outputs. Local projects only.

**Agent Links** -- Cursor-style "add to chat": in an editor or notebook, Ctrl+L / ⌘L inserts an `@path (lines a-b)` or `@notebook.ipynb (cell N, id …)` link into the task's agent tab (Pi, Claude, Codex or Claude chat) without sending it; Ctrl+Shift+L / ⌘⇧L links the whole file. Also from the editor and file-tree context menus, the palette, and an "Add to agent" hint on a selection.

**Diff Viewer** -- Git diff visualization with side-by-side rendering and whitespace options.

**AI Tool Integration** -- Dedicated tabs for Pi (primary), Claude Code, and Codex. Hook server enables bidirectional communication with AI tools running in terminals.

**Conda Environments** -- Pick a conda or micromamba env per local project (Project Settings). New agent tabs prepend that env onto PATH; new interactive terminals run a login shell, then `conda activate` the project env (Windows Git Bash uses `--rcfile` so conda init in `.bash_profile` is kept). Notebook tabs start ipykernel with the same env. Already-open tabs keep their env. DevTool does not create or delete envs.

**Remote SSH Projects** -- Connect to remote machines via SSH with port forwarding, SOCKS proxy tunneling, key authentication, health checks, and auto-reconnection.

**DevTool Servers** -- Run a project on another Linux or macOS machine as if it were local. Its terminals and agents keep running while your laptop sleeps. See [DevTool servers](#devtool-servers).

**Git Worktree Management** -- Create and delete isolated git worktrees for branch work directly from the UI.

**File Browser** -- Integrated file tree: open, create, rename, and delete files and folders. The Files tab has New file / New folder buttons and a quick filter.

**Git Status** -- Display current branch, changed files, and diffs.

**Multi-Window** -- Open multiple application windows with independent state.

### Install

```bash
npm install
```

This installs dependencies and rebuilds native modules (`node-pty`) for Electron.

`npm warn deprecated …` lines (for example `glob`, `inflight`, `rimraf`, `boolean`) come from Electron / electron-builder, not from DevTool itself. They do not fail the install. An `electron-winstaller` ignored-scripts warning is also expected until a Windows *installer* is needed; the portable folder path below does not use it.

#### Windows from source (admin required)

Compiling `node-pty` for Electron uses MSBuild. That needs **Visual Studio 2022 Build Tools** (or full VS) with the Desktop C++ workload, **Python** (for node-gyp), and **administrator rights** to install or modify those tools. Git Bash / MinGW cannot replace MSVC here. There is no portable Spectre CRT zip.

1. Install [Build Tools for Visual Studio 2022](https://aka.ms/vs/17/release/vs_BuildTools.exe) if the Visual Studio Installer is missing. The installer itself requires admin.
2. Modify the **same** VS instance node-gyp will use (often **Build Tools 2022**, not Community, if both are installed).
3. Workload: **Desktop development with C++**.
4. Individual components → search **Spectre** → install **MSVC v143 - VS 2022 C++ x64/x86 Spectre-mitigated libs (Latest)** (`Microsoft.VisualStudio.Component.VC.Runtimes.x86.x64.Spectre`).

Elevated Command Prompt (adjust `--installPath` if `vswhere` shows a different instance):

```bat
"%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vs_installer.exe" modify ^
  --installPath "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools" ^
  --add Microsoft.VisualStudio.Component.VC.Runtimes.x86.x64.Spectre ^
  --passive --norestart --wait
```

Libs should exist at `...\VC\Tools\MSVC\<version>\lib\spectre\x64`. Check:

```bat
"%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe" -products * -requires Microsoft.VisualStudio.Component.VC.Runtimes.x86.x64.Spectre -property installationPath
```

Then from the repo (Git Bash is fine):

```bash
npm install
```

If you added Spectre **after** a failed install, you do not need to delete `node_modules`. Re-run:

```bash
npx @electron/rebuild -m .
```

**MSB8040** (“Spectre-mitigated libraries are required”) means that component is still missing. Do not disable Spectre in `node-pty`’s `binding.gyp`.

Opening a Pi (or Claude/Codex) tab can fail with **Cannot create process, error code: 2** if Windows cannot find the CLI, or **error code: 193** if DevTool tries to CreateProcess a `.cmd` shim directly. Electron does not see Git Bash’s PATH, and npm’s `pi` is usually `pi.cmd`. Set **Settings → AI Tools → Command path** after enabling the tool, or put npm’s global bin on PATH (`%AppData%\npm`). DevTool wraps `.cmd` through `cmd.exe`.

New **Terminal** tabs on Windows are **Git Bash** (`Git\bin\bash.exe --login -i`), including when you start `DevTool.exe` or `npm run dev` from Explorer or cmd — the app does not rely on an inherited `SHELL`. Leave the Git Bash path empty in **Settings → Terminal** to auto-detect, or Browse to a `bash.exe`. PowerShell and Command Prompt are not offered. SSH tabs still use the remote `$SHELL`.

Without admin, without the Visual Studio Installer, or without those Spectre libs, **from-source `npm install` cannot succeed** on Windows. Use a pre-built folder instead.

#### Windows without admin (pre-built portable folder)

A machine that *does* have admin + VS produces an unpacked app. Recipients copy that folder and run it. They never compile and never run `npm install`.

On the build machine (Windows x64, after a successful `npm install` as above):

```bash
npm run build:win
```

That writes a portable directory (typically `dist/win-unpacked`). Zip that folder and give it to the locked-down PC. Run `DevTool.exe` from inside it. Keep a portable Node zip next to it if you want `node` on PATH for terminals later (Settings → Node directory).

Limits of this path:

- It is **run-only**. You cannot `npm run dev` or change the Electron native addon without a VS build machine.
- Architecture must match (x64 build for x64 Windows).
- The portable `DevTool.exe` is unsigned. The build still stamps DevTool's icon and version resources onto it (an `afterPack` hook, `scripts/win-rcedit.cjs`, runs the `rcedit` npm package; no certificate), so Task Manager and file properties say DevTool, not Electron.

#### Windows installer (per-user Setup.exe)

```bash
npm run build:win:setup
```

That writes `dist/DevTool-Setup-<version>.exe` (per-user NSIS installer: no admin, installs under `%LOCALAPPDATA%\Programs\DevTool`, adds a Start Menu shortcut) and `dist/DevTool-<version>-win.zip` (the portable folder, zipped). The portable folder from `npm run build:win` stays the no-admin escape hatch. Uninstalling never touches `~/.devtool`. It is electron-builder NSIS, so `electron-winstaller` stays unapproved.

Both are **unsigned** until a code-signing certificate exists. SmartScreen will warn: **More info → Run anyway**.

Releases are cut by hand on the Windows build machine: `npm run release:win` builds both and uploads them as a **draft** GitHub Release (needs `gh` logged in); publish the draft on GitHub. With a certificate, `npm run release:win -- --signed` (see `scripts/sign-win.cjs` for `DEVTOOL_SIGN_CMD` / `DEVTOOL_PUBLISHER_NAME`) also uploads `latest.yml`, which lets signed installs update themselves.

#### Updates

Packaged builds check `github.com/join3r/claude-project/releases` at launch and every few hours (Settings → Updates, or the menu's **Check for Updates…**; the automatic check can be turned off). Unsigned builds — the portable folder, an unsigned Setup.exe, macOS/Linux dirs — never replace themselves: they say a new version exists and open its release page. Only a signed Setup.exe install downloads and installs updates on its own.

### Development

```bash
npm run dev
```

Starts the app in development mode with hot reload. On Windows this still needs the from-source native rebuild above.

### Build

```bash
npm run build          # Typecheck, then production JS/CSS bundle
npm run build:win      # Portable Windows folder (dist/win-unpacked)
npm run build:win:setup # Per-user Setup.exe + portable zip (dist/)
npm run build:mac      # Package macOS app
npm run build:linux    # Package Linux app
npm run build:server   # DevTool server bundle (out/server/)
npm run build:installer # Regenerate site/install and site/server/bootstrap.mjs
```

`npm run build`, `npm run dev` and `npm run dev:cdp` also run `build:server`, so the app always carries a server bundle that matches it. Packaged builds ship it in `resources/server`. `build:server` fails if anything in the server's import graph reaches `electron`. Run `build:installer` after changing `scripts/server-install.sh` or `src/server/bootstrap.ts` and commit both generated files, since `install` pins the bootstrap's sha256.

### Install (build + system install)

```bash
./scripts/install.sh
```

Builds and installs the app system-wide. Supports macOS (arm64) and Linux (x86_64, arm64). On macOS it copies to `/Applications`, on Linux it installs to `/opt/DevTool` with a desktop entry and `/usr/local/bin/devtool` symlink. Windows uses `npm run build:win` and copying `dist/win-unpacked` instead.

### Test

```bash
npm test               # Run tests
npm run test:watch     # Run tests in watch mode
npm run typecheck      # tsc over src/ and tests/ (tsconfig.typecheck.json)
npm run lint           # ESLint (eslint.config.mjs); warnings are allowed, errors fail
```

`npm install` sets `git config core.hooksPath .githooks`, so commits run `.githooks/pre-commit`: ESLint on the staged JS/TS files plus a full typecheck. Skip it once with `git commit --no-verify`.

Live notebook kernel smoke (real `jupyter_client` / ipykernel, no Electron window). Needs a conda env with those packages:

```bash
NOTEBOOK_LIVE=1 npm test -- tests/notebook-kernel.live.test.ts
```

CI (`.github/workflows/ci.yml`):

- **test (macOS / Linux / Windows)** — typecheck and tests with Node 24, plus lint and `npm run build` on Linux. The Windows job adds the MSVC Spectre-mitigated libs to the runner's Visual Studio if they are missing, since `postinstall` compiles `node-pty`. Live kernel and live SSH (`DEMO_SSH=1`) stay skipped.
- **notebook-live-windows** — the unit suite plus the live kernel smoke (`NOTEBOOK_LIVE_REQUIRED=1`) after Miniforge + `ipykernel` / `jupyter_client`. Skips the native rebuild (`npm ci --ignore-scripts`).

## DevTool servers

A DevTool server is DevTool without a window, running on another machine. It owns the projects you put on it: their terminals, agents, Claude chats, files and git all live there, and DevTool on your desktop shows them in the sidebar next to your local projects, with a server glyph and the server's name. Close the laptop and the agents keep working. Open it again and the tabs reattach with their scrollback.

Unlike Remote SSH projects, nothing runs over an SSH session from the desktop, and every panel works. All traffic goes through the relay, so the server needs no open ports.

### Install

**+** › **Add server…** (or Settings › Servers › **Add server**) shows a one-liner to paste on the machine:

```bash
curl -fsSL https://devtool.awantech.sk/install | DEVTOOL_TOKEN=<token> sh
```

It downloads Node 24 from nodejs.org (checked against `SHASUMS256.txt`) and a small bootstrap, pairs with your DevTool, receives the server from DevTool itself, installs a user service and says `Connected to <desktop>`. The dialog then offers the git repos it found in your home directory. Everything lands in `~/.devtool-server`; nothing needs root, and the installer refuses to run as root unless you add `--allow-root` after `sh -s --`.

- **Install over SSH…** in the same dialog runs the one-liner for you when this computer can already `ssh` to the machine. It fills in targets from your SSH projects.
- **I have a code** is the other direction. Run the installer without a token (`curl -fsSL https://devtool.awantech.sk/install | sh`) and it prints a pairing code to paste into DevTool. `devtool-server pair` on an installed server prints a new one, which is how a second desktop joins (or Settings › Servers › **Add another device** on the first).

The token in the one-liner works once and expires after 15 minutes. It travels in the environment, never on a command line, so other users of the machine can't read it from `ps`.

### What works on a server project

Terminals, Claude Code, Codex and Pi tabs, Claude chat, the file browser, editor and diff tabs, the Git panel, notebooks, conda envs, streams with task worktrees and landing, and browser tabs. A browser tab resolves and connects from the server, so `localhost:3000` is the server's port 3000. Agent CLIs run on the server with the server's own logins. A missing one gets **Install**, which runs the official installer in a terminal tab, and `/login` in a chat asks for the pasted code. **Open in IDE** opens VS Code or Cursor over Remote-SSH, tunnelled through the relay to the server's own sshd (install `openssh-server` there). The first time, DevTool asks before it adds an `Include` line to `~/.ssh/config` and authorizes its key on the server. Reveal in Finder stays local only, and Windows desktops don't offer Open in IDE yet.

When a server goes offline its projects stay in the sidebar, greyed out, from the last snapshot. Open terminal and agent tabs say "<server> is offline, reconnecting…" and reattach when it's back.

Add more projects with **+** › **Server project…**: pick a folder on the server, clone a repo there, or choose from the repos it found.

### Settings › Servers and Relay

Settings › Servers lists every paired server with its state, version and OS. From there you can rename it, add another device, pair a phone, push an update, restart into a staged update, and remove it. Settings › Relay holds the one relay URL that phones and servers share (default `wss://relay.devtool.awantech.sk`). Changing it with anything paired asks first, because every server and phone has to move with it.

### Updates

The server follows the desktop. DevTool carries the server bundle and sends it when it connects to a server running an older build. If no tab on the server is working, the server switches at once; otherwise the sidebar says "<server> has an update ready" with **Restart now**. It never downgrades: an older DevTool keeps working with a newer server as long as the protocol allows. A restart ends the server's terminals, as quitting DevTool does locally, and agent tabs resume their sessions.

### Phones

A server can pair with the iOS app directly: Settings › Servers › **Pair a phone** shows its QR code, or run `devtool-server pair --phone` on the machine for a QR code in the terminal. The phone lists the server like another desktop, with a server glyph, and keeps working with it while your laptop is closed.

### Move an SSH project to a server

Right-click an SSH project (or open its Project settings) and choose **Move to a DevTool server…**. DevTool checks the machine over the existing SSH connection, installs a server there if there isn't one (or reuses the one already paired), and recreates the project on it with its streams, tasks, notes, tags and archive. Open Claude Code and Pi tabs resume on the server, since their sessions already live on that machine.

### The `devtool-server` command

The installer links `devtool-server` into `~/.local/bin` when that directory is on your PATH; it's always at `~/.devtool-server/bin/devtool-server`.

```
devtool-server status            # running? version, paired desktops and phones, relay
devtool-server logs [-f] [-n N]
devtool-server pair [--phone]    # a code for another desktop, or a QR code for a phone
devtool-server unpair <id|name>
devtool-server restart           # also switches to a staged update
devtool-server start
devtool-server uninstall [--keep-data | --delete-data] [--yes]
```

### Platforms

- Linux x64 and arm64 with glibc 2.28 or newer (no musl). It runs as a systemd user service with linger. Without user systemd it falls back to a background process plus an `@reboot` crontab line. If `loginctl enable-linger` is refused, the installer prints the `sudo` line to run.
- macOS, as a LaunchAgent. If nobody is logged in to the Mac's desktop when you install (over SSH, say), the agent can't start at login, so run `devtool-server start` after a reboot.

The desktop can be macOS, Linux or Windows.

### Security

Desktop and server talk over Noise IK, end to end encrypted through the relay, which sees device IDs, timing and sizes but no content. The server only answers: it never calls the desktop, and the desktop drops any event from a server that isn't about that server's own projects and tabs. Install tokens and pairing codes are single use and expire after 15 minutes. The server keeps its keys in `~/.devtool-server/data`, mode 0700.

### Uninstall

Settings › Servers › **Remove…** unpairs the server. With **Also uninstall DevTool from <server>** on (the default while it's online), it also stops the service and deletes `~/.devtool-server`, its unit or LaunchAgent and its crontab line. That ends its terminals and agents for every desktop paired with it. **Keep its data** (off by default) keeps the projects, settings and pairings in `~/.devtool-server/data` for a later install. If the server is offline, remove it in DevTool and run `devtool-server uninstall` on the machine.

## License

[MIT](./LICENSE). Original work by [join3r](https://github.com/join3r); this fork by [TeleporterGuy](https://github.com/TeleporterGuy).