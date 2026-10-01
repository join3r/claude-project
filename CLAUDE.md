This is DevTool, an Electron desktop app for managing development workspaces with projects, tasks, and tabs.

## Config dir

Persistent state lives in a config dir resolved in `src/main/config-dir.ts`: `~/.devtool` for packaged builds, `~/.devtool-dev` for dev runs (`npm run dev*`), overridable via `DEVTOOL_CONFIG_DIR`. Dev and production are isolated on purpose — saves write full snapshots of `projects.json` (last writer wins), so two instances sharing a dir silently lose each other's changes. Never point a dev instance at `~/.devtool` while the production app is running. On startup each instance also snapshots `projects.json` into `<config dir>/backups/` (last 10 kept).

## Checks

`npm run typecheck` (covers `src/` and `tests/`), `npm run lint` (must exit 0; warnings allowed), `npm test`. `npm run build*` runs typecheck first. `npm install` points `core.hooksPath` at `.githooks/` (pre-commit: eslint on staged files + typecheck). Leave `react-hooks/exhaustive-deps` warnings alone rather than adding deps blindly: that changes when effects run. CI (`.github/workflows/ci.yml`) uses Node 24.

## Electron binary install

`npm install` can leave `node_modules/electron/dist` half-unpacked: Electron's postinstall extracts its zip with `extract-zip@2`/`yauzl@2`, which on Node >=26 can abort mid-extraction without settling its promise, so `install.js` exits 0 with a near-empty `dist` and no `path.txt`. npm reports success, then electron-vite fails later with `Error: Electron uninstall`. From Electron 42 the package also **skips downloading the binary in its own postinstall**. `scripts/ensure-electron.mjs` (first step of our `postinstall`) detects a missing/partial `dist`, runs `install.js` if the zip is not cached, and otherwise re-extracts the cached zip with a system unzip tool. Run it directly to repair an existing tree.

Don't `chmod +s` `dist/chrome-sandbox` to chase sandbox errors — a setuid binary not owned by root makes Chromium reject it outright rather than fall back to the user-namespace sandbox.

npm >=11.17 blocks dependency install scripts until they're approved, which would otherwise stop Electron from downloading at all. The `allowScripts` field in `package.json` covers `electron`, `esbuild` and `node-pty`; entries are pinned to exact versions, so bumping any of those needs a fresh `npm approve-scripts <pkg>`. `electron-winstaller` is deliberately left unapproved — portable Windows output is `npm run build:win` (`--win --dir`), not an installer, so `npm install` may warn about it harmlessly.

## Windows native rebuild (`node-pty`)

`postinstall` runs `@electron/rebuild` so `node-pty` matches Electron, not the host Node. `package.json` overrides `node-abi` so rebuild knows this Electron major. On Windows that compile needs **admin rights** to install or modify Visual Studio 2022 Build Tools, plus the **MSVC v143 Spectre-mitigated libs** component (`MSB8040` if it is missing). Do not strip `SpectreMitigation` from `binding.gyp`. Git Bash/MinGW is not a substitute. Details: [README.md](./README.md) (Install → Windows).

Agent shells on Windows (Claude Code) may set `NoDefaultCurrentDirectoryInExePath=1`, which makes node-pty's gyp step fail with `'GetCommitHash.bat' is not recognized`. Unset it for `npm ci` / `npm run build:win*`.

Machines without admin do not `npm install` from git. Produce a portable folder on a VS machine with `npm run build:win` and copy `dist/win-unpacked`. That path is run-only (`DevTool.exe`); it does not unlock `npm run dev`.

## Windows spawn PATH

Pi and terminals inherit env from [`src/main/shell-env.ts`](src/main/shell-env.ts). Settings **Node directory** (`portableNodeDir`) is the unzipped Node zip folder; it is prepended on **new** tabs only. `DevTool.exe` already embeds Node — a portable zip is not required for the app to start, and Node does not need to be on the machine-wide Windows PATH. Interactive Windows tabs are Git Bash only (no PowerShell / Command Prompt picker). `cmd.exe` remains only as the ConPTY wrapper for `.cmd` agent shims.

Do **not** assign Git Bash’s Unix PATH (`/c/Users/...:/usr/bin:...`) to `process.env.PATH`. node-pty ConPTY resolves relative `cmd.exe` against that process PATH; a Unix value yields `Error: File not found:` with an empty path and a blank Pi tab. Convert MSYS PATH to `C:\...;...` for the **child** env only.

Inference (models, API, base URL) stays in **Pi’s own config**. Do not add those fields to DevTool. Extra `pi` CLI flags already live on the project as `aiToolArgs`.

## UI smoke testing with agent-browser

DevTool exposes a Chrome DevTools Protocol port when launched with the `DEVTOOL_CDP_PORT` env var (wired in `src/main/index.ts`). Use this to drive the live UI from an AI session via `agent-browser`.

```bash
# Launch dev with CDP on port 9222 (or any port via env var)
npm run dev:cdp

# In another shell, connect and inspect
agent-browser connect 9222
agent-browser tab                    # list BrowserWindows + webviews
agent-browser snapshot -i            # a11y tree with @eN element refs
agent-browser screenshot ui.png
agent-browser click @e5
```

Notes:
- The CDP switch is opt-in; `npm run dev` and production builds do **not** open the port.
- Multiple DevTool windows (Cmd+Shift+N) are separate CDP targets — switch via `agent-browser tab <index>`. One `agent-browser` instance handles all of them.
- Terminal panes are xterm.js inside the same renderer, so they appear in the same snapshot — no separate `agent-browser` needed. xterm renders rows to DOM but the a11y tree is sparse; for *typing into* a terminal use `agent-browser keyboard type "..."` after focusing the pane, and for *reading* terminal output prefer reading the underlying buffer/log files rather than scraping xterm DOM.
- An `agent-browser` running *inside* a DevTool terminal (e.g., Claude Code driving some other browser) is unrelated to the one driving DevTool itself — they're independent processes.
