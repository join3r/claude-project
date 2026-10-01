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
```

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

## License

[MIT](./LICENSE). Original work by [join3r](https://github.com/join3r); this fork by [TeleporterGuy](https://github.com/TeleporterGuy).