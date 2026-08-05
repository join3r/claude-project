# Plan — finding #10: closing an unsaved editor discards the buffer

Fixes BUGS.md **#10**. Dirty content lives only inside `EditorTab`
(`src/renderer/components/EditorTab.tsx:161-168`), and every removal path — Cmd+W in
`ContentArea.tsx:233-237`, the close button in `TabBar.tsx:301-309`, `removeTab` in
`useAppState.ts:1009-1069`, task deletion at `useAppState.ts:679-710`, project deletion at
`useAppState.ts:860-891` — tears the tab down without ever asking whether it is dirty.

**Chosen behaviour: confirm with Save / Discard / Cancel.** Cancel aborts the entire removal,
including task and project deletion. Rejected alternatives: autosave on close (silently commits
edits the user may have meant to throw away, and a write failure has no UI to land in) and
keeping the buffer in a store with no prompt (still loses everything on quit).

**Note:** another agent is concurrently fixing findings #3 and #4 in `EditorTab.tsx` (buffer
survives tab switches; save failures no longer crash the window). Read the file as it stands when
you start — do not assume the line numbers above are still exact, and build on that agent's dirty
tracking rather than adding a parallel mechanism.

## Step 1 — a renderer-wide dirty registry

New `src/renderer/context/DirtyBufferContext.tsx`, modelled closely on the existing
`src/renderer/context/TabStatusContext.tsx` (same store + `useSyncExternalStore` shape, so it reads
as native to this codebase):

```
registerBuffer(tabId, { filePath, isDirty, save: () => Promise<void> })
unregisterBuffer(tabId)
getDirtyTabs(tabIds?: string[]): DirtyBuffer[]
```

`EditorTab` registers on mount, updates on every dirty transition, and unregisters on unmount.
Unregister must be keyed so that the hide/show remount behaviour from finding #3 cannot leave a
stale entry behind or drop a live one.

## Step 2 — one confirmation gate, used by every removal path

Look for an existing confirmation/modal component in `src/renderer/components/` and reuse it —
`NewTaskModal` and the workspace-delete confirmation show the established pattern. Do not introduce
a second modal idiom.

Add a single async gate, e.g. `confirmDiscardDirty(tabIds): Promise<'proceed' | 'cancel'>`, that:

- returns `proceed` immediately when no tab in scope is dirty (the common path must not gain a
  round-trip or a flash of dialog);
- otherwise lists the affected files by name and offers **Save**, **Discard**, **Cancel**;
- on Save, awaits every write and **aborts the removal if any write fails**, surfacing the error —
  this is exactly the failure mode finding #4 is about, so it must not become an unhandled
  rejection;
- on Cancel, performs no removal at all and leaves every buffer intact.

Wire it into all five call sites listed at the top. For task and project deletion the scope is every
editor tab beneath that task or project, and one dialog covers them all rather than prompting per
tab.

Put the gate where every caller can reach it without duplicating the dirty lookup — a helper in
`useAppState` that removal functions await is preferable to each component assembling its own list.

## Step 3 — regression tests

New `tests/dirty-editor-close.test.tsx`:

1. Close a dirty tab via Cmd+W → prompted; **Cancel** leaves the tab open with its buffer intact.
2. Same via the tab-bar close button → prompted.
3. **Discard** removes the tab and does not write to disk.
4. **Save** writes the buffer, then removes the tab.
5. Save fails (mock `fbWriteFile` rejecting) → the tab stays open, the buffer is intact, an error is
   shown, and no unhandled rejection escapes.
6. Deleting a task with two dirty editors prompts once, lists both files, and Cancel deletes
   nothing — no task removal, no tab removal.
7. Deleting a project with a dirty editor behaves the same.
8. Closing a clean tab is unchanged — no prompt, no extra await.

## Out of scope

Prompting on window close / app quit is a related gap but is not finding #10. Note in your report
whether the gate you built is reusable for it; do not implement it.
