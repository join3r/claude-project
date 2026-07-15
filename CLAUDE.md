This is DevTool, an Electron desktop app for managing development workspaces with projects, tasks, and tabs.

## Config dir

Persistent state lives in a config dir resolved in `src/main/config-dir.ts`: `~/.devtool` for packaged builds, `~/.devtool-dev` for dev runs (`npm run dev*`), overridable via `DEVTOOL_CONFIG_DIR`. Dev and production are isolated on purpose — saves write full snapshots of `projects.json` (last writer wins), so two instances sharing a dir silently lose each other's changes. Never point a dev instance at `~/.devtool` while the production app is running. On startup each instance also snapshots `projects.json` into `<config dir>/backups/` (last 10 kept).

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
