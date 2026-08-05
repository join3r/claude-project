# Verified bugs

Audit date: 2026-08-05

Scope: the current checkout, including the existing uncommitted idle-cleanup work. Existing product files were not modified. Each finding below survived an independent adversarial review; speculative candidates were omitted.

## 1. [P1] Workspace safety-check errors fail open and can delete unmerged work

**Evidence**

- `src/main/workspace-manager.ts:59-81` catches failures from both `git status` and `git branch --merged` and converts them to `hasUncommitted = false` / `isUnmerged = false`.
- `src/main/workspace-manager.ts:84-101` then force-removes the worktree and force-deletes the branch.
- `src/main/remote-workspace-manager.ts:202-266` repeats the same fail-open logic remotely.

If a workspace's recorded base branch was renamed or deleted, `git branch --merged <old-base>` exits non-zero. The implementation treats that error as proof that the feature branch is merged.

**Reproduction**

1. Create a workspace from `master`.
2. Commit a change that exists only on the workspace branch.
3. Rename `master` to `main` in the primary worktree.
4. Delete the workspace without `force`.

This audit reproduced `status: "ok"`; both the worktree and the only branch containing the feature commit were deleted.

**Required regression test**

Create an unmerged workspace commit, rename or delete its recorded base branch, call `delete()` without `force`, and assert that the operation fails closed while preserving both the worktree and branch. Status/merge-check timeouts and command failures must also block deletion.

## 2. [P1] Workspace cleanup recursively deletes an unvalidated ordinary directory

**Evidence**

- `src/main/workspace-manager.ts:84-93` falls back from any failed `git worktree remove` to `fs.rmSync(opts.worktreePath, { recursive: true, force: true })`.
- `src/main/remote-workspace-manager.ts:240-257` has the same fallback via `shutil.rmtree`.
- Neither path is verified against `git worktree list`, the expected repository, or the repository's `.worktrees` directory before recursive deletion.

A stale workspace record can point at a path that was removed and later reused for unrelated files. Deleting that task then erases the unrelated directory.

**Reproduction**

Persist a workspace whose `worktreePath` points to an existing ordinary directory that is not a registered worktree, then remove the task/workspace. `git worktree remove` fails and the fallback recursively removes the supplied directory.

**Required regression test**

Pass an existing non-worktree directory as `worktreePath`; assert that it survives and the operation reports an error. Verify the registered worktree path, repository ownership, and branch association before any removal.

## 3. [P1] Switching tabs destroys unsaved file edits

**Evidence**

- `src/renderer/components/EditorTab.tsx:161-166` stores edits only in refs and dirty state; it does not update `content`.
- `src/renderer/components/EditorTab.tsx:168` removes the Monaco editor whenever the tab is hidden.
- `src/renderer/components/EditorTab.tsx:172-183` remounts Monaco from the old disk-backed `content` through `defaultValue`.
- `src/renderer/components/Pane.tsx:143-155` flips `visible` when another tab becomes active.
- The installed Monaco React wrapper disposes the current model on unmount by default (`keepCurrentModel` is false).

**Reproduction**

1. Open a file in an editor tab.
2. Type without saving.
3. Switch to another tab and back.

The edited buffer is replaced by the last disk content. The dirty indicator can remain even though the visible text has reverted.

**Required regression test**

Render an editor, change its value, toggle `visible` false and true, and assert that the remounted editor still contains the unsaved value.

## 4. [P1] A failed file save replaces the entire window with the crash screen

**Evidence**

- `src/renderer/components/EditorTab.tsx:133-150` handles `fbWriteFile` with `.then(...)` but no rejection handler.
- `src/renderer/main.tsx:91-95` turns every unhandled promise rejection into a full-window `CrashScreen`.

An ordinary filesystem error therefore escapes the editor boundary and takes down the whole renderer.

**Reproduction**

Open and edit a file, move/delete the project directory or otherwise make the destination unwritable, then press Cmd/Ctrl+S. The write rejects and the application UI is replaced by the unhandled-rejection screen.

**Required regression test**

Mock `fbWriteFile` to reject, invoke the Monaco save command, and assert that the rejection is handled locally, the buffer is retained, and a recoverable save error is shown.

## 5. [P1] Concurrent windows can silently overwrite each other's project/task changes

**Evidence**

- `src/renderer/hooks/useAppState.ts:207-215` sends each renderer's entire `projectsData` snapshot after a local change.
- `src/main/app-runtime.ts:342-346` replaces the canonical snapshot wholesale and writes it to disk.
- `src/renderer/hooks/useAppState.ts:169-179` applies broadcasts but has no revision, compare-and-swap, mutation queue, or merge for an already pending local update.

Two windows starting from state `S` can independently submit `S + A` and `S + B`; whichever IPC arrives last removes the other window's change.

**Reproduction**

Open two windows from the same state and make near-simultaneous changes, such as adding different tasks. The last full-snapshot save can erase the earlier task.

**Required regression test**

Simulate two renderers mutating the same baseline before either receives the other's broadcast. Assert that both mutations survive persistence.

## 6. [P1] Concurrent windows overwrite each other's notes

**Evidence**

- `src/renderer/hooks/useAppState.ts:124-163` loads notes once per renderer.
- `src/renderer/hooks/useAppState.ts:1462-1474`, `1484-1493`, `1516-1523`, and `1588-1600` save the entire notes record for create, rename, delete, and debounced content edits.
- `src/main/app-runtime.ts:460-461` writes the supplied record without maintaining canonical note state or broadcasting an update.

Unlike projects, notes do not even have a cross-window update subscription. A later save from a stale window deterministically restores or deletes another window's note changes.

**Reproduction**

1. Open two DevTool windows.
2. Edit note A in window 1 and allow it to save.
3. Edit note B from window 2's older snapshot.

The second whole-record save reverts note A on disk.

**Required regression test**

Load two state providers from the same notes snapshot, mutate different notes, persist them in sequence, and assert that both changes survive.

## 7. [P1] Idle cleanup can delete an agent that is running in another window

**Evidence**

- `src/main/app-runtime.ts:246-253` always sends a cleanup request to the first live window.
- `src/renderer/context/TabStatusContext.tsx:28-54` keeps statuses inside each renderer.
- `src/main/app-runtime.ts:272-285` forwards hook status only to windows attached to that PTY.
- `src/renderer/components/AiToolTab.tsx:254-264` deliberately leaves a hidden tab's PTY running.
- `src/main/app-runtime.ts:349-357` considers only each window's currently selected task "open".

A task started in window 2 and then left in the background can still be running while window 1 sees neither an open-task guard nor a working status. Count-based cleanup can then delete the task and kill its PTY.

**Reproduction**

Start an agent in a task that has only been opened in window 2, switch window 2 to another task, and trigger an eligible cleanup from window 1.

**Required regression test**

Give window 2 a running background tab that window 1 has never attached to. Assert that a cleanup executed by window 1 keeps the task.

## 8. [P1] Idle-cleanup safeguards are not revalidated before destructive removal

**Evidence**

- `src/renderer/hooks/useIdleCleanup.ts:29-40` snapshots projects, pins, config, open task IDs, unread state, and renderer-local statuses once.
- `src/renderer/hooks/useIdleCleanup.ts:42-73` can then await multiple workspace deletions/checks and a backup.
- `src/renderer/hooks/useIdleCleanup.ts:74-76` removes the original candidates by ID without re-reading any safeguard.
- `src/renderer/components/Settings.tsx:601-603` promises that pinned, snoozed, unread, open, running, and waiting tasks are "always kept."

A user can open, pin, unsettle, snooze, or receive new agent activity in a candidate while the sweep is awaiting I/O; it is still removed. Disabling cleanup during that interval also does not stop the in-flight deletion.

**Reproduction**

Hold a slow workspace operation or backup after candidate selection, protect the candidate while the promise is pending, then resolve it. The task is still deleted.

**Required regression test**

Defer an async dependency, mutate the latest application/status state so the candidate is protected, resolve the dependency, and assert that `removeTask` is not called.

## 9. [P2] Idle cleanup proceeds even when its advertised backup was not created

**Evidence**

- `src/main/storage.ts:45-61` swallows every backup filesystem error and returns no success/failure result.
- `src/main/app-runtime.ts:359-362` therefore reports IPC success even when no snapshot exists.
- `src/renderer/hooks/useIdleCleanup.ts:70-76` also catches a rejected backup call and continues deleting.
- `src/renderer/components/Settings.tsx:492-494` states that `projects.json` is snapshotted before deletion.

**Reproduction**

Make the `backups` path a regular file (while leaving `projects.json` writable), then trigger cleanup. Snapshot creation fails, but tasks are still removed and the new projects state can still be saved.

**Required regression test**

Force snapshot creation to fail and assert that cleanup aborts before any workspace or task is deleted.

## 10. [P2] Closing an unsaved editor loses its buffer without warning

**Evidence**

- `src/renderer/components/EditorTab.tsx:161-168` keeps dirty content only inside the editor component.
- `src/renderer/components/ContentArea.tsx:233-237` and `src/renderer/components/TabBar.tsx:301-309` call `removeTab` directly for Cmd+W and the close button.
- `src/renderer/hooks/useAppState.ts:1009-1069` removes the tab with no dirty-state query or confirmation.
- Task/project deletion at `src/renderer/hooks/useAppState.ts:679-710` and `860-891` is also unaware of editor dirtiness.

**Reproduction**

Edit a file without saving and close its tab, task, or project. The in-memory buffer is discarded immediately. Reopening the tab reloads the disk version.

**Required regression test**

Close a dirty editor through each removal path and assert that the user must explicitly save or discard, and that cancellation retains the buffer.

## 11. [P2] Git operations break for quoted paths and renames

**Evidence**

- `src/main/app-runtime.ts:850-879` parses line-oriented `git status --porcelain` output with `line.slice(3).trim()`.
- Default porcelain output C-quotes paths containing spaces, non-ASCII bytes, and other special characters; rename output also contains a presentation string such as `old -> new`.
- `src/main/app-runtime.ts:900-933` passes that unparsed display string back to Git for stage, unstage, and discard.

The audit reproduced a modified `a b.txt` as the literal string `"a b.txt"`; `git add -- '"a b.txt"'` fails because no file with quote characters exists.

**Reproduction**

Modify a tracked file named `a b.txt`, use the Git panel to stage it, and observe the pathspec failure. Renames and C-quoted non-ASCII names follow the same broken path.

**Required regression test**

Cover spaces, non-ASCII characters, escapes, and renames. Parse a NUL-delimited porcelain format and assert exact raw paths are passed to Git.

## 12. [P2] Automatic SSH reconnect does not restore the configured tunnel

**Evidence**

- `src/main/ssh-connection-manager.ts:582-615` clears the tunnel runtime when a connection probe or health check fails.
- `src/main/ssh-connection-manager.ts:623-643` reconnects the master and restarts health checks, but never recreates the tunnel.
- Tunnel restoration only exists in renderer-triggered `ssh-connect` at `src/main/app-runtime.ts:466-476`.

After automatic recovery, the connection status becomes `connected` while the configured local forward remains absent.

**Reproduction**

Configure a local tunnel, force the SSH master/health check to fail, and allow auto-reconnect to succeed. DevTool reports the SSH project as connected, but traffic through the configured local port still fails.

**Required regression test**

Establish a tunnel, trigger health-check failure, complete auto-reconnect, and assert that the configured tunnel is recreated and reported active before recovery is considered complete.

## 13. [P2] Claude hook refcounts are decremented for tabs that never injected hooks

**Evidence**

- `src/main/hook-injector.ts:83-95` and `145-162` use reference counts to decide when local/remote hooks are removed.
- Counts are incremented only during PTY creation/injection at `src/main/app-runtime.ts:1084-1113`.
- Hidden lazy tabs do not spawn at `src/renderer/components/AiToolTab.tsx:595-609`.
- Every removed Claude tab requests hook cleanup at `src/renderer/components/AiToolTab.tsx:750-769`, whether it spawned or not.

Removing a lazy, never-spawned Claude tab can decrement the count belonging to an active sibling and remove that sibling's hooks. Repeated respawns can cause the inverse leak by incrementing more often than tab removal decrements.

**Reproduction**

Open active Claude tab A so hooks are injected. Add hidden/lazy Claude tab B in the same directory without activating it, then remove B. The sole reference can be consumed and A stops receiving hook-based status events.

**Required regression test**

Track one injected tab and one never-spawned sibling, remove the sibling, and assert that hooks remain until the injected tab is removed. Also cover respawn balance.

## 14. [P2] Selecting a note from another project in all-project palette search is a no-op

**Evidence**

- `src/renderer/palette/sources/notes.ts:10-27` intentionally includes other projects' notes for all-project search.
- `src/renderer/palette/Palette.tsx:161-165` combines the result's project ID with the currently selected task ID.
- `src/renderer/hooks/useAppState.ts:1603-1611` looks for that task only inside the target project and returns when it cannot find it.

**Reproduction**

Select a task in project A, search `#*` for a note in project B, and press Enter. The palette closes, but nothing opens.

**Required regression test**

Select a cross-project note and assert that DevTool navigates to an appropriate task/home in the target project and opens or focuses the note.

## 15. [P2] Cancelling an in-flight workspace creation still creates and selects the task

**Evidence**

- `src/renderer/components/NewTaskModal.tsx:75-81` closes the modal on Escape.
- `src/renderer/components/NewTaskModal.tsx:118-146` does not cancel or invalidate an outstanding `workspaceCreate`; after it resolves, it still invokes `onCreateWorkspace`.
- `src/renderer/components/Sidebar.tsx:1413-1418` then adds and selects the workspace task.

**Reproduction**

Start a slow local or remote workspace creation and press Escape before it completes. The dialog disappears, but the worktree and task appear when the request finishes.

**Required regression test**

Defer `workspaceCreate`, close the modal, then resolve the promise. Assert that no task is added or selected and define an explicit policy for cleaning up a worktree created after cancellation.

## Verification summary

- `npm run build` passed on the current checkout.
- The existing Vitest cases that completed all passed, including the current idle-cleanup tests. Both the default command (which also discovers duplicate suites under `.claude/worktrees`) and a root-only run with `--exclude '.claude/**'` remained alive after every reported test file passed, so they were stopped rather than reported as clean full-suite exits.
- An isolated Git reproduction confirmed finding 1: deleting a workspace after its base branch was renamed returned `status: "ok"`, removed the worktree, and deleted the only branch containing the unmerged commit.
- Independent renderer and main-process discovery passes were followed by a separate adversarial review. Weak or speculative candidates were excluded.
