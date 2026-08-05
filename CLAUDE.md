This is DevTool, an Electron desktop app for managing development workspaces with projects, tasks, and tabs.

## Config dir

Persistent state lives in a config dir resolved in `src/main/config-dir.ts`: `~/.devtool` for packaged builds, `~/.devtool-dev` for dev runs (`npm run dev*`), overridable via `DEVTOOL_CONFIG_DIR`. Dev and production are isolated on purpose — saves write full snapshots of `projects.json` (last writer wins), so two instances sharing a dir silently lose each other's changes. Never point a dev instance at `~/.devtool` while the production app is running. On startup each instance also snapshots `projects.json` into `<config dir>/backups/` (last 10 kept).

## Electron binary install

`npm install` can leave `node_modules/electron/dist` half-unpacked: Electron's postinstall extracts its zip with `extract-zip@2`/`yauzl@2`, which on Node >=26 can abort mid-extraction without settling its promise, so `install.js` exits 0 with a near-empty `dist` and no `path.txt`. npm reports success and the failure only surfaces later as `Error: Electron uninstall` from electron-vite. `scripts/ensure-electron.mjs` (first step of `postinstall`) detects this and re-extracts the cached zip with a system unzip tool; run it directly to repair an existing tree.

Don't `chmod +s` `dist/chrome-sandbox` to chase sandbox errors — a setuid binary not owned by root makes Chromium reject it outright rather than fall back to the user-namespace sandbox.

npm >=11.17 blocks dependency install scripts until they're approved, which would otherwise stop Electron from downloading at all. The `allowScripts` field in `package.json` covers `electron`, `esbuild` and `node-pty`; entries are pinned to exact versions, so bumping any of those needs a fresh `npm approve-scripts <pkg>`. `electron-winstaller` is deliberately left unapproved — it only matters for Windows packaging, which this project doesn't do, so `npm install` warns about it harmlessly.

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
