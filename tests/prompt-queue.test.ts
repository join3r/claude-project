import { describe, expect, it, vi } from 'vitest'
import { applyPromptQueueOp, promptQueue, promptQueueWatchedTask, queuedPromptStream } from '../src/shared/prompt-queue'
import { PromptQueueRunner, type PromptQueueRunnerDeps } from '../src/main/prompt-queue-runner'
import { mainStreamId, type Project, type ProjectsData, type QueuedPrompt, type TabStatusValue } from '../src/shared/types'
import { findStreamOfTask, findTaskInProject, projectTasks } from '../src/shared/streams'
import { fixtureProject } from './helpers/streams-fixtures'

const q = (id: string, text = id, streamId?: string): QueuedPrompt => ({ id, text, ...(streamId ? { streamId } : {}) })

function project(extra: Partial<Project> = {}): Project {
  return {
    ...fixtureProject({ id: 'p1', streams: [{ id: 's-ui', name: 'ui', tasks: [] }] }),
    ...extra
  }
}

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

  it('switching auto-run off forgets the watched task', () => {
    let p = applyPromptQueueOp(project(), { op: 'auto-run', on: true })
    p = { ...p, promptQueueWatch: { taskId: 't', tabId: 'tab' } }
    expect(p.promptQueueAutoRun).toBe(true)
    p = applyPromptQueueOp(p, { op: 'auto-run', on: false })
    expect(p.promptQueueAutoRun).toBeUndefined()
    expect(p.promptQueueWatch).toBeUndefined()
  })

  it('a prompt whose stream closed runs in main; a watch on a gone task is no watch', () => {
    const p = project({ promptQueueWatch: { taskId: 'gone', tabId: 'x' } })
    expect(queuedPromptStream(p, q('a', 'a', 's-ui'))?.id).toBe('s-ui')
    expect(queuedPromptStream(p, q('a', 'a', 's-closed'))?.id).toBe(mainStreamId('p1'))
    expect(promptQueueWatchedTask(p)).toBeNull()
  })
})

function harness(initial: Project, overrides: Partial<PromptQueueRunnerDeps> = {}) {
  let data: ProjectsData = { projects: [initial], tags: [], projectOrder: [initial.id], pinnedItems: [] }
  const statuses = new Map<string, TabStatusValue>()
  let listener: ((tabId: string) => void) | null = null
  const sent: { taskId: string; prompt: string }[] = []
  const deps: PromptQueueRunnerDeps = {
    peek: () => data,
    commit: (next) => { data = next },
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
  return { runner, sent, setStatus, project: () => data.projects[0] }
}

describe('PromptQueueRunner', () => {
  it('Run takes the prompt off the queue, starts a chat task in its stream and watches it', async () => {
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
    expect(p.promptQueueWatch).toEqual({ taskId: result.taskId, tabId: task?.panes[0].tabs[0].id })
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
    expect(failed.project().promptQueueWatch).toBeUndefined()
  })

  it('with auto-run on, the watched task finishing starts the next prompt; needing you does not', async () => {
    const h = harness(project({ promptQueueAutoRun: true, promptQueue: [q('a'), q('b')] }))
    await h.runner.run('p1', 'a')
    const firstTab = h.project().promptQueueWatch!.tabId
    h.setStatus(firstTab, 'working')
    h.setStatus(firstTab, 'attention')
    h.setStatus(firstTab, 'working')
    expect(h.sent).toHaveLength(1)
    h.setStatus(firstTab, null)
    await vi.waitFor(() => expect(h.sent.map(s => s.prompt)).toEqual(['a', 'b']))
    expect(promptQueue(h.project())).toEqual([])
    expect(h.project().promptQueueWatch?.tabId).not.toBe(firstTab)
  })

  it('with auto-run off, a finish only stops the watch; an exited agent ends the chain', async () => {
    const off = harness(project({ promptQueue: [q('a'), q('b')] }))
    await off.runner.run('p1', 'a')
    const tab = off.project().promptQueueWatch!.tabId
    off.setStatus(tab, 'working')
    off.setStatus(tab, null)
    expect(off.sent).toHaveLength(1)
    expect(off.project().promptQueueWatch).toBeUndefined()

    const died = harness(project({ promptQueueAutoRun: true, promptQueue: [q('a'), q('b')] }))
    await died.runner.run('p1', 'a')
    const diedTab = died.project().promptQueueWatch!.tabId
    died.setStatus(diedTab, 'working')
    died.setStatus(diedTab, 'exited')
    expect(died.sent).toHaveLength(1)
    expect(died.project().promptQueueWatch).toBeUndefined()
    expect(promptQueue(died.project()).map(i => i.id)).toEqual(['b'])
  })

  it('tasks the queue did not start never move it', async () => {
    const h = harness(project({ promptQueueAutoRun: true, promptQueue: [q('a')] }))
    h.setStatus('someone-else', 'working')
    h.setStatus('someone-else', null)
    expect(h.sent).toHaveLength(0)
  })
})
