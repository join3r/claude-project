# Plan — findings #7, #8, #9: idle cleanup deletes work it cannot see

Fixes BUGS.md **#7** (deletes an agent running in another window), **#8** (safeguards are never
revalidated before the destructive step) and **#9** (proceeds even when the advertised backup
failed).

**Depends on `PLAN-state-concurrency.md` having landed** — task deletion moves into main and must go
through that plan's `commitProjects` helper so it bumps the revision and broadcasts.

**Chosen approach: main owns live status.** Main already receives every hook event
(`app-runtime.ts` `registerEventForwarders`), owns every PTY runtime, and holds every window's
selection. It is the only process with a complete picture; a renderer's `TabStatusContext` is
per-window by construction (`src/renderer/context/TabStatusContext.tsx`) and therefore structurally
blind to a task running in another window. Rejected alternative: keep the decision in the renderer
and union the windows' views over IPC — smaller diff, but the renderer still acts on a snapshot it
cannot keep fresh across the awaits.

## Step 1 — authoritative activity registry in main

New `src/main/tab-activity-registry.ts`, owned by `AppRuntime`:

- Records `status` (`working` | `attention` | `exited` | null) and `since` per `tabId`, fed from the
  same hook events `registerEventForwarders` already forwards (`session-start`, `working`,
  `stopped`, `notification`). Keep forwarding to renderers unchanged — this is an additional
  consumer, not a replacement.
- Exposes whether a live PTY runtime exists for a tab (`this.ptyRuntimes`), which is what catches the
  #7 case: `AiToolTab` deliberately leaves a hidden tab's PTY running, so a background agent is
  live even though no window shows it as working.
- Entries are dropped when the PTY exits and the tab is removed.

Mirror the renderer's status semantics exactly. If the two ever disagree about what "working" means,
cleanup silently regains a blind spot — factor the shared predicate rather than reimplementing it.

## Step 2 — move the sweep into main

- Move the pure candidate selector `src/renderer/components/idleCleanup.ts` to
  `src/shared/idle-cleanup.ts` (it only depends on shared types). Update importers, including
  `tests/idle-cleanup.test.ts`.
- Replace `requestIdleCleanup()` in `src/main/app-runtime.ts:246-253` — which today just picks the
  first live window and delegates the whole decision to it — with a main-side sweep that assembles
  candidates from canonical `projectsData`, config, pinned items, the union of every window's
  selected task, unread state, and the new activity registry.
- Delete `src/renderer/hooks/useIdleCleanup.ts` and the `run-idle-cleanup` IPC once nothing uses
  them, or reduce the hook to a thin notification receiver if the UI needs to react. Do not leave
  two sweep implementations alive.

**Audit `removeTask` in `src/renderer/hooks/useAppState.ts` (around lines 679-710 and 1009-1069)
before writing the main-side deletion.** Whatever teardown it performs — killing PTYs, dropping
scrollback, hook cleanup, tab status removal — must be performed by main now, or explicitly shown to
happen via the broadcast when renderers reconcile their tab trees. Enumerate that teardown in your
report; silently losing a cleanup step here leaks processes.

## Step 3 — revalidate immediately before each deletion (#8)

The sweep awaits workspace checks and a backup between selecting candidates and deleting them. In
that window a user can open, pin, snooze, or receive new agent activity on a candidate, and today it
is deleted anyway (`useIdleCleanup.ts:74-76` removes by ID with no re-read).

Immediately before removing **each individual** task, re-evaluate every safeguard against current
state: pinned, snoozed, unread, open in any window, running/waiting per the activity registry, and
`config.idleTaskCleanup.enabled` (disabling cleanup mid-sweep must stop the remaining deletions).
Skip any candidate that no longer qualifies. `src/renderer/components/Settings.tsx:601-603` promises
these are "always kept" — that promise must hold at the moment of deletion, not at selection time.

Also re-check that the task still exists and still has the same workspace before acting on it.

## Step 4 — the backup must actually exist (#9)

- `src/main/storage.ts:45-61` — `backupProjectsOnStartup` swallows every filesystem error and
  returns `void`. Give it a real result (`boolean` or a thrown error) while keeping the
  never-block-startup behaviour at the startup call site specifically.
- The `backup-projects-now` handler in `app-runtime.ts:359-362` must report real success/failure.
- The sweep **aborts before deleting anything** if the snapshot was not written, and logs why.
  `Settings.tsx:492-494` tells the user `projects.json` is snapshotted before deletion; if that is
  not true, the deletion must not happen.

## Step 5 — regression tests

Extend `tests/idle-cleanup.test.ts`:

1. A task with a live PTY / working status known only through the registry (never attached to the
   window that would previously have swept) is **kept**.
2. A candidate that becomes pinned / snoozed / unread / open / working while an awaited workspace
   check or backup is pending is **not** deleted — defer the async dependency, mutate state, resolve,
   assert no deletion.
3. `idleTaskCleanup.enabled` flipped false mid-sweep stops the remaining deletions.
4. Backup failure aborts the sweep before any workspace or task is deleted.
5. A genuinely idle, unpinned, unopened, silent task with a clean merged workspace is still deleted,
   and its teardown (PTY kill, scrollback, hooks) runs.
6. Deletion bumps the projects revision and broadcasts, so a second window sees the removal.
