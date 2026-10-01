# Fork roadmap: Windows orchestrator for Pi

This repository is a fork of [join3r/claude-project](https://github.com/join3r/claude-project) (DevTool). join3r has said this fork may be modified freely. Upstream is a macOS/Linux **task multiplexer** for CLI coding agents (Claude Code, Codex, Pi), with SSH, git worktrees, and an inbox. It is not an IDE and not an agent runtime.

This fork keeps that orchestrator model, with **Pi** as the primary agent and Pi’s own settings preserved and first-class in the app. The aim is to make it **primarily for Windows**: Git Bash, a portable Node zip, conda environments, and **native in-app `.ipynb` notebooks**. Linting and similar agent tools stay in **Pi extensions**. Language servers are parked, not a numbered phase.

Do not try to become VS Code or Cursor. If a feature belongs in Pi, put it in Pi.

Company-deploy security snapshot (what this app actually is on a workstation): [SECURITY.md](./SECURITY.md).

---

## Product bet (do not revisit every phase)

- **Host**, do not replace, the agent. Pi remains a CLI TUI in a tab.
- **No VMs.** Local disk + existing SSH to Linux boxes is enough.
- **Git Bash** is the only Windows shell for interactive tabs. No PowerShell. No Command Prompt. (`cmd.exe` may still wrap `pi.cmd` for ConPTY; that is not a product terminal.)
- **Environments are spawn-time PATH/env**, not a conda GUI and not a Node version manager UI. Settings **Node directory** is a folder prepend, not a requirement for `DevTool.exe` to launch.
- **Pi owns inference.** Models, API, and base URL stay in Pi’s config. Do not add those fields to DevTool.
- **Monaco is enough for edit/view.** Deeper analysis belongs in Pi (and similar agent tools). Language servers are parked — optional sugar (hover, go-to, complete) only if Monaco-without-Pi becomes painful. Not a numbered phase; no minor reserved for them.
- **Jupyter is a native notebook tab** (Monaco cells + `jupyter_client` / ipykernel in the project default conda env, optional per-notebook override). Opening JupyterLab in the in-app browser is **not** Phase 4 and was dropped (PR #9 closed unmerged). There is no later “native notebooks” parking-lot phase — this **is** Phase 4.

---

## Versioning (`0.x.y`)

Stay on **0.x** until the app is something you would tell a friend to unzip. **1.0.0** is that call, not “Phase 5 finished.”

`package.json` is **0.6.0** (Phase 5 packaging + app identity). Phase 2 landed without tagging `0.4.0` and stayed **0.3.2**, so Phase 3 used that skipped minor instead of jumping to `0.5.0`. Shape:

| Part | Meaning |
| --- | --- |
| `0` | Pre-1.0. Breaking changes are allowed. |
| `x` (minor) | Bump when a **numbered phase is done**. |
| `y` (patch) | Bump for a **mid-phase build** you would actually copy (`dist/win-unpacked`, a git tag). Not every PR. |

Work inside a phase is `0.x.y`; shipping the phase is the next `0.(x+1).0`.

| State | Version |
| --- | --- |
| Phase 0 done | `0.2.0` |
| Phase 1 done | `0.3.0` |
| Phase 1.3 (Electron line) | `0.3.1` (tagged; not a numbered bump) |
| Phase 1.4 (Windows shortcut labels) | `0.3.2` (tagged; not a numbered bump) |
| Phase 2 done | stayed `0.3.2` (no `0.4.0` tag on this fork) |
| Phase 3 done | `0.4.0` |
| Phase 4 done | `0.5.0` (native `.ipynb` tabs) |
| Phase 4.5 (agent context links) | `0.5.1` (tagged; not a numbered bump) |
| Phase 5 done (packaging + app identity) | `0.6.0` (signing dormant until a certificate; a signed build is a `0.6.x` patch) |
| Phase 6 (Pi chat tab) | `0.7.0` |

LSP is parked (see Ideas); it does not get a numbered phase or a minor. Phase 6 is the Pi chat tab; there is no Phase 7 until something else earns one. Phase 0.5 does not get a version. Ideas in the parking lot do not get a version until they are pulled into a phase.

---

## Current upstream (what you inherit)

Already useful, keep it:

- Projects, tasks, two-pane tabs, command palette, inbox (`working` / `needs you` / settled / snooze).
- Pi tab type: `pi` command, `--session-id`, bundled status extension (`-e`), hook server.
- Claude/Codex tabs (keep working; not the focus of this fork).
- Claude chat tab (Agent SDK, not a PTY) and agent activity in the sidebar — merged from upstream (`c4706c2`). Keep working; not the focus of this fork.
- File tree → Monaco editor (syntax + save, no LSP).
- Git status/diff/commit, worktrees, SSH remotes (with idle ControlMaster reaping), embedded browser.

Known gaps this fork must treat as work, not surprises:

- Windows packaging: the portable folder (`npm run build:win` → `dist/win-unpacked`) stays the no-admin escape hatch; Phase 5 added a per-user NSIS Setup.exe (`npm run build:win:setup`). Both are unsigned until a certificate exists. From-source `npm install` on Windows still needs admin + VS Build Tools + Spectre libs (see README).
- Local Windows terminals are Git Bash (`Git\bin\bash.exe --login -i`, auto-detect; Settings can set a `bash.exe` path). PowerShell and Command Prompt are not product surfaces. Login-shell env **is** captured in `shell-env.ts`; do not copy that Unix PATH onto `process.env.PATH` (ConPTY `cmd.exe` lookup breaks — see AGENTS.md).
- POSIX assumptions: worktree paths, hook inject (`curl` + `python3`). Remote Pi extension lives under `$HOME/.devtool-remote/` (Phase 2 moved it off `/tmp`).

**Go/no-go:** if Git Bash + ConPTY + Pi TUI is unusable after Phase 0, stop. Nothing else in this plan can paper over a broken terminal.

---

## Phase 0 — Windows + Git Bash + PATH (make-or-break) — done (`0.2.0`)

**Outcome:** unzip-or-dev-run on Windows, open a task, get a Git Bash tab, run `pi` with the user’s existing Pi config, status dot still works.

Work items:

1. **Default shell on Windows** — done.  
   Resolve `Git\bin\bash.exe` (Program Files, user install, `PATH`; prefer `Git\bin` over `usr\bin`). Spawn with `--login -i`. Do not use inherited `SHELL`. Empty `defaultShell` auto-detects Git Bash. Override path is optional. New tabs only. PowerShell / Command Prompt are not Settings options.

2. **Spawn environment** — done for Phase 0.  
   Replace the “skip win32” shell-env path. Build env explicitly:
   - prepend portable Node directory
   - conda env prepend is **Phase 3**, not required for 0.2.0
   Apply the same env to terminal tabs **and** Pi/Claude/Codex tabs. Do not add inference URL/key vars here — Pi already has its own settings.

3. **node-pty** — done.  
   `@electron/rebuild` compiles ConPTY from source. That needs admin + VS 2022 Build Tools + **Spectre-mitigated libs** (`MSB8040` otherwise). Documented in README. Do not disable Spectre. Do not chase `chrome-sandbox` setuid (Linux-only). Locked-down PCs skip compile: consume `npm run build:win` output.

4. **Path and quoting** — done.  
   File-tree relatives and git porcelain use `/`. Worktree + nested project joins use win32 locally. `node-pty` `cwd` stays a Windows absolute path (ConPTY); Git Bash shows `/f/...` itself. Do not feed `/c/Users/...` to CreateProcess.

5. **Hooks on Windows** — done for local.  
   Claude inject uses `curl`. Git Bash usually has it; fail clearly if not. Pi extension is local `-e` (no `/tmp` required for local). SSH remotes can wait until after Phase 0.

6. **Packaging** — done for the portable folder.  
   `npm run build:win` runs `electron-builder --win --dir`. The exe is left unsigned so the build does not need winCodeSign / symlink privileges. Prefer “folder next to a Node zip” for locked-down PCs. This is **run-only**; git checkout + `npm run dev` still needs the VS machine. A per-user NSIS Setup.exe, signing, auto-update, and app icon are **Phase 5** (electron-builder NSIS, not `electron-winstaller`).

**Verify:** done on Windows (`npm run dev` → Git Bash tab → portable Node → Pi TUI + inbox status).

**Closeout:** done. `package.json` is **0.2.0**. License is **MIT** (`LICENSE`; copyright join3r and TeleporterGuy).

**Effort:** about 2–4 focused weeks. Next is Phase 1 (file explorer). Conda is Phase 3.

---

## Phase 0.5 — Do not duplicate Pi’s settings in DevTool — done (no version bump)

**Outcome:** DevTool hosts Pi; inference (models, API, base URL) stays in Pi’s own config. A Pi tab should behave like `pi` already does in Git Bash.

Work items:

- Do **not** add inference URL/key fields to DevTool. — done. Project settings only keep extra CLI flags (`aiToolArgs`).
- Per-project extra `pi` args already exist (`aiToolArgs`); keep that for CLI flags, not for wiring a proxy. — done.
- Keep using the existing Pi status extension; only thicken it if permission prompts are invisible in the inbox. — done (unchanged).

**Closeout:** done. Guardrail held; nothing to ship. `package.json` stays **0.2.0**. Next is Phase 1 (file explorer).

**Effort:** none as a feature. This phase is a guardrail so later work does not grow a second settings UI.

---

## Phase 1 — File explorer that can manage a tree — done (`0.3.0`)

Upstream tree can list and open files. Extend it; do not replace it.

**Outcome:** create / rename / delete files and folders, plus a quick filter in the Files panel. Optional: reveal in Git Bash.

Stay out of: full project search, git graph (see Ideas), VS Code-style explorer features. Handing the **folder** to an external IDE is Phase 1.2, not an in-app IDE.

Work items:

1. **CRUD** — create, rename, and delete files and folders from the Files tree (local projects only). **Landed.**
2. **Filter** — session filter box in the Files panel. **Landed.** (A per-project ignore list was added then removed.)
3. **Reveal in Git Bash** — open a terminal tab whose cwd is that folder. **Landed.**

**Verify:** done on Windows (CRUD / filter / 1.1 toolbar; Open in Cursor and VS Code for small folders and a large git repo). If VS Code seems to do nothing, leftover `Code.exe` processes can already own that folder — quit them in Task Manager and retry.

**Closeout:** done. Phase 1 shipped as **0.3.0**. Phase 1.3 tagged **0.3.1**. Phase 1.4 tagged **0.3.2**. Next is Phase 2 (hook auth + SSH trust). Conda is Phase 3.

**Effort:** 1–2 weeks. Mid-phase **0.2.2** / **0.2.3** followed 1.1 polish. Shipped as **0.3.0** after Windows verify.

---

## Phase 1.1 — Files panel polish (mid-phase)

Not a new numbered phase. Same explorer; small UX follow-ups before `0.3.0`.

Work items:

1. **New file / New folder toolbar** — icon buttons above the filter (VS Code-like; room to add more later). **Landed.**
2. **Reconsider the ignore list** — dropped. The Files tree lists every name, including `.env` / `.git`.

Shipped in **0.3.0**.

---

## Phase 1.2 — Open workspace in an external IDE (mid-phase) — landed

Not a new numbered phase. Same explorer closeout in `0.3.0`: DevTool hosts Pi and the tree; heavier editing happens in the user’s real IDE. This is a **handover**, not a fourth Files/Git/Notes view.

**Chrome:** one control in the **content toolbar** — the row that already has Files, Git, Notes (and the split-pane toggle). Sit it in that cluster, after the panel tabs and before the split button. Click = configured default editor; chevron = other configured editors. It is an action (spawn and leave), so it must not look like a panel tab. Icon: Lucide `ExternalLink` (box + arrow **up-right**), tooltip “Open in {default}”. Secondary: folder context menu next to Reveal in Git Bash, and palette commands (`Open in Cursor`, …). Local projects only. Open the **project folder** (task worktree when that is the cwd), not a single file. **Landed.**

**Settings (required).** Today Settings has Appearance / Terminal / Editor & Diff / AI Tools / Sidebar / Tasks. Editor & Diff is Monaco-only (“Applies to Monaco-backed file editor and diff tabs”). Do **not** overload that copy. Add a second group on that same tab — **External IDEs** — or a small extra settings tab if the list UI needs room. No new Settings category for two binaries.

Minimum fields (same pattern as Git Bash path + Browse on the Terminal tab):

- List of editors: display name, executable path, optional extra args.
- Which one is the **default**.
- Browse (pick the `.exe`) and a **Detect** action for `code` / `cursor` on PATH (VS Code / Cursor first cut).
- Hide or disable the toolbar control when the list is empty, with a tooltip that points at Settings.

Persist on `AppConfig` (app-wide, not per-project). Spawn the process with the folder as the argument (`code <abs-path>` / `cursor <abs-path>`). Do not invent protocol-URL settings unless Detect needs them.

**Spyder** is a conda CLI in the project env. Out of 1.2; pick it up after Phase 3.

**Effort:** small spawn + Settings list + one toolbar split button. Landed in `0.2.y`; shipped in **0.3.0** after Windows verify. Spawn `Code.exe` / `Cursor.exe` (not `cursor.cmd`). If a large repo does not appear in VS Code, quit leftover `Code.exe` processes and retry.

---

## Phase 1.3 — Supported Electron line + blank browser tab (mid-phase) — done (`0.3.1`)

Not a new numbered phase. Tagged **`0.3.1`** after Windows verify. `package.json` minor stays **0.3** until Phase 2.

**Outcome:** `npm run dev` and `npm run build:win` run Electron **43.6.0**. A new browser tab is `about:blank`, not Google. The in-app **webview stays**.

Work items:

1. **Supported major** — landed. Electron **35.7.5 → 43.6.0**. `node-pty` rebuilds via `@electron/rebuild` (direct dep) and a `node-abi` override. `allowScripts` pin is `electron@43.6.0`. `ensure-electron.mjs` runs `install.js` because Electron 42+ skips its own postinstall download.

2. **Keep the webview; guest pages do not get Node** — landed. Explicit `contextIsolation` / `nodeIntegration: false` on the DevTool UI window. `will-attach-webview` strips guest preload/Node. `<webview webpreferences="… nodeIntegration=no …">`. Packaged DevTools stay. CSP still out.

3. **Default browser page is blank** — landed. `BLANK_BROWSER_URL` / `about:blank`. Bare hosts still become `https://…`. Old tabs that stored Google keep that URL until navigated away.

4. **Signing stays considered, not required** — unchanged. `signAndEditExecutable: false`.

**Verify:** done on Windows (`npm install` → `npm run dev` → Git Bash → Pi TUI + hook status dot → blank Browser tab + navigate → Open in VS Code). SSH not part of this closeout. `npm run build:win` is the tagged copy.

**Closeout:** done. `package.json` was **0.3.1**. Next was Phase 1.4 (Windows shortcut labels), then Phase 2 (hooks + SSH).

---

## Phase 1.4 — Windows shortcut map and labels (mid-phase) — done (`0.3.2`)

Not a new numbered phase. Tagged **`0.3.2`**. `package.json` minor stays **0.3** until Phase 2. The Electron menu already uses `CmdOrCtrl`; this is the **visible** map, not new bindings.

**Outcome:** every shortcut that already exists is listed once (menu, palette, tooltips, tab chrome, settings copy) with its **Windows** equivalent, and the UI on Windows shows that map. No new shortcuts. Do not invent a keybinding editor.

Work items:

1. **Inventory what is already bound.** **Landed.** Menu accelerators in `src/main/index.ts`, renderer handlers (`ContentArea`, editor save/preview, palette), and hardcoded ⌘ copy (tab bar, Settings, Browser tab). Files/Git chrome had none.

2. **Visualize Windows keys in the UI.** **Landed.** `src/shared/shortcut-label.ts` formats Electron accelerators. On `win32`, tooltips, palette rows, and titles use `Ctrl` / `Alt` / `Shift`. macOS keeps ⌘. Open Settings stays Mac-only (`Cmd+,`); the palette does not claim `Ctrl+,` on Windows.

Stay out of: remapping, user-defined keys, PowerShell chords, teaching Git Bash its own readline bindings.

**Verify:** labels covered in unit tests on Windows (`Ctrl+W` / `Ctrl+T` / `Ctrl+D` chrome, palette `Ctrl+B`, Open Settings has no `⌘,`). Bindings unchanged.

**Closeout:** done. `package.json` is **0.3.2**. Next is Phase 2 (hooks + SSH).

**Effort:** a short pass. Tagged **0.3.2**.

---

## Phase 2 — Hook authentication + SSH trust — done (`0.3.2`, no minor bump)

Completely new session. Do not mix this with the Electron bump. Landed as a patch on **`0.3.2`** (no numbered bump). **`0.4.0`** is Phase 3 (conda).

The inbox status dot is a local HTTP server (`src/main/hook-server.ts`) on `127.0.0.1` plus, for remotes, `ssh -R` to that port. Pi’s remote helper is written under `$HOME/.devtool-remote/`. SSH uses the user’s `~/.ssh/known_hosts` and `accept-new` for first connect; Remote directory is required. Details: [SECURITY.md](./SECURITY.md).

**Outcome:** a random local process (or a process on the SSH host) cannot spoof inbox events without a secret DevTool minted. Remote Pi code is not planted via `/tmp`. New SSH sessions use `~/.ssh/known_hosts` (no DevTool `UserKnownHostsFile` / `IdentitiesOnly`) and a `0700` control-socket directory.

Work items:

1. **Hook shared secret.** **Landed.** Per-process token when the hook server starts. Pi extension and Claude `curl` hooks send `X-Devtool-Token`. Server rejects POSTs without it (401). Body capped at 64 KiB (413). Bind stays `127.0.0.1`. The reverse forward stays — the secret is what makes a shared remote less able to spoof the inbox.

2. **Pi extension off `/tmp`.** **Landed.** Write `pi-status-extension.mjs` under `$HOME/.devtool-remote/` with directory mode `0700`. Claude remote inject stays in `remoteDir/.claude/` (never `/tmp`). Local `-e` path is already asar-unpacked; left as-is.

3. **SSH (join3r follow-up `ec077fc`).** **Landed, then aligned with upstream.** Control-socket dir `<config dir>/ssh` is still `0700`. Host keys use `~/.ssh/known_hosts` (`StrictHostKeyChecking=accept-new`; a *changed* key fails with a message that names that file). No `IdentitiesOnly`. Remote directory is required (no `$HOME` probe / `projects.json` write-back). A full SSH CA can wait for a company install.

Stay out of: config-dir `0700` for all of `~/.devtool`, scrollback `tabId` sanitizing, IPC cwd allow-list (deferred). Stay out of conda.

**Verify:** unit tests cover 401/413, remote Pi path, `~/.ssh/known_hosts` / no `IdentitiesOnly`, required remote dir, and 0700 sockets. Machine check done: local Pi/Claude status dots and a Windows Git Bash pass.

**Closeout:** landed. `package.json` stays **0.3.2** (no numbered bump this pass). Next is Phase 3 (conda spawn picker).

**Effort:** about a week. Windows + Git Bash local hooks, then one Linux SSH box.

---

## Phase 3 — Conda as a spawn picker — done (`0.4.0`)

Was Phase 2. **Outcome:** pick an env per project. Every local PTY inherits it, and notebook kernels use the same spawn env. No env-create/delete UI.

Work items:

1. **Detect conda** — done. Anaconda / Miniconda / Miniforge / micromamba via `CONDA_EXE` / PATH / well-known install dirs (including when Electron's PATH is thin).
2. **List + persist** — done. Project Settings dropdown on local projects; value is the env **prefix** (unique), label is the name. Persist `condaEnvPrefix` plus `condaEnvName`. Remote and shell-command projects stay out (those PTYs are not a local conda).
3. **Activate** — dual path, not PATH-prepend only.

   - **Pi / Claude / Codex** (spawned as binaries, not through Git Bash): PATH prepend + `CONDA_*`, same pattern as Settings → Node directory. Do **not** `eval "$(conda shell.bash hook)"` — that hook would miss CreateProcess agent tabs. Prepend env dirs first (`prefix`, Windows `Library\\…\\bin` / `Scripts` / `bin`, Unix `prefix/bin`), then install `condabin`/`Scripts` so `conda.exe` still resolves when the shell function is missing. Sets `CONDA_PREFIX` / `CONDA_DEFAULT_ENV` only when the prefix still looks like a conda env and at least one PATH dir exists. Portable Node stays **first**.
   - **Interactive terminals**: login shell still runs (conda init often `conda activate base`), then wrap with `conda activate` for the project env (`CONDA_AUTO_ACTIVATE_BASE=false`). macOS: `zsh -l -i -c '…; exec zsh -i'`. Windows Git Bash: `bash --login -i -c` then `exec bash --rcfile <Node mkdtemp file> -i` so conda init in `.bash_profile` is not dropped by a non-login inner shell. The rcfile is created from Node; if temp creation fails the wrap is skipped (fail closed — no guessable `$$` path).

   Spawn prefers a still-valid saved prefix; name lookup is a fallback and is unique-only (Windows case-insensitive only when a single env matches). Apply to terminal **and** agent tabs (project id is passed on local spawn). Notebook kernels reuse `getShellEnv(..., { condaEnv })` the same way.

**Verify:** unit tests cover detection, `conda env list --json` / filesystem listing, dead cache vs live prefix, Windows PATH order, Node-dir remaining first, `process.env.PATH` not overwritten, Windows wrap script never embedding a `$$` temp name, and Project Settings saving prefix+name. `which python` / `python -c "import sys; print(sys.prefix)"` in a Windows Git Bash tab is a **human check still required**.

**Known limits**

- Older macOS conda init can hardcode `conda activate base` after the inner `exec zsh -i`; the wrap sources `conda.sh` again before activate, but exotic rc files may still fight it.
- Env deleted or renamed after save: spawn ignores a dead prefix (then unique name / null). Settings keeps a “(saved)” option until refresh.
- Pi/Claude/Codex are PATH + `CONDA_*` only — packages that need `etc/conda/activate.d` hooks may differ from a fully activated terminal.
- micromamba-only: list and PATH prepend can work while shell `conda activate` no-ops (`micromamba activate` is tried; still fail-soft).
- Custom installs outside well-known roots need `conda env list`, `~/.conda/environments.txt`, or PATH/`CONDA_EXE`.
- Already-open tabs keep the old env until a **new** tab.

**Closeout:** done. `package.json` is **0.4.0**. Next is Phase 4 (native `.ipynb` notebook tabs). Spyder as an external IDE can follow this, still out of 1.2.

**Effort:** 1–2 weeks. Windows + Git Bash activation is the only tricky part. Ships as **`0.4.0`**.

---

## Phase 4 — Native in-app notebooks — done (`0.5.0`)

Was going to be “Open JupyterLab in a browser tab.” That path was tried (PR #9) and **closed unmerged on purpose**. Browser JupyterLab is **not** Phase 4 and is not coming back.

**Outcome:** a usable `.ipynb` tab inside DevTool (cells, execute, outputs — VS Code–like, not Lab-in-webview).

Work items:

1. **Open / save** — clicking a `.ipynb` in the Files tree opens a `notebook` tab (same tab system as `editor`). Save writes nbformat 4. Empty new files become a one-cell notebook.
2. **Cells** — markdown + code (raw kept). Only the focused, expanded cell mounts Monaco (the edit surface). Idle code cells are a highlighted read-only preview (highlight.js — they should look like code, not markdown prose); markdown idle cells stay rendered preview. Collapse hides source (`jupyter.source_hidden`); outputs stay visible under the header. Add / delete / change type / reorder. Reorder (and similar list splices) unmounts every Monaco host *before* the cells array mutates, then remounts — many live editors + DOM reorder was crashing monaco-react (`InstantiationService has been disposed`). Active-only + suspend-on-reorder is the intended architecture, not a missing-color regression.
3. **Kernel** — `jupyter_client` + ipykernel in the **project default conda env**, with an optional per-notebook override in `metadata.devtool.condaEnv` (`getShellEnv` / same PATH as Pi/agent tabs). Toolbar env picker. Run cell / run all. Stream text, `text/plain`, PNG, and errors. Kernel status (idle / busy / dead) + restart.
4. **Clear errors** — no conda env, missing `python`, or missing `jupyter_client` / `ipykernel` fail with an install hint, not a blank tab.

Stay out of: full VS Code notebook parity (debug, variable explorer, collaborative, ipywidgets), JupyterLab as a managed server, inference settings in DevTool, LSP, packaging, agent context links (Ctrl+L / Ctrl+Shift+L — Phase 4.5, not this closeout).

**Remote SSH notebooks** are out of this PR (local projects only). Say so in the tab if you open an `.ipynb` on a remote project.

**Verify:** unit tests for parse/serialize, kernel message handling (mocked), conda python wiring, and execute/run-queue helpers. GitHub Actions `ubuntu-latest` runs typecheck + Vitest (live kernel skipped). `windows-latest` installs Miniconda + `ipykernel`/`jupyter_client` and runs the same suite plus live helper smoke (`NOTEBOOK_LIVE_REQUIRED=1`): conda/`python.exe` resolve, real `jupyter_client` spawn, execute stdout, queued second cell (Run all / Run-above at the kernel gate), interrupt, restart. **Manual on a Windows box — done:** Electron UI — toolbar Run all / per-cell Run all above buttons and tooltips, Monaco, collapse, conda picker chrome. Local live smoke (Git Bash): `NOTEBOOK_LIVE=1 npm test -- tests/notebook-kernel.live.test.ts` with those packages in a conda env.

**Closeout:** done. `package.json` is **0.5.0**. Next is Phase 4.5 (agent context links from editor/notebook), then Phase 5 (packaging + app identity). LSP stays parked.

**Effort:** a focused pass on the existing Electron/React/Monaco tab patterns. Ships as **`0.5.0`**.

---

## Phase 4.5 — Agent context links from editor/notebook (mid-phase) — done (`0.5.1`)

Cursor-style Ctrl+L (selection) / Ctrl+Shift+L (whole file), pulled out of the parking lot. Builds on Phase 4 (notebook tabs), Monaco, and the existing agent tabs. Not packaging, so it is a mid-phase patch tag like 1.3 / 1.4, not a minor.

**Outcome:** select lines in an editor tab (or a notebook cell), press Ctrl+L, and a **compact link** to that selection lands in the task's agent input — Pi / Claude / Codex terminal, or the Claude chat composer. The link is a reference the agent can resolve by reading the file, not the pasted text. Nothing is sent; the user keeps typing and presses Enter themselves.

Work items:

1. **Link format.** A clean `@path` token (workspace-relative, forward slashes) with the range in words — `@src/foo.ts (lines 10-24)`, `@src/foo.ts (line 7)`, `@src/foo.ts`, `@analysis.ipynb (cell 4, id 3c8d9b5c, lines 9-21)`. Works as intended in Codex (and matches Cursor's Ctrl+L feel); Claude Code expands `@path` into the whole file, accepted for now. Cells are named by 1-based position, plus the nbformat `id` only when the file stores it; notebooks without stored ids (nbformat < 4.5) get stable stand-in ids (`cell-N`) instead of random ones that changed on every re-read. Paths with spaces are quoted. Unsaved buffers are saved before linking. Helpers: `src/shared/agent-link.ts`.
2. **Target.** The task's agent tab (Pi / Claude / Codex PTY, or Claude chat) last **typed** in; before any typing, an agent tab showing in a pane. An agent in the right pane of a closed split: the split opens. No agent tab → a short notice, not a silent no-op. Optional later: a picker when several agent tabs are open; "one agent per task" as a Settings option is in the parking lot.
3. **Insert, do not submit.** PTY: bracketed paste, no newline, once the PTY is attached and the agent TUI has turned bracketed paste on (10 s fallback) — links to a starting or not-yet-resumed tab are queued, not lost. Chat: inserted at the composer caret. Focus moves to the target so the user can keep typing.
4. **Shortcuts.** Active only in editor and notebook tabs (terminal Ctrl+L still clears the screen).
   - **Ctrl+L** (macOS Cmd+L) — link the **selection**. No selection → the current line (editor) or the whole focused cell (notebook).
   - **Ctrl+Shift+L** (macOS Cmd+Shift+L) — link the **whole file** (`@src/foo.ts`, `@analysis.ipynb`).
   - **Not Ctrl+K:** that is DevTool's command palette (`src/renderer/palette/usePaletteHotkey.ts`, capture phase, wins over Monaco).
   - **Not Ctrl+Alt+…:** on Windows Ctrl+Alt is AltGr, which layouts like Slovak need for `@`, `{`, `[`.
   - These override two Monaco defaults inside DevTool: Ctrl+L (expand line selection) and Ctrl+Shift+L (select all occurrences; Ctrl+F2 still covers most of that). Same trade Cursor makes.
   - Also a context-menu entry in the editor and on the notebook cell header, and file-tree right-click → link the whole file. List both shortcuts in the Phase 1.4 shortcut map with Windows labels.
   - **Discoverability:** a small "Add to agent Ctrl+L" (⌘L) chip at the end of a non-empty selection in editors and notebook cells, shown only when the task has an agent tab; clicking it links like the shortcut.

Stay out of: pasting full selection text into the PTY, a DevTool-side resolver/index for links, remote SSH notebooks (still local-only), inline edit (Cursor's Ctrl+K edit-in-place is not this — Ctrl+K stays the palette), LSP.

**Verify:** unit tests for link formatting (paths with spaces, Windows paths, notebook cell ids, single-line vs range), stable stand-in cell ids, target selection, editor/notebook/composer wiring. Manual — done: Pi on Windows (Git Bash) and Codex on macOS receive the link without executing and read the right lines/cell; Claude Code receives it, attaches the whole file for `@path` and finds the section from the cell/lines (accepted).

Tried and dropped during testing: a bare `path (lines …)` without `@` (Claude attached nothing), and pasting the selected lines as a fenced snippet (not the Cursor/Codex feel wanted).

**Closeout:** done. `package.json` is **0.5.1**. Next is Phase 5 (packaging + app identity).

**Effort:** a short pass. Shipped as **`0.5.1`**.

---

## Phase 5 — Packaging, distribution, app identity — done (`0.6.0`)

Was going to sit behind language servers as a later phase. LSP is parked, so packaging is the next numbered phase after native notebooks (and the 4.5 context-links patch). **Packaging and making the app look like DevTool, not Electron.**

**Outcome:** Windows users who cannot `npm install` get a real install path, without dropping the portable folder. The app no longer looks or identifies as stock Electron on any platform.

Work items, in this order:

1. **Keep the portable folder.** `npm run build:win` → `dist/win-unpacked` stays the no-admin escape hatch. Do not delete it when an installer lands. Recipients who cannot run Setup.exe still copy a folder and run `DevTool.exe`.
2. **App icon.** There is none today (nothing in `build/`; exe, Dock, taskbar, and window all show the Electron icon). Add a source icon under `build/` (`icon.png` 1024², plus generated `icon.ico` / `icon.icns`) and wire it for electron-builder (`win` / `mac` / `linux`), `BrowserWindow` `icon` on Windows/Linux, and the NSIS installer + Start Menu shortcut. Dev runs: set the Dock icon via `app.dock.setIcon` on macOS.
3. **App name — stop identifying as "Electron".** Seen on macOS: the bold menu-bar app name says **Electron**. Cause: the macOS menu bar uses the bundle's `CFBundleName`, not the menu label; `npm run dev` runs `node_modules/electron/dist/Electron.app`, whose `Info.plist` says `Electron` (and `app.name` falls back to package `name`, lowercase `devtool`). Fix: extend `scripts/patch-dev-electron-plist.mjs` to set `CFBundleName` / `CFBundleDisplayName` to `DevTool`, and call `app.setName('DevTool')` early in main. Packaged macOS builds get `productName` — confirm the menu bar, About panel, and Activity Monitor say DevTool. Windows: `win.signAndEditExecutable` is `false`, so `DevTool.exe` keeps Electron's version resources (Task Manager / file properties say "Electron", Electron icon) — turn exe editing on (rcedit) even before signing, and call `app.setAppUserModelId('com.devtool.app')` so taskbar grouping and notifications say DevTool.
4. **NSIS Setup.exe** via electron-builder (`--win nsis`, not `electron-winstaller`). Default **per-user** (no admin), Start Menu shortcut. Machine-wide / Program Files is optional later, not the default.
5. **Authenticode signing** after the installer exists. Unsigned Setup.exe is a worse first impression than an unsigned folder; do not ship NSIS as the recommended path until signing is in reach, unless IT already accepts unsigned.
6. **Auto-update** (GitHub Releases + electron-updater, or equivalent) after signing. Unsigned auto-update is not worth it.

Items 2–3 are small and independent of the certificate; they can tag as `0.5.x` before the installer lands.

Software Center / MSI may be a **separate IT artifact**, not this phase’s default output.

**Status (landed in `0.6.0`):**

- **2. Icon** — landed. `build/icon.png` is generated from join3r's iOS app icon (`npm run make-icon` → `scripts/make-icon.mjs`: macOS grid, rounded corners, transparent padding); electron-builder derives `.ico` / `.icns`. Window icon on Windows/Linux, Dock icon in macOS dev runs.
- **3. Name** — landed. `app.setName('DevTool')` with userData pinned to its old path (dev stays on `<appData>/devtool`, not merged into the packaged `DevTool` profile). Dev `Electron.app` plist gets `CFBundleName` / `CFBundleDisplayName` (postinstall + `predev`). Windows: an `afterPack` hook (`scripts/win-rcedit.cjs`, `rcedit` npm package) stamps icon + version resources with no certificate (exe stays unsigned), and `setAppUserModelId('com.devtool.app')` (`.dev` for dev runs). `signAndEditExecutable` stays `false`: on Windows, electron-builder's own rcedit step unpacks `winCodeSign`, and 7-Zip fails on its macOS symlinks without Developer Mode / admin (seen on the build machine). electron-builder then only signs the NSIS installer/uninstaller, so the `afterPack` hook calls `scripts/sign-win.cjs` on `DevTool.exe` itself (no-op without `DEVTOOL_SIGN_CMD`).
- **4. NSIS** — landed. `npm run build:win:setup` → per-user `DevTool-Setup-<v>.exe` (no admin, Start Menu shortcut, never touches `~/.devtool`) + portable zip. `npm run release:win` uploads a draft GitHub Release from the Windows box.
- **5. Signing** — wired, dormant. No certificate. `scripts/sign-win.cjs` runs `DEVTOOL_SIGN_CMD` when set (token/cloud-HSM certs sign through a command, not a `.pfx`). Options to look at when it matters: Certum Open Source Code Signing, SignPath Foundation (needs CI builds), Azure Artifact Signing (check eligibility). Stem (`join3r/stem`) does not sign on Windows either.
- **6. Updates** — landed, stem's model. Every packaged build checks GitHub Releases (Settings → Updates, Check for Updates…, opt-out toggle). Unsigned builds only announce a new version and open its page; only a `--signed` Setup.exe install self-updates via electron-updater. Unsigned releases carry no `latest.yml`.

Stay out of: language servers, conda GUI, a second Windows shell, reviving JupyterLab-in-browser.

**Verify:** unit tests for version compare, release-redirect parsing, update-mode decision (signed NSIS vs portable vs dev), manual-check states, the config toggle and the sign hook. **Windows (Windows 11, 2026-10-01) — done:** `build:win` exe carries DevTool icon + version resources (unsigned), taskbar / title bar / Task Manager say DevTool, Git Bash + Pi tabs start; `build:win:setup` installs per-user without UAC under `%LOCALAPPDATA%\Programs\DevTool`, Start Menu shortcut, pinning groups on one button, `app-update.yml` names the fork; Settings → Updates and Help → Check for Updates… report up to date (no releases yet); uninstall keeps `~/.devtool`; dev runs group separately and update checks are off. **macOS — done:** dev and packaged `build:mac` say DevTool with the icon; dev userData stays `devtool`; packaged update check is `manual`. Not run: offline check (unit-tested).

**Closeout:** done. `package.json` is **0.6.0**. Authenticode + self-update are wired but dormant until a certificate (then `release:win --signed`, a `0.6.x` patch). Next is Phase 6 (Pi chat tab).

**Effort:** icon + name an evening; installer + updater a few evenings; signing waits on a certificate. Shipped as **`0.6.0`**.

---

## Phase 6 — Pi chat tab (GUI over `pi --mode rpc`)

Same idea as the Claude chat tab merged from upstream (`c4706c2`, `src/main/claude-chat/` + `src/renderer/components/claude-chat/`), but for Pi. An **extra tab type** next to the Pi TUI tab, not a replacement: extensions that draw their own TUI (`ctx.ui.custom()`) only work in the terminal.

**Product bet:** this touches “Pi remains a CLI TUI in a tab.” Revisit the bet wording when implementation starts, not before. Pi still runs the agent; DevTool only renders it.

**Outcome:** open a Pi chat tab on a task, get a timeline (streaming text, thinking, tool rows, notices), a composer, extension dialogs as cards, resume of Pi sessions, and the same inbox/sidebar status as the Pi TUI tab.

**Transport:** `pi --mode rpc` — JSONL commands on stdin, responses + events on stdout ([Pi RPC docs](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/rpc.md), [commands](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/rpc-commands.md), [extension UI](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/rpc-extension-ui.md)). Plain pipes, no PTY — simpler on Windows than ConPTY + the `pi.cmd` wrapper. `prompt` returning is not completion; wait for `agent_settled`.

Work items:

1. **Main: Pi session.** One `pi --mode rpc` child per tab (like `chat-session.ts`), spawned with the Pi tab env (`shell-env.ts`: Git Bash PATH, Node directory, conda, `aiToolArgs`). Remote projects via ssh stdio, reusing `claude-chat/remote-spawn.ts`. Handle stderr, exit, restart, backpressure.
2. **Shared: agent-neutral chat model.** Split `src/shared/claude-chat.ts` into a neutral `ChatState` / `ChatItem` / reducer plus per-agent adapters (Claude SDK messages, Pi RPC events). Map Pi `message_update` deltas → text/thinking, `tool_execution_*` → tool rows, queue events → queued user rows, retry/compaction → notices. Same snapshot-then-events flow so every window draws the same thing. Untyped JSON on purpose: a renamed field degrades a row, not the tab.
3. **Prompt cards = extension UI.** Pi has no built-in permission prompts. `extension_ui_request` `confirm` → Allow/Deny card, `select` → choice list, `input` / `editor` → text card; answer with `extension_ui_response`. `notify` → notice row; `setStatus` / `setWidget` / `setTitle` → tab footer/status.
4. **Composer.** `prompt` (with images); while running, `steer` vs `follow_up`; Stop → `abort`. Model picker from `get_available_models` / `set_model` and a thinking-level control (`set_thinking_level`) — Pi’s own configured models only, nothing stored in DevTool (Pi owns inference). Slash menu from `get_commands`. Phase 4.5 links (`@path:lines`) insert here too.
5. **Sessions.** Resume with `switch_session` + `get_messages`; `new_session`; `set_session_name`. Fork / tree (`fork`, `get_tree`) later, not v1.
6. **Usage + status.** Usage meter from `get_session_stats` (tokens / cost). Inbox + sidebar activity straight from RPC events (working / needs you on an open extension dialog / settled), not the injected `pi-status-extension.mjs`.

Stay out of: replacing the Pi TUI tab, DevTool-side model/API config, rendering `ctx.ui.custom()` components, a Pi fork/tree UI in v1, reimplementing Pi features in Electron.

**Verify:** unit tests for the Pi event → `ChatState` adapter (recorded RPC transcripts as fixtures), extension-UI request/response round-trip, and spawn env. Manual on Windows (Git Bash env, portable Node, conda) and one SSH remote: prompt, steer mid-run, abort, confirm dialog from an extension, resume, usage meter, inbox dot.

**Effort:** renderer mostly reused from Claude chat; new work is the Pi session in main and the event adapter. Roughly 2–3 weeks of evenings. Ships as **`0.7.0`**.

---

## Ideas (not sequenced)

Parking lot. Do not start these instead of the numbered phases. Several items already have a home:

| Idea | Where it lives |
| --- | --- |
| Supported Electron line + blank browser tab | Phase 1.3 |
| Map existing shortcuts and show Windows keys (Ctrl, not ⌘) | Phase 1.4 |
| Hook auth + Pi off `/tmp` + SSH via `~/.ssh/known_hosts` (required remote dir) | Phase 2 |
| Conda env on spawn | Phase 3 |
| JupyterLab in a browser tab | Dropped. PR #9 closed unmerged. Not Phase 4. |
| Language servers (Python, Markdown) | Parked. Monaco covers edit/view; analysis belongs in Pi. Optional sugar only if Monaco-without-Pi is painful. No minor reserved. |
| Native notebook cells + kernel | Phase 4 (`0.5.0`) |
| Agent context links from editor/notebook (Ctrl+L / Ctrl+Shift+L) | Phase 4.5 (`0.5.1`) |
| Windows installer + Authenticode + auto-update + app icon + app name (not "Electron") | Phase 5 (`0.6.0`; signing dormant until a certificate) |
| Open workspace in VS Code / Cursor | Phase 1.2 |
| Spyder as an external IDE | after Phase 3 |
| Config-dir `0700`, scrollback id, IPC cwd allow-list | Parking lot (deferred; not packaging) |
| One agent per task (Settings option) | Parking lot. Phase 4.5 links go to the agent last typed in; a setting could instead limit a task to one agent tab. |
| Machine-wide / Program Files install | Optional later; Phase 5 default is per-user NSIS |
| Software Center / MSI | Separate IT artifact, not the Phase 5 default |

**Language servers (Python and Markdown).** Parked, not a numbered phase. Monaco already highlights and saves. Hover / go-to / complete would be sugar; diagnostics and deeper analysis belong in Pi extensions. A spike (`monaco-languageclient` + JSON-RPC stdio, `pylsp` or `pyright` in the same conda env, Windows paths that round-trip) is only worth it if people are living in Monaco without a Pi tab. Out of scope even then: every language, debugger, refactor-rename-across-repo, duplicating Pi-quality diagnostics. No minor is reserved for this. Phase 5 is packaging, not LSP.

**Native `.ipynb` cells in a tab** (kernel via `jupyter_client` in the conda env). This **is** Phase 4 (`0.5.0`). Browser JupyterLab is not a substitute and was dropped.

**Agent context links from editor/notebook** (Ctrl+L / Ctrl+Shift+L). Pulled into **Phase 4.5** (`0.5.1`). See that section.

**TypeScript/JavaScript LSP** if the Node zip is the runtime. Same parking lot as Python/Markdown LSP, not a follow-on phase.

**Windows OpenSSH** for the existing remote-project flow (separate from Git Bash local). Parking lot.

**Search-in-files, extra pane layouts.** Parking lot.

**Git tree.** A branch/commit graph in the UI (log, parents, maybe checkout). Useful for “where am I” without leaving DevTool. Phase 1 explicitly stays out of a git graph so the file explorer does not grow into an IDE. If it happens, it is later-maybe: read-only first, no rebase UI. Not packaging. Not numbered until something earns it.

**Generate commit message with a specified agent.** Pre-fill the existing git commit box from Pi (or Claude/Codex) given the staged diff. Low confidence this needs a DevTool feature: you can already ask Pi in a tab to write the message and paste it. Only worth it if the commit UI is used a lot and the round-trip is annoying. Prefer “use the project’s default agent” over a per-commit picker.

**Open this workspace in an external IDE.** Sequenced as **Phase 1.2**. Spyder waits for conda (Phase 3).

Explicit non-goals unless the product bet changes: cloud VMs, embedding Pi’s UI, replacing Pi extensions with Electron linters, PowerShell, full Windows “IDE.”

---

## Suggested order of PRs / commits on this fork

Keep upstream `master` as a remote (`upstream`) and rebase or merge periodically. Land work in this order so each PR is demoable:

1. Windows shell resolution + Git Bash PTY + documented rebuild. **Done** (Git Bash default + Settings presets; portable Node PATH and rebuild docs landed earlier).
2. Configurable spawn PATH (portable Node) + env passthrough. **Done.**
3. Win dir packaging notes / script. **Done.** (`npm run build:win` → `dist/win-unpacked`.) Keep this folder when Phase 5 adds an installer.
4. File explorer CRUD. **Done** in `0.3.0` (filter, Reveal in Git Bash, 1.1 toolbar, 1.2 external IDE handover; ignore list removed).
5. Open workspace in external IDE (Phase 1.2: toolbar split button + Settings list). **Done** in `0.3.0`.
6. Supported Electron line + blank browser tab (Phase 1.3). **Done** in `0.3.1`.
7. Windows shortcut map + labels (Phase 1.4). **Done** in `0.3.2`.
8. Hook authentication + SSH trust (Phase 2). **Done** in `0.3.2` (no minor bump).
9. Conda env picker on spawn (Phase 3). **Done** in `0.4.0`.
10. Native in-app `.ipynb` notebooks (Phase 4). **Done** in `0.5.0`. Not a JupyterLab browser launcher.
11. Agent context links from editor/notebook (Phase 4.5): Ctrl+L (selection, or current line / cell) and Ctrl+Shift+L (whole file) insert a compact `@path:lines` / cell / file link into the agent terminal or Claude chat. Tags `0.5.1`.
12. Packaging + app identity (Phase 5): keep portable `dist/win-unpacked`, app icon, app name (not "Electron" in the macOS menu bar / Windows Task Manager), then per-user NSIS Setup.exe + Start Menu, then Authenticode, then auto-update. **Done** in `0.6.0` (signing/self-update dormant until a certificate). Do not revive browser JupyterLab.
13. Pi chat tab (Phase 6): `pi --mode rpc` in main, agent-neutral chat model shared with Claude chat, extension dialogs as cards. Ships as `0.7.0`.

Skip a step only if the previous phase already includes it by accident (e.g. PATH work that makes conda trivial).

---

## How to work on this fork

Day-to-day work happens on the fork, [TeleporterGuy/DevTool](https://github.com/TeleporterGuy/DevTool). Pull requests created by agents or tools (local, GitHub, Cursor cloud, or any other agent) target **the fork** (`origin`, usually `master` or a branch on TeleporterGuy/DevTool), never [join3r/claude-project](https://github.com/join3r/claude-project) directly.

Finished work goes upstream as a separate step, only when TeleporterGuy decides to offer it: merge `upstream/master` into the fork first, then cut a branch from `upstream/master` with the changes that fit upstream and open the PR against join3r/claude-project from there.

```text
GitHub (origin):  https://github.com/TeleporterGuy/DevTool
Local:            this tree
Upstream:         https://github.com/join3r/claude-project
```

```bash
git remote add upstream https://github.com/join3r/claude-project.git
git fetch upstream
```

Upstream will keep moving on macOS/Linux agent-host features. Prefer merging `upstream/master` after Phase 0 so Windows fixes do not bit-rot. If a merge fights POSIX-only code, isolate Windows behind `process.platform === 'win32'` rather than forking every file.

Work machine constraints to re-test every phase: Git Bash, portable Node zip, Pi (whatever setup already works in a Git Bash terminal), conda. Do not declare a phase done from macOS alone.

---

## Effort snapshot (solo, evenings, one Windows box)

| Phase | Ships as | What “done” means | Rough time |
| --- | --- | --- | --- |
| 0 | `0.2.0` (shipped) | Git Bash + Pi in DevTool on Windows | 1–2 months calendar / 2–4 weeks focused |
| 0.5 | (no bump, done) | No DevTool inference UI (Pi keeps its settings) | n/a |
| 1 | `0.3.0` (shipped) | File tree CRUD + 1.2 external IDE handover | 1–2 weeks |
| 1.3 | `0.3.1` (shipped) | Supported Electron + blank browser tab (webview stays) | a few evenings to a week |
| 1.4 | `0.3.2` (shipped) | Existing shortcuts listed and shown as Windows keys | a short pass |
| 2 | stayed `0.3.2` (no `0.4.0` tag) | Hook secret + Pi extension off `/tmp`; SSH uses `~/.ssh/known_hosts` | ~1 week |
| 3 | `0.4.0` (shipped) | Conda picker on spawn | 1–2 weeks |
| 4 | `0.5.0` (shipped) | Native `.ipynb` tabs (Monaco cells + conda kernel) | a focused pass |
| 4.5 | `0.5.1` (shipped) | Ctrl+L selection (or line / cell) and Ctrl+Shift+L whole file → compact link in agent terminal / Claude chat | a short pass |
| 5 | `0.6.0` (shipped) | Portable folder kept; app icon + DevTool name; per-user NSIS Setup.exe; update checks; Authenticode + self-update wired, dormant until a cert | a few evenings |
| 6 | `0.7.0` | Pi chat tab over `pi --mode rpc` (timeline, composer, extension dialogs, resume) | 2–3 weeks of evenings |

Language servers stay in the parking lot. They are not a numbered phase. There is no Phase 7 until something else earns one.

A year of evenings can yield a personal orchestrator. It will not become Cursor. That is success.
