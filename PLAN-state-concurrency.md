# Plan — findings #5 and #6: concurrent windows overwrite each other's state

Fixes BUGS.md **#5** (projects/tasks) and **#6** (notes). Both are the same defect in two
subsystems: a renderer sends its whole snapshot, main replaces the canonical copy wholesale, and
whichever IPC lands last wins. Notes are worse — they have no cross-window broadcast at all.

**Chosen approach: revision-guarded snapshots (compare-and-swap) with local replay on conflict.**
The snapshot architecture in `useAppState` stays; a CAS layer is added around it. Rejected
alternatives: full intent/operation refactor (correct end state, but rewrites every mutation site in
a ~1600-line hook), and field-level merge in main (silent wrong guesses on array ordering).

## Why replay rather than merge

`useAppState` mutates through `setProjectsData(prev => next)` updater functions. Those updaters are
pure functions of previous state, which makes conflict recovery mechanical: on rejection, reset to
main's canonical state and re-run the still-pending updaters against it. No structural diff or merge
heuristic is needed. This only holds if **every** mutation goes through the wrapper, which is the
main piece of mechanical work in this plan.

## Step 1 — canonical revision in main

`src/main/app-runtime.ts`:

- Add `private projectsRevision = 0` alongside `this.projectsData`, and `private notesRevision = 0`
  with an in-memory canonical `this.notes` loaded once at startup (today `notes-load` /`notes-save`
  proxy straight to `NotesStorage` with no canonical copy in main — that is why notes have no
  broadcast).
- `load-projects` returns `{ revision, data }` instead of bare data. Same for `notes-load`.
- `save-projects` accepts `{ baseRevision, data }` and returns a discriminated result:
  - `baseRevision === projectsRevision` → normalize, persist, `projectsRevision++`,
    broadcast `projects-updated` with `{ revision, data }`, return `{ ok: true, revision }`.
  - otherwise → return `{ ok: false, revision, data: clone(canonical) }` and persist nothing.
- `notes-save` gets the identical treatment, **plus** a new `notes-updated` broadcast that does not
  exist today. Add the matching `onNotesUpdated` subscription to `src/preload/index.ts`.
- Every other place main mutates canonical projects state must bump `projectsRevision` and
  broadcast through one shared helper (e.g. `commitProjects(next)`); do not increment inline in
  several handlers.

Types for the envelopes go in `src/shared/types.ts`; the preload bridge in `src/preload/index.ts`
must be updated in step with them.

## Step 2 — pending-mutation queue in the renderer

`src/renderer/hooks/useAppState.ts`:

- Track `revisionRef` (last revision acknowledged by main) and `pendingRef`, an ordered list of
  `{ id, updater }` entries.
- Add `mutateProjects(updater: (prev: ProjectsData) => ProjectsData)`: pushes the updater onto
  `pendingRef`, applies it locally via `setProjectsData`, and lets the existing save effect fire.
- **Convert every `setProjectsData(...)` call site in the file to `mutateProjects`.** Grep for them
  and convert all; a single missed site silently reintroduces the lost-update bug for that one
  action. Hydration/bootstrap assignment and the broadcast handler are the deliberate exceptions —
  they set canonical state rather than mutating it.
- The save effect sends `{ baseRevision: revisionRef.current, data }`:
  - `ok` → set `revisionRef` to the returned revision, drop the acknowledged updaters from
    `pendingRef`.
  - not `ok` → set state to the returned canonical `data`, replay the still-pending updaters onto
    it, set `revisionRef` to the returned revision, and re-send. Bound the retry loop (e.g. 5
    attempts) and surface a visible error rather than spinning forever.
- Saves must be serialized — one in-flight save at a time, with a trailing send if state changed
  while a save was outstanding. Concurrent saves from one renderer would each carry the same
  `baseRevision` and defeat the CAS.
- The existing `lastSavedProjectsJsonRef` string-compare short-circuit in both the save effect and
  the `onProjectsUpdated` handler must keep working against the new envelope shape — compare the
  inner `data`, not the envelope, or the revision field alone will make every broadcast look new.

## Step 3 — notes get the same treatment

The four whole-record note saves (create, rename, delete, and the debounced content edit — around
`useAppState.ts:1462-1474`, `1484-1493`, `1516-1523`, `1588-1600`) route through a `mutateNotes`
wrapper with its own revision and pending queue, and the renderer subscribes to the new
`notes-updated` broadcast so a second window's note changes actually arrive.

Debounced content edits need care: the debounce must not drop a pending updater on conflict replay,
and replaying a content edit for a note another window deleted must be a no-op, not a resurrection.
Decide that policy explicitly and test it.

## Step 4 — regression tests

New `tests/state-concurrency.test.ts` (and extend `tests/notes-storage.test.ts`):

1. Two renderers hydrate from the same baseline, each adds a different task, both save without
   seeing the other's broadcast → both tasks survive in the persisted state.
2. Same for two different notes → both edits survive.
3. Conflicting edits to the *same* task: the loser rebases onto canonical and its change is applied
   on top rather than lost or duplicated.
4. A delete in window 1 and an edit to the deleted entity in window 2 resolves to the documented
   policy without throwing.
5. A rejected save that keeps conflicting hits the retry bound and reports an error instead of
   looping.
6. Existing `tests/state-hydration.test.ts` and `tests/storage.test.ts` still pass unchanged.

## Downstream note

Finding #7/#8 (idle cleanup) will move task deletion into the main process. That deletion must go
through the same `commitProjects` helper so it bumps the revision and broadcasts — build the helper
with that caller in mind.
