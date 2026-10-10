import { describe, expect, it, vi } from 'vitest'
import { adoptStreamPromptQueue, applyPromptQueueOp, nextAutoRunPrompt, promptQueue, promptQueueWatchedTask, queuedPromptStream, streamPromptQueue } from '../src/shared/prompt-queue'
import { PromptQueueRunner, type PromptQueueRunnerDeps } from '../src/main/prompt-queue-runner'
import { mainStreamId, type Project, type ProjectsData, type QueuedPrompt, type Stream, type TabStatusValue } from '../src/shared/types'
import { findStreamOfTask, findTaskInProject, mapTaskInProject, projectTasks, removeTaskFromProject } from '../src/shared/streams'
import { inboxSettled } from '../src/shared/inbox-transitions'
import { fixtureProject } from './helpers/streams-fixtures'

const q = (id: string, text = id, streamId?: string): QueuedPrompt => ({ id, text, ...(streamId ? { streamId } : {}) })
const MAIN = mainStreamId('p1')

function project(extra: Partial<Project> = {}, ui: Partial<Stream> = {}, main: Partial<Stream> = {}): Project {
  const p = { ...fixtureProject({ id: 'p1', streams: [{ id: 's-ui', name: 'ui', tasks: [], ...ui }] }), ...extra }
  return { ...p, streams: p.streams.map(s => (s.id === MAIN ? { ...s, ...main } : s)) }
}

const stream = (p: Project, id: string): Stream => p.streams.find(s => s.id === id)!

describe('applyPromptQueueOp', () => {
  it('adds trimmed prompts at the end and ignores blanks and repeats', () => {
    let p = applyPromptQueueOp(project(), { op: 'add', item: q('a', '  first  ') })
    p = applyPromptQueueOp(p, { op: 'add', item: q('b', 'second') })
    expect(applyPromptQueueOp(p, { op: 'add', item: q('c', '   ') })).toBe(p)
    expect(applyPromptQueueOp(p, { op: 'add', item: q('a', 'again') })).toBe(p)
    expect(promptQueue(p).map(i => i.text)).toEqual(['first', 'second'])
  })

  it('edits, moves and removes by id, and drops the field once empty', () => {
    let p = project({ promptQueue: [q('a'), q('b'), q('c')] })
    p = applyPromptQueueOp(p, { op: 'edit', id: 'b', text: 'B!' })
    expect(applyPromptQueueOp(p, { op: 'edit', id: 'b', text: ' ' })).toBe(p)
    p = applyPromptQueueOp(p, { op: 'move', id: 'c', toIndex: 0 })
    expect(promptQueue(p).map(i => i.text)).toEqual(['c', 'a', 'B!'])
    p = applyPromptQueueOp(p, { op: 'move', id: 'c', toIndex: 99 })
    expect(promptQueue(p).map(i => i.id)).toEqual(['a', 'b', 'c'])
    for (const id of ['a', 'b', 'c']) p = applyPromptQueueOp(p, { op: 'remove', id })
    expect('promptQueue' in p).toBe(false)
    expect(applyPromptQueueOp(p, { op: 'remove', id: 'a' })).toBe(p)
  })

  it('auto-run is per stream, and switching it off forgets the watched task', () => {
    let p = applyPromptQueueOp(project(), { op: 'auto-run', streamId: 's-ui', on: true })
    p = { ...p, streams: p.streams.map(s => (s.id === 's-ui' ? { ...s, promptQueueWatch: { taskId: 't', tabId: 'tab' } } : s)) }
    expect(stream(p, 's-ui').promptQueueAutoRun).toBe(true)
    expect(stream(p, MAIN).promptQueueAutoRun).toBeUndefined()
    p = applyPromptQueueOp(p, { op: 'auto-run', streamId: 's-ui', on: false })
    expect(stream(p, 's-ui').promptQueueAutoRun).toBeUndefined()
    expect(stream(p, 's-ui').promptQueueWatch).toBeUndefined()
    expect(applyPromptQueueOp(p, { op: 'auto-run', streamId: 's-gone', on: true })).toBe(p)
  })

  it('a prompt whose stream closed runs in main; each stream sees its own prompts', () => {
    const p = project({ promptQueue: [q('a', 'a', 's-ui'), q('b', 'b', 's-closed'), q('c')] })
    expect(queuedPromptStream(p, q('a', 'a', 's-ui'))?.id).toBe('s-ui')
    expect(queuedPromptStream(p, q('a', 'a', 's-closed'))?.id).toBe(MAIN)
    expect(streamPromptQueue(p, MAIN).map(i => i.id)).toEqual(['b', 'c'])
    expect(streamPromptQueue(p, 's-ui').map(i => i.id)).toEqual(['a'])
  })

  it('a watch holds the stream only while its task is there and not Done for now', () => {
    const task = { id: 't1', name: 't1', panes: [] }
    let p = project({ promptQueue: [q('a', 'a', 's-ui')] }, { promptQueueAutoRun: true, tasks: [task], promptQueueWatch: { taskId: 't1', tabId: 'tab' } })
    expect(promptQueueWatchedTask(stream(p, 's-ui'))).not.toBeNull()
    expect(nextAutoRunPrompt(p, stream(p, 's-ui'))).toBeUndefined()
    p = mapTaskInProject(p, 't1', t => ({ ...t, inbox: inboxSettled({}, 1) }))
    expect(promptQueueWatchedTask(stream(p, 's-ui'))).toBeNull()
    expect(nextAutoRunPrompt(p, stream(p, 's-ui'))?.id).toBe('a')
    expect(nextAutoRunPrompt(p, stream(p, MAIN))).toBeUndefined()
  })

  it('moves the old project-wide auto-run to main and the watch to its task\'s stream', () => {
    const task = { id: 't1', name: 't1', panes: [] }
    const legacy = { ...project({}, { tasks: [task] }), promptQueueAutoRun: true, promptQueueWatch: { taskId: 't1', tabId: 'tab' } } as Project
    const p = adoptStreamPromptQueue(legacy)
    expect('promptQueueAutoRun' in p || 'promptQueueWatch' in p).toBe(false)
    expect(stream(p, MAIN).promptQueueAutoRun).toBe(true)
    expect(stream(p, 's-ui').promptQueueWatch).toEqual({ taskId: 't1', tabId: 'tab' })
    const fresh = project()
    expect(adoptStreamPromptQueue(fresh)).toBe(fresh)
  })
})

function harness(initial: Project, overrides: Partial<PromptQueueRunnerDeps> = {}) {
  let data: ProjectsData = { projects: [initial], tags: [], projectOrder: [initial.id], pinnedItems: [] }
  const statuses = new Map<string, TabStatusValue>()
  let listener: ((tabId: string) => void) | null = null
  const projectListeners = new Set<() => void>()
  const sent: { taskId: string; prompt: string }[] = []
  const deps: PromptQueueRunnerDeps = {
    peek: () => data,
    commit: (next) => {
      data = next
      for (const l of projectListeners) l()
    },
    subscribeProjects: (l) => { projectListeners.add(l); return () => { projectListeners.delete(l) } },
    statusOf: (tabId) => statuses.get(tabId) ?? null,
    subscribe: (l) => { listener = l; return () => { listener = null } },
    blocker: () => null,
    ensureWorktree: async () => ({ ok: true }),
    sendFirstPrompt: async (_projectId, taskId, _tabId, prompt) => { sent.push({ taskId, prompt }) },
    log: () => {},
    ...overrides
  }
  const runner = new PromptQueueRunner(deps)
  runner.start()
  const setStatus = (tabId: string, status: TabStatusValue) => {
    statuses.set(tabId, status)
    listener?.(tabId)
  }
  const update = (fn: (p: Project) => Project) => deps.commit({ ...data, projects: [fn(data.projects[0])] })
  return { runner, sent, setStatus, update, project: () => data.projects[0] }
}

describe('PromptQueueRunner', () => {
  it('Run takes the prompt off the queue, starts a chat task in its stream and watches it there', async () => {
    const h = harness(project({ promptQueue: [q('a', 'Fix the login', 's-ui'), q('b', 'Then the docs')] }))
    const result = await h.runner.run('p1', 'a')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const p = h.project()
    expect(promptQueue(p).map(i => i.id)).toEqual(['b'])
    expect(findStreamOfTask(p, result.taskId)?.id).toBe('s-ui')
    const task = findTaskInProject(p, result.taskId)
    expect(task?.name).toBe('Fix the login')
    expect(task?.panes[0].tabs[0].type).toBe('claude-chat')
    expect(stream(p, 's-ui').promptQueueWatch).toEqual({ taskId: result.taskId, tabId: task?.panes[0].tabs[0].id })
    expect(stream(p, MAIN).promptQueueWatch).toBeUndefined()
    expect(h.sent).toEqual([{ taskId: result.taskId, prompt: 'Fix the login' }])
  })

  it('a blocked project or a failed worktree leaves the queue as it was', async () => {
    const blocked = harness(project({ promptQueue: [q('a')] }), { blocker: () => 'Claude is off' })
    expect(await blocked.runner.run('p1', 'a')).toEqual({ ok: false, error: 'Claude is off' })
    expect(promptQueue(blocked.project()).map(i => i.id)).toEqual(['a'])

    const failed = harness(project({ promptQueue: [q('x'), q('a'), q('b')] }), { ensureWorktree: async () => ({ ok: false, error: 'no git' }) })
    const result = await failed.runner.run('p1', 'a')
    expect(result).toEqual({ ok: false, error: "Couldn't create the task's worktree: no git" })
    expect(promptQueue(failed.project()).map(i => i.id)).toEqual(['x', 'a', 'b'])
    expect(projectTasks(failed.project())).toHaveLength(0)
    expect(stream(failed.project(), MAIN).promptQueueWatch).toBeUndefined()
  })

  it('with auto-run on, the stream starts its first prompt by itself and the next once the task finishes; needing you is not finished', async () => {
    const h = harness(project({ promptQueue: [q('a'), q('b')] }, {}, { promptQueueAutoRun: true }))
    await vi.waitFor(() => expect(h.sent.map(s => s.prompt)).toEqual(['a']))
    const firstTab = stream(h.project(), MAIN).promptQueueWatch!.tabId
    h.setStatus(firstTab, 'working')
    h.setStatus(firstTab, 'attention')
    h.setStatus(firstTab, 'working')
    await Promise.resolve()
    expect(h.sent).toHaveLength(1)
    h.setStatus(firstTab, null)
    await vi.waitFor(() => expect(h.sent.map(s => s.prompt)).toEqual(['a', 'b']))
    expect(promptQueue(h.project())).toEqual([])
    expect(stream(h.project(), MAIN).promptQueueWatch?.tabId).not.toBe(firstTab)
  })

  it('Done for now on the watched task, or closing it, starts the next prompt', async () => {
    const h = harness(project({ promptQueue: [q('a'), q('b'), q('c')] }, {}, { promptQueueAutoRun: true }))
    await vi.waitFor(() => expect(h.sent).toHaveLength(1))
    const first = stream(h.project(), MAIN).promptQueueWatch!.taskId
    h.setStatus(stream(h.project(), MAIN).promptQueueWatch!.tabId, 'attention')
    h.update(p => mapTaskInProject(p, first, t => ({ ...t, inbox: inboxSettled(t.inbox ?? {}, Date.now()) })))
    await vi.waitFor(() => expect(h.sent.map(s => s.prompt)).toEqual(['a', 'b']))
    const second = stream(h.project(), MAIN).promptQueueWatch!.taskId
    h.update(p => removeTaskFromProject(p, second))
    await vi.waitFor(() => expect(h.sent.map(s => s.prompt)).toEqual(['a', 'b', 'c']))
  })

  it('streams run side by side, each one prompt at a time', async () => {
    const h = harness(
      project({ promptQueue: [q('m1'), q('u1', 'u1', 's-ui'), q('m2'), q('u2', 'u2', 's-ui')] }, { promptQueueAutoRun: true }, { promptQueueAutoRun: true })
    )
    await vi.waitFor(() => expect(h.sent.map(s => s.prompt).sort()).toEqual(['m1', 'u1']))
    h.setStatus(stream(h.project(), 's-ui').promptQueueWatch!.tabId, 'working')
    h.setStatus(stream(h.project(), 's-ui').promptQueueWatch!.tabId, null)
    await vi.waitFor(() => expect(h.sent.map(s => s.prompt)).toContain('u2'))
    expect(h.sent.map(s => s.prompt)).not.toContain('m2')
    expect(streamPromptQueue(h.project(), MAIN).map(i => i.id)).toEqual(['m2'])
  })

  it('with auto-run off, a finish only stops the watch; an exited agent switches auto-run off', async () => {
    const off = harness(project({ promptQueue: [q('a'), q('b')] }))
    await off.runner.run('p1', 'a')
    const tab = stream(off.project(), MAIN).promptQueueWatch!.tabId
    off.setStatus(tab, 'working')
    off.setStatus(tab, null)
    await Promise.resolve()
    expect(off.sent).toHaveLength(1)
    expect(stream(off.project(), MAIN).promptQueueWatch).toBeUndefined()

    const died = harness(project({ promptQueue: [q('a'), q('b')] }, {}, { promptQueueAutoRun: true }))
    await vi.waitFor(() => expect(died.sent).toHaveLength(1))
    const diedTab = stream(died.project(), MAIN).promptQueueWatch!.tabId
    died.setStatus(diedTab, 'working')
    died.setStatus(diedTab, 'exited')
    await Promise.resolve()
    expect(died.sent).toHaveLength(1)
    expect(stream(died.project(), MAIN).promptQueueWatch).toBeUndefined()
    expect(stream(died.project(), MAIN).promptQueueAutoRun).toBeUndefined()
    expect(promptQueue(died.project()).map(i => i.id)).toEqual(['b'])
  })

  it('a failed auto start switches the stream off instead of retrying; a blocked project waits', async () => {
    const failed = harness(project({ promptQueue: [q('a')] }, {}, { promptQueueAutoRun: true }), { ensureWorktree: async () => ({ ok: false, error: 'no git' }) })
    await vi.waitFor(() => expect(stream(failed.project(), MAIN).promptQueueAutoRun).toBeUndefined())
    expect(promptQueue(failed.project()).map(i => i.id)).toEqual(['a'])

    const blocker = vi.fn(() => 'Claude is off')
    const blocked = harness(project({ promptQueue: [q('a')] }, {}, { promptQueueAutoRun: true }), { blocker })
    await Promise.resolve()
    await Promise.resolve()
    expect(blocker).toHaveBeenCalled()
    expect(stream(blocked.project(), MAIN).promptQueueAutoRun).toBe(true)
    expect(blocked.sent).toHaveLength(0)
  })

  it('tasks the queue did not start never move it, and a server\'s projects are left to the server', async () => {
    const h = harness(project({ promptQueue: [q('a')] }, {}, { promptQueueWatch: { taskId: 'x', tabId: 'x' } }))
    h.setStatus('someone-else', 'working')
    h.setStatus('someone-else', null)
    await Promise.resolve()
    expect(h.sent).toHaveLength(0)

    const remote = harness(project({ host: 'srv', promptQueue: [q('a')] }, {}, { promptQueueAutoRun: true }))
    await Promise.resolve()
    await Promise.resolve()
    expect(remote.sent).toHaveLength(0)
  })
})
