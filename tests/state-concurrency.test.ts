import { describe, expect, it, vi } from 'vitest'
import { RevisionStore } from '../src/main/revision-store'
import { Storage } from '../src/main/storage'
import { RevisionSyncClient, type Updater } from '../src/renderer/hooks/revisionSync'
import type {
  NotesRecord,
  ProjectNote,
  ProjectsData,
  RevisionEnvelope,
  RevisionSaveResult,
  Task
} from '../src/shared/types'

/**
 * These tests wire the real main-side store to the real renderer-side sync clients
 * across a fake IPC boundary. Everything below the React layer is production code:
 * `RevisionStore` is what `app-runtime` registers behind `save-projects`/`notes-save`,
 * and `RevisionSyncClient` is what `useAppState` drives from `mutateProjects` /
 * `mutateNotes`.
 */

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function task(id: string, name = id): Task {
  return {
    id,
    name,
    tabs: { left: [], right: [] },
    activeTab: { left: null, right: null },
    splitOpen: false,
    splitRatio: 0.5,
    lastInteractedAt: 1_000
  }
}

function baselineProjects(): ProjectsData {
  return {
    projects: [
      { id: 'p1', name: 'Project', directory: '/tmp/p1', tasks: [task('t-base')] }
    ],
    tags: [],
    projectOrder: ['p1'],
    pinnedItems: []
  }
}

function note(id: string, content = ''): ProjectNote {
  return { id, name: id, content, createdAt: 1_000, updatedAt: 1_000 }
}

/** Stands in for the main process: canonical store, disk, and the broadcast channel. */
class FakeMain<T> {
  readonly store: RevisionStore<T>
  persisted: T
  private subscribers: Array<(envelope: RevisionEnvelope<T>) => void> = []
  /** Payloads received, in order — used to prove saves are serialized. */
  saveCalls = 0
  concurrentSaves = 0
  private inFlight = 0

  constructor(initial: T, normalize?: (data: T) => T) {
    this.persisted = initial
    this.store = new RevisionStore<T>({
      initial,
      normalize,
      persist: (data) => { this.persisted = data },
      broadcast: (envelope) => {
        for (const subscriber of this.subscribers) subscriber(envelope)
      }
    })
  }

  subscribe(handler: (envelope: RevisionEnvelope<T>) => void): void {
    this.subscribers.push(handler)
  }

  /** The IPC hop. Payloads are structurally cloned exactly as Electron would. */
  async save(payload: { baseRevision: number; data: T }): Promise<RevisionSaveResult<T>> {
    this.saveCalls += 1
    this.inFlight += 1
    if (this.inFlight > 1) this.concurrentSaves += 1
    try {
      await Promise.resolve()
      return this.store.save(payload.baseRevision, clone(payload.data))
    } finally {
      this.inFlight -= 1
    }
  }
}

/** Stands in for one window's `useAppState`. */
class FakeRenderer<T> {
  state: T
  readonly client: RevisionSyncClient<T>
  readonly errors: string[] = []
  /** When true the window misses broadcasts, as it would while offline or busy. */
  deaf = false

  constructor(private readonly main: FakeMain<T>, maxAttempts?: number) {
    const loaded = main.store.get()
    this.state = loaded.data
    this.client = new RevisionSyncClient<T>({
      save: (payload) => main.save(payload),
      onRebase: (data) => { this.state = data },
      onError: (message) => { this.errors.push(message) },
      ...(maxAttempts !== undefined ? { maxAttempts } : {})
    })
    this.client.hydrate(loaded.revision)
    main.subscribe((envelope) => {
      if (this.deaf) return
      const next = this.client.applyBroadcast(envelope.revision, envelope.data)
      if (next !== null) this.state = next
    })
  }

  /** What `mutateProjects` / `mutateNotes` do: record, then apply locally. */
  mutate(updater: Updater<T>, key?: string): void {
    this.client.enqueue(updater, key)
    this.state = updater(this.state)
  }

  async flush(): Promise<void> {
    this.client.requestSave(this.state)
    await this.client.settled()
  }
}

const normalizeProjects = (data: ProjectsData): ProjectsData =>
  Storage.normalizeProjectsData(data as unknown as Record<string, unknown>)

function addTask(projectId: string, next: Task): Updater<ProjectsData> {
  return (prev) => ({
    ...prev,
    projects: prev.projects.map(project =>
      project.id !== projectId || project.tasks.some(t => t.id === next.id)
        ? project
        : { ...project, tasks: [...project.tasks, next] }
    )
  })
}

function renameTask(projectId: string, taskId: string, name: string): Updater<ProjectsData> {
  return (prev) => ({
    ...prev,
    projects: prev.projects.map(project =>
      project.id !== projectId ? project : {
        ...project,
        tasks: project.tasks.map(t => (t.id === taskId ? { ...t, name } : t))
      }
    )
  })
}

function removeTask(projectId: string, taskId: string): Updater<ProjectsData> {
  return (prev) => ({
    ...prev,
    projects: prev.projects.map(project =>
      project.id !== projectId ? project : {
        ...project,
        tasks: project.tasks.filter(t => t.id !== taskId)
      }
    )
  })
}

/** Mirrors `updateNoteContent`: a note that is gone stays gone. */
function editNote(projectId: string, noteId: string, content: string): Updater<NotesRecord> {
  return (prev) => {
    const existing = prev[projectId]
    if (!existing?.some(n => n.id === noteId)) return prev
    return {
      ...prev,
      [projectId]: existing.map(n => (n.id === noteId ? { ...n, content, updatedAt: 2_000 } : n))
    }
  }
}

function deleteNote(projectId: string, noteId: string): Updater<NotesRecord> {
  return (prev) => {
    const existing = prev[projectId]
    if (!existing?.some(n => n.id === noteId)) return prev
    return { ...prev, [projectId]: existing.filter(n => n.id !== noteId) }
  }
}

function taskNames(data: ProjectsData): string[] {
  return data.projects[0].tasks.map(t => t.name)
}

describe('concurrent windows — projects and tasks (finding #5)', () => {
  it('keeps both tasks when two windows add one each from the same baseline', async () => {
    const main = new FakeMain<ProjectsData>(baselineProjects(), normalizeProjects)
    const w1 = new FakeRenderer(main)
    const w2 = new FakeRenderer(main)
    // Neither window hears about the other before it saves — the exact race in the bug.
    w1.deaf = true
    w2.deaf = true

    w1.mutate(addTask('p1', task('t-one', 'One')))
    w2.mutate(addTask('p1', task('t-two', 'Two')))

    await w1.flush()
    await w2.flush()

    expect(taskNames(main.persisted).sort()).toEqual(['One', 't-base', 'Two'].sort())
    expect(taskNames(w2.state).sort()).toEqual(['One', 't-base', 'Two'].sort())
    // The loser rebased and re-sent rather than being refused outright.
    expect(main.saveCalls).toBe(3)
  })

  it('delivers both changes when broadcasts are flowing normally', async () => {
    const main = new FakeMain<ProjectsData>(baselineProjects(), normalizeProjects)
    const w1 = new FakeRenderer(main)
    const w2 = new FakeRenderer(main)

    w1.mutate(addTask('p1', task('t-one', 'One')))
    w2.mutate(addTask('p1', task('t-two', 'Two')))

    await w1.flush()
    await w2.flush()

    expect(taskNames(main.persisted).sort()).toEqual(['One', 't-base', 'Two'].sort())
    expect(taskNames(w1.state).sort()).toEqual(['One', 't-base', 'Two'].sort())
    expect(taskNames(w2.state).sort()).toEqual(['One', 't-base', 'Two'].sort())
  })

  it('applies the loser\'s edit on top of the winner\'s rather than losing or duplicating it', async () => {
    const main = new FakeMain<ProjectsData>(baselineProjects(), normalizeProjects)
    const w1 = new FakeRenderer(main)
    const w2 = new FakeRenderer(main)
    w1.deaf = true
    w2.deaf = true

    // Both touch the same task: one renames it, the other adds a sibling to it.
    w1.mutate(renameTask('p1', 't-base', 'Renamed by one'))
    w2.mutate(addTask('p1', task('t-two', 'Two')))

    await w1.flush()
    await w2.flush()

    const tasks = main.persisted.projects[0].tasks
    expect(tasks).toHaveLength(2)
    expect(tasks.filter(t => t.id === 't-base')).toHaveLength(1)
    expect(tasks.find(t => t.id === 't-base')?.name).toBe('Renamed by one')
    expect(tasks.find(t => t.id === 't-two')?.name).toBe('Two')
  })

  it('lets the later writer win a same-field conflict without dropping the earlier save', async () => {
    const main = new FakeMain<ProjectsData>(baselineProjects(), normalizeProjects)
    const w1 = new FakeRenderer(main)
    const w2 = new FakeRenderer(main)
    w1.deaf = true
    w2.deaf = true

    w1.mutate(renameTask('p1', 't-base', 'From one'))
    w2.mutate(renameTask('p1', 't-base', 'From two'))

    await w1.flush()
    await w2.flush()

    expect(main.persisted.projects[0].tasks).toHaveLength(1)
    expect(main.persisted.projects[0].tasks[0].name).toBe('From two')
    expect(main.store.getRevision()).toBe(2)
  })

  it('does not resurrect a task the other window deleted', async () => {
    const main = new FakeMain<ProjectsData>(baselineProjects(), normalizeProjects)
    const w1 = new FakeRenderer(main)
    const w2 = new FakeRenderer(main)
    w1.deaf = true
    w2.deaf = true

    w1.mutate(removeTask('p1', 't-base'))
    w2.mutate(renameTask('p1', 't-base', 'Renamed after deletion'))

    await w1.flush()
    await expect(w2.flush()).resolves.toBeUndefined()

    // Documented policy: the delete wins, the rebased edit is a no-op.
    expect(main.persisted.projects[0].tasks).toHaveLength(0)
    expect(w2.state.projects[0].tasks).toHaveLength(0)
    expect(w2.errors).toEqual([])
  })

  it('serializes saves so two payloads never quote the same base revision', async () => {
    const main = new FakeMain<ProjectsData>(baselineProjects(), normalizeProjects)
    const w1 = new FakeRenderer(main)

    w1.mutate(addTask('p1', task('t-one', 'One')))
    w1.client.requestSave(w1.state)
    w1.mutate(addTask('p1', task('t-two', 'Two')))
    w1.client.requestSave(w1.state)
    await w1.client.settled()

    expect(main.concurrentSaves).toBe(0)
    expect(taskNames(main.persisted).sort()).toEqual(['One', 't-base', 'Two'].sort())
  })

  it('drops pending mutations that main has not acknowledged only once it has', async () => {
    const main = new FakeMain<ProjectsData>(baselineProjects(), normalizeProjects)
    const w1 = new FakeRenderer(main)

    w1.mutate(addTask('p1', task('t-one', 'One')))
    expect(w1.client.hasPending()).toBe(true)
    await w1.flush()
    expect(w1.client.hasPending()).toBe(false)
  })
})

describe('concurrent windows — notes (finding #6)', () => {
  const baselineNotes = (): NotesRecord => ({ p1: [note('n-a', 'a0'), note('n-b', 'b0')] })

  it('keeps both edits when two windows edit different notes from the same snapshot', async () => {
    const main = new FakeMain<NotesRecord>(baselineNotes())
    const w1 = new FakeRenderer(main)
    const w2 = new FakeRenderer(main)
    w1.deaf = true
    w2.deaf = true

    w1.mutate(editNote('p1', 'n-a', 'a1'), 'note-content:p1:n-a')
    w2.mutate(editNote('p1', 'n-b', 'b1'), 'note-content:p1:n-b')

    await w1.flush()
    await w2.flush()

    expect(main.persisted.p1.find(n => n.id === 'n-a')?.content).toBe('a1')
    expect(main.persisted.p1.find(n => n.id === 'n-b')?.content).toBe('b1')
  })

  it('replays only the newest keystroke for a coalesced content edit', async () => {
    const main = new FakeMain<NotesRecord>(baselineNotes())
    const w1 = new FakeRenderer(main)
    const w2 = new FakeRenderer(main)
    w1.deaf = true
    w2.deaf = true

    // Window 2 types three characters before its debounce fires; window 1 lands a
    // save in between, so window 2's payload has to be rebased.
    w2.mutate(editNote('p1', 'n-b', 'b'), 'note-content:p1:n-b')
    w2.mutate(editNote('p1', 'n-b', 'be'), 'note-content:p1:n-b')
    w2.mutate(editNote('p1', 'n-b', 'bee'), 'note-content:p1:n-b')
    w1.mutate(editNote('p1', 'n-a', 'a1'), 'note-content:p1:n-a')

    await w1.flush()
    await w2.flush()

    expect(main.persisted.p1.find(n => n.id === 'n-a')?.content).toBe('a1')
    expect(main.persisted.p1.find(n => n.id === 'n-b')?.content).toBe('bee')
  })

  it('does not resurrect a note the other window deleted', async () => {
    const main = new FakeMain<NotesRecord>(baselineNotes())
    const w1 = new FakeRenderer(main)
    const w2 = new FakeRenderer(main)
    w1.deaf = true
    w2.deaf = true

    w1.mutate(deleteNote('p1', 'n-a'))
    w2.mutate(editNote('p1', 'n-a', 'typed while it was being deleted'), 'note-content:p1:n-a')

    await w1.flush()
    await expect(w2.flush()).resolves.toBeUndefined()

    expect(main.persisted.p1.map(n => n.id)).toEqual(['n-b'])
    expect(w2.state.p1.map(n => n.id)).toEqual(['n-b'])
    expect(w2.errors).toEqual([])
  })

  it('keeps an unsent edit alive across a broadcast from another window', async () => {
    const main = new FakeMain<NotesRecord>(baselineNotes())
    const w1 = new FakeRenderer(main)
    const w2 = new FakeRenderer(main)

    // Window 2 is mid-debounce: the mutation is queued but nothing has been sent.
    w2.mutate(editNote('p1', 'n-b', 'still typing'), 'note-content:p1:n-b')
    w1.mutate(editNote('p1', 'n-a', 'a1'), 'note-content:p1:n-a')
    await w1.flush()

    // The broadcast arrived while window 2 had a pending mutation; it must not have
    // wiped the text being typed.
    expect(w2.state.p1.find(n => n.id === 'n-b')?.content).toBe('still typing')
    expect(w2.state.p1.find(n => n.id === 'n-a')?.content).toBe('a1')

    await w2.flush()
    expect(main.persisted.p1.find(n => n.id === 'n-a')?.content).toBe('a1')
    expect(main.persisted.p1.find(n => n.id === 'n-b')?.content).toBe('still typing')
  })
})

describe('retry bound', () => {
  it('gives up after the configured attempts, reports an error and adopts canonical state', async () => {
    const main = new FakeMain<ProjectsData>(baselineProjects(), normalizeProjects)
    const w1 = new FakeRenderer(main, 5)
    w1.deaf = true

    // A peer that commits a task of its own immediately before every one of window 1's
    // attempts, so the compare-and-swap can never succeed.
    let peer = 0
    const original = main.save.bind(main)
    const spy = vi.spyOn(main, 'save').mockImplementation(async (payload) => {
      peer += 1
      main.store.commit(addTask('p1', task(`t-peer-${peer}`, `Peer ${peer}`))(main.store.peek()))
      return original(payload)
    })

    w1.mutate(addTask('p1', task('t-mine', 'Mine')))
    await w1.flush()

    expect(spy).toHaveBeenCalledTimes(5)
    expect(w1.errors).toHaveLength(1)
    expect(w1.errors[0]).toContain('after 5 attempts')
    // Local state is main's, not a divergent fantasy, and the loss was reported.
    expect(taskNames(w1.state)).not.toContain('Mine')
    expect(taskNames(w1.state)).toContain('Peer 5')
    expect(w1.client.hasPending()).toBe(false)
    spy.mockRestore()
  })

  it('reports the failure and stops when the IPC itself rejects', async () => {
    const main = new FakeMain<ProjectsData>(baselineProjects(), normalizeProjects)
    const w1 = new FakeRenderer(main)
    const spy = vi.spyOn(main, 'save').mockRejectedValue(new Error('renderer gone'))

    w1.mutate(addTask('p1', task('t-one', 'One')))
    await w1.flush()

    expect(spy).toHaveBeenCalledTimes(1)
    expect(w1.errors).toEqual(['Could not save changes: renderer gone'])
    spy.mockRestore()
  })
})

describe('RevisionStore', () => {
  it('refuses a save whose base revision is stale and hands back canonical state', () => {
    const main = new FakeMain<ProjectsData>(baselineProjects(), normalizeProjects)
    main.store.commit(addTask('p1', task('t-one', 'One'))(main.store.peek()))

    const result = main.store.save(0, baselineProjects())

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.revision).toBe(1)
    expect(taskNames(result.data)).toContain('One')
    // Nothing was written on the strength of the stale snapshot.
    expect(taskNames(main.persisted)).toContain('One')
  })

  it('bumps the revision and broadcasts for main\'s own commits', () => {
    const main = new FakeMain<ProjectsData>(baselineProjects(), normalizeProjects)
    const seen: number[] = []
    main.subscribe((envelope) => seen.push(envelope.revision))

    main.store.commit(removeTask('p1', 't-base')(main.store.peek()))

    expect(main.store.getRevision()).toBe(1)
    expect(seen).toEqual([1])
    expect(main.persisted.projects[0].tasks).toHaveLength(0)
  })

  it('hands out clones so a renderer cannot mutate canonical state through its copy', () => {
    const main = new FakeMain<ProjectsData>(baselineProjects(), normalizeProjects)
    const copy = main.store.get().data
    copy.projects[0].tasks = []
    expect(main.store.peek().projects[0].tasks).toHaveLength(1)
  })
})
