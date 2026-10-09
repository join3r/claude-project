import { describe, expect, it } from 'vitest'
import { buildInbox, inboxContentKey, wireLanding, type InboxTabLookup } from '../src/main/mobile/inbox'
import { mainStreamId, type Project, type ProjectsData, type Stream, type Tab, type TabStatusValue } from '../src/shared/types'
import { findTaskInProject } from '../src/shared/streams'
import { fixtureProject, fixtureTask, type FixtureTask, paneTabsAt } from './helpers/streams-fixtures'
import { emptyActivity, type AgentActivity } from '../src/shared/agent-activity'

const DESKTOP = { id: 'd'.repeat(32), name: 'join3r-mbp' }
const NOW = 1_790_000_000_000

function tab(id: string, type: Tab['type'], title = id): Tab {
  return { id, type, title }
}

function task(id: string, tabs: Tab[], extra: Omit<FixtureTask, 'id'> = {}): FixtureTask {
  return { id, name: `task ${id}`, tabs: { left: tabs, right: [] }, ...extra }
}

/** A project whose `main` stream holds its tasks; workspace tasks get streams of their own. */
function project(id: string, tasks: FixtureTask[], extra: Partial<Project> & { streams?: Stream[] } = {}): Project {
  return fixtureProject({ id, name: `project ${id}`, directory: `/src/${id}`, tasks, ...extra })
}

function data(projects: Project[], projectOrder = projects.map(p => p.id)): ProjectsData {
  return { projects, tags: [], projectOrder, pinnedItems: [] }
}

function lookup(
  statuses: Record<string, TabStatusValue> = {},
  activities: Record<string, AgentActivity> = {},
  since: Record<string, number> = {}
): InboxTabLookup {
  return {
    statusOf: (id) => statuses[id] ?? null,
    activityOf: (id) => activities[id] ?? null,
    sinceOf: (id) => since[id] ?? null
  }
}

describe('buildInbox', () => {
  it('stamps the desktop and generation time', () => {
    const inbox = buildInbox(data([]), lookup(), DESKTOP, NOW)
    expect(inbox).toEqual({ desktop: DESKTOP, generatedAt: NOW, projects: [] })
  })

  it('maps projects, tasks and tabs with their fields', () => {
    const p = project('p1', [
      task('t1', [tab('a', 'claude-chat', 'Claude')], { lastInteractedAt: 5, inbox: { attentionAt: 7 } })
    ], { emoji: '🚀' })
    const inbox = buildInbox(data([p]), lookup({ a: 'working' }, {}, { a: 3 }), DESKTOP, NOW)
    expect(inbox.projects).toEqual([{
      id: 'p1',
      name: 'project p1',
      emoji: '🚀',
      remote: false,
      streams: [{ id: mainStreamId('p1'), name: 'main', main: true }],
      tasks: [{
        id: 't1',
        name: 'task t1',
        streamId: mainStreamId('p1'),
        streamName: 'main',
        status: 'working',
        since: 3,
        lastInteractedAt: 5,
        attentionAt: 7,
        tabs: [{ id: 'a', type: 'claude-chat', title: 'Claude', status: 'working', since: 3 }]
      }]
    }])
    // The wire keeps the spec's key order.
    expect(Object.keys(inbox.projects[0])).toEqual(['id', 'name', 'emoji', 'remote', 'streams', 'tasks'])
    expect(Object.keys(inbox.projects[0].tasks[0])).toEqual(['id', 'name', 'streamId', 'streamName', 'status', 'since', 'lastInteractedAt', 'attentionAt', 'tabs'])
  })

  it('omits optional fields that are absent', () => {
    const inbox = buildInbox(data([project('p1', [task('t1', [tab('a', 'terminal')])])]), lookup(), DESKTOP, NOW)
    const [p] = inbox.projects
    expect('emoji' in p).toBe(false)
    const [t] = p.tasks
    expect('lastInteractedAt' in t).toBe(false)
    expect('attentionAt' in t).toBe(false)
    expect('since' in t).toBe(false)
    expect('activity' in t).toBe(false)
    expect('lastStreamId' in p).toBe(false)
    expect(t.status).toBe('idle')
    expect(t.tabs[0]).toEqual({ id: 'a', type: 'terminal', title: 'a', status: 'idle' })
  })

  it('lists the open streams with the branch of a worktree stream, and the last used one', () => {
    const workspace = { worktreePath: '/src/p1/.worktrees/fix', branchName: 'fix', baseBranch: 'main', relativeProjectPath: '' }
    const empty: Stream = { id: 's-empty', name: 'bugfixes', tasks: [] }
    const p = { ...project('p1', [task('t1', [], { workspace })], { streams: [empty] }), lastStreamId: 's-empty' }
    const [wire] = buildInbox(data([p]), lookup(), DESKTOP, NOW).projects
    expect(wire.streams).toEqual([
      { id: mainStreamId('p1'), name: 'main', main: true },
      { id: 'stream-t1', name: 'task t1', branch: 'fix' },
      { id: 's-empty', name: 'bugfixes' }
    ])
    expect(wire.lastStreamId).toBe('s-empty')
    expect(wire.tasks.map(t => [t.id, t.streamId, t.streamName])).toEqual([['t1', 'stream-t1', 'task t1']])
    // A last stream that is gone (archived) is not sent.
    const gone = buildInbox(data([{ ...p, lastStreamId: 'archived' }]), lookup(), DESKTOP, NOW).projects[0]
    expect('lastStreamId' in gone).toBe(false)
  })

  it('gives each task one status from its main tab and agent tabs, not its extra terminals', () => {
    const working: AgentActivity = { ...emptyActivity(1), tool: { name: 'Bash', label: 'Bash · npm test', startedAt: 1 }, turnStartedAt: 1 }
    const agent = task('agent', [tab('chat', 'claude-chat'), tab('side', 'terminal')])
    const term = task('term', [tab('sh', 'terminal'), tab('sh2', 'terminal')])
    const inbox = buildInbox(
      data([project('p1', [agent, term])]),
      lookup({ chat: 'working', side: 'attention', sh: 'exited', sh2: 'attention' }, { chat: working }, { chat: 4, sh: 9 }),
      DESKTOP,
      NOW
    )
    const [a, t] = inbox.projects[0].tasks
    expect([a.status, a.since, a.activity]).toEqual(['working', 4, 'Bash · npm test'])
    // A terminal task's main tab is its first terminal.
    expect([t.status, t.since]).toEqual(['exited', 9])
    // The tabs keep their own statuses.
    expect(a.tabs.map(x => x.status)).toEqual(['working', 'attention'])
  })

  it('marks SSH projects as remote', () => {
    const p = project('p1', [], { ssh: { host: 'h', port: 22, username: 'u', remoteDir: '' } })
    expect(buildInbox(data([p]), lookup(), DESKTOP, NOW).projects[0].remote).toBe(true)
  })

  it('keeps only agent and terminal tabs, left pane then right', () => {
    const t = task('t1', [], {
      tabs: {
        left: [tab('chat', 'claude-chat'), tab('cc', 'claude'), tab('browser', 'browser'), tab('ed', 'editor')],
        right: [tab('cx', 'codex'), tab('pi', 'pi'), tab('diff', 'diff'), tab('note', 'note'), tab('sh', 'terminal')]
      }
    })
    const inbox = buildInbox(data([project('p1', [t])]), lookup(), DESKTOP, NOW)
    expect(inbox.projects[0].tasks[0].tabs.map(x => x.id)).toEqual(['chat', 'cc', 'cx', 'pi', 'sh'])
  })

  it('maps a null status to idle and passes the others through', () => {
    const t = task('t1', [tab('a', 'claude'), tab('b', 'claude'), tab('c', 'claude'), tab('d', 'claude')])
    const inbox = buildInbox(
      data([project('p1', [t])]),
      lookup({ a: 'working', b: 'attention', c: 'exited', d: null }),
      DESKTOP,
      NOW
    )
    expect(inbox.projects[0].tasks[0].tabs.map(x => x.status)).toEqual(['working', 'attention', 'exited', 'idle'])
  })

  it('derives the activity label the sidebar shows', () => {
    const working: AgentActivity = {
      ...emptyActivity(1),
      tool: { name: 'Bash', label: 'Bash · npm test', startedAt: 1 },
      turnStartedAt: 1
    }
    const waiting: AgentActivity = {
      ...emptyActivity(1),
      waiting: { kind: 'permission', label: 'Editing styles.css', since: 1 }
    }
    const t = task('t1', [tab('a', 'claude'), tab('b', 'claude-chat'), tab('c', 'pi')])
    const inbox = buildInbox(
      data([project('p1', [t])]),
      lookup({ a: 'working', b: 'attention' }, { a: working, b: waiting }),
      DESKTOP,
      NOW
    )
    const tabs = inbox.projects[0].tasks[0].tabs
    expect(tabs[0].activity).toBe('Bash · npm test')
    expect(tabs[1].activity).toBe('Permission: Editing styles.css')
    expect('activity' in tabs[2]).toBe(false)
  })

  it("sends what a tab is about: Claude's session title, else the last prompt", () => {
    const titled: AgentActivity = { ...emptyActivity(1), title: 'Fix the login redirect', lastPrompt: 'look at auth.ts' }
    const prompted: AgentActivity = { ...emptyActivity(1), lastPrompt: 'why is CI red?' }
    const t = task('t1', [tab('a', 'claude'), tab('b', 'claude-chat'), tab('c', 'pi')])
    const inbox = buildInbox(data([project('p1', [t])]), lookup({}, { a: titled, b: prompted }), DESKTOP, NOW)
    const tabs = inbox.projects[0].tasks[0].tabs
    expect(tabs[0].topic).toBe('Fix the login redirect')
    expect(tabs[1].topic).toBe('why is CI red?')
    expect('topic' in tabs[2]).toBe(false)
  })

  it('shortens long activity labels to one phone row', () => {
    const long: AgentActivity = { ...emptyActivity(1), lastMessage: 'x'.repeat(160) }
    const t = task('t1', [tab('a', 'claude')])
    const inbox = buildInbox(data([project('p1', [t])]), lookup({}, { a: long }), DESKTOP, NOW)
    const label = inbox.projects[0].tasks[0].tabs[0].activity!
    expect(label.length).toBe(100)
    expect(label.endsWith('…')).toBe(true)
  })

  it('excludes projects hidden from mobile', () => {
    const inbox = buildInbox(
      data([project('p1', []), project('p2', [], { hideFromMobile: true })]),
      lookup(),
      DESKTOP,
      NOW
    )
    expect(inbox.projects.map(p => p.id)).toEqual(['p1'])
  })

  it('excludes spent ephemeral projects but keeps live ones', () => {
    const spent = project('spent', [], { ephemeral: true })
    const live = project('live', [task('t1', [tab('a', 'terminal')])], { ephemeral: true })
    const inbox = buildInbox(data([spent, live]), lookup(), DESKTOP, NOW)
    expect(inbox.projects.map(p => p.id)).toEqual(['live'])
    expect(inbox.projects[0].tasks.map(t => t.id)).toEqual(['t1'])
  })

  it('follows projectOrder and appends projects the order misses', () => {
    const projects = [project('a', []), project('b', []), project('c', [])]
    const inbox = buildInbox(data(projects, ['c', 'missing', 'a', 'c']), lookup(), DESKTOP, NOW)
    expect(inbox.projects.map(p => p.id)).toEqual(['c', 'a', 'b'])
  })

  it('carries the Pinned list in its order, leaving out what the phone cannot see', () => {
    const p1 = project('p1', [task('t1', []), task('t2', [])])
    const hidden = project('hidden', [task('h1', [])], { hideFromMobile: true })
    const d: ProjectsData = {
      ...data([p1, hidden]),
      pinnedItems: [
        { type: 'task', projectId: 'p1', streamId: mainStreamId('p1'), taskId: 't2' },
        { type: 'project', projectId: 'hidden' },
        { type: 'task', projectId: 'hidden', streamId: mainStreamId('hidden'), taskId: 'h1' },
        { type: 'task', projectId: 'p1', streamId: mainStreamId('p1'), taskId: 'gone' },
        { type: 'project', projectId: 'p1' }
      ]
    }
    expect(buildInbox(d, lookup(), DESKTOP, NOW).pinned).toEqual([
      { projectId: 'p1', streamId: mainStreamId('p1'), taskId: 't2' },
      { projectId: 'p1' }
    ])
  })

  it('leaves pinned out when nothing is pinned', () => {
    expect(buildInbox(data([project('p1', [])]), lookup(), DESKTOP, NOW)).not.toHaveProperty('pinned')
  })

  it('carries the triage state the desktop inbox groups by (SPEC.md §4.4)', () => {
    const tasks = [
      task('unread', [], { inbox: { eventAt: 10, visitedAt: 5 } }),
      task('read', [], { inbox: { eventAt: 10, visitedAt: 20 } }),
      task('forced', [], { inbox: { visitedAt: 20, forcedUnread: true } }),
      task('settled', [], { inbox: { eventAt: 10, settledAt: 30, visitedAt: 30 } }),
      task('unsettled', [], { inbox: { eventAt: 40, settledAt: 30, visitedAt: 30 } }),
      task('timed', [], { inbox: { snoozedAt: 1, snoozedUntil: NOW + 60_000, settledAt: 30 } }),
      task('expired', [], { inbox: { snoozedAt: 1, snoozedUntil: NOW - 1 } }),
      task('attention', [], { inbox: { snoozedAt: 50, snoozeUntilAttention: true } }),
      task('woken', [], { inbox: { snoozedAt: 50, snoozeUntilAttention: true, attentionAt: 60 } })
    ]
    const inbox = buildInbox(data([project('p1', tasks)]), lookup(), DESKTOP, NOW)
    const triage = Object.fromEntries(inbox.projects[0].tasks.map(({ id, eventAt, unread, settledAt, snoozedUntil, snoozeUntilAttention }) =>
      [id, JSON.parse(JSON.stringify({ eventAt, unread, settledAt, snoozedUntil, snoozeUntilAttention }))]))
    expect(triage).toEqual({
      unread: { eventAt: 10, unread: true },
      read: { eventAt: 10 },
      forced: { unread: true },
      settled: { eventAt: 10, settledAt: 30 },
      unsettled: { eventAt: 40, unread: true },
      // Snooze wins over settle, as in the window's partitionInbox.
      timed: { snoozedUntil: NOW + 60_000 },
      expired: {},
      attention: { snoozeUntilAttention: true },
      woken: {}
    })
  })

  it('sends a task\'s own worktree branch and its landing (version 3, SPEC.md §4.4)', () => {
    const streamWs = { worktreePath: '/src/p1/.worktrees/rel', branchName: 'rel', baseBranch: 'main', relativeProjectPath: '' }
    const own = { worktreePath: '/src/p1/.worktrees/rel--fix', branchName: 'rel--fix', baseBranch: 'rel', relativeProjectPath: '' }
    const p = project('p1', [
      task('t1', [tab('a', 'claude-chat')], { workspace: streamWs, ownWorkspace: own, landing: { state: 'conflict', intent: 'close', files: ['a.ts', 'b.ts'] } })
    ])
    const [wire] = buildInbox(data([p]), lookup(), DESKTOP, NOW).projects[0].tasks
    expect(wire.branch).toBe('rel--fix')
    expect(wire.landing).toEqual({ state: 'conflict', intent: 'close', files: ['a.ts', 'b.ts'], fileCount: 2 })
    // A task sharing its stream's worktree (or in main) has neither.
    const shared = project('p2', [task('t2', [tab('b', 'claude-chat')], { workspace: streamWs, sharesStreamWorktree: true })])
    const [plain] = buildInbox(data([shared]), lookup(), DESKTOP, NOW).projects[0].tasks
    expect(plain.branch).toBeUndefined()
    expect(plain.landing).toBeUndefined()
  })

  it('cuts a landing to the wire caps: 20 files with their count, a 1000-character message', () => {
    const files = Array.from({ length: 25 }, (_, i) => `f${i}.ts`)
    const wire = wireLanding({ state: 'blocked', files, message: `  ${'x'.repeat(1500)}\n` })
    expect(wire.files).toHaveLength(20)
    expect(wire.fileCount).toBe(25)
    expect(wire.message).toHaveLength(1000)
    expect(wire.message?.endsWith('…')).toBe(true)
    expect(wireLanding({ state: 'landing', files: [], message: ' ' })).toEqual({ state: 'landing' })
  })

  it('sends each task of a stream as its own wire task, naming its stream', () => {
    const workspace = { worktreePath: '/src/p1/.worktrees/rel', branchName: 'rel-0.5', baseBranch: 'main', relativeProjectPath: '' }
    const stream: Stream = {
      id: 's-rel',
      name: '0.5.0',
      workspace,
      tasks: [fixtureTask(task('a1', [tab('x', 'claude')])), fixtureTask(task('a2', [tab('y', 'terminal')]))]
    }
    const inbox = buildInbox(data([project('p1', [task('plain', [])], { streams: [stream] })]), lookup(), DESKTOP, NOW)
    const tasks = inbox.projects[0].tasks
    expect(tasks.map(t => [t.id, t.streamId, t.streamName])).toEqual([
      ['plain', mainStreamId('p1'), 'main'],
      ['a1', 's-rel', '0.5.0'],
      ['a2', 's-rel', '0.5.0']
    ])
    expect(inbox.projects[0].streams[1]).toEqual({ id: 's-rel', name: '0.5.0', branch: 'rel-0.5' })
    expect(tasks[1].tabs.map(t => t.id)).toEqual(['x'])
    expect(tasks[2].tabs.map(t => t.id)).toEqual(['y'])
  })

  it('sends stream pins as they are, a task pin with its current stream, deduplicated', () => {
    const stream: Stream = { id: 's1', name: 'bugfixes', tasks: [fixtureTask(task('a1', [])), fixtureTask(task('a2', []))] }
    const p1 = project('p1', [task('t1', [])], { streams: [stream] })
    const d: ProjectsData = {
      ...data([p1]),
      pinnedItems: [
        { type: 'task', projectId: 'p1', streamId: 's1', taskId: 'a2' },
        { type: 'stream', projectId: 'p1', streamId: 's1' },
        { type: 'stream', projectId: 'p1', streamId: mainStreamId('p1') },
        { type: 'stream', projectId: 'p1', streamId: 'gone' }
      ]
    }
    expect(buildInbox(d, lookup(), DESKTOP, NOW).pinned).toEqual([
      { projectId: 'p1', streamId: 's1', taskId: 'a2' },
      { projectId: 'p1', streamId: 's1' },
      { projectId: 'p1', streamId: mainStreamId('p1') }
    ])
  })

  it('does not share structure with the input', () => {
    const p = project('p1', [task('t1', [tab('a', 'terminal')])])
    const inbox = buildInbox(data([p]), lookup(), DESKTOP, NOW)
    inbox.projects[0].tasks[0].tabs[0].title = 'changed'
    expect(paneTabsAt(findTaskInProject(p, 't1')!, 0)[0].title).toBe('a')
  })
})

describe('inboxContentKey', () => {
  it('ignores generatedAt but sees everything else', () => {
    const d = data([project('p1', [task('t1', [tab('a', 'claude')])])])
    const a = buildInbox(d, lookup(), DESKTOP, 1)
    const b = buildInbox(d, lookup(), DESKTOP, 2)
    const c = buildInbox(d, lookup({ a: 'working' }), DESKTOP, 2)
    expect(inboxContentKey(a)).toBe(inboxContentKey(b))
    expect(inboxContentKey(a)).not.toBe(inboxContentKey(c))
    const pinned = buildInbox({ ...d, pinnedItems: [{ type: 'project', projectId: 'p1' }] }, lookup(), DESKTOP, 2)
    expect(inboxContentKey(a)).not.toBe(inboxContentKey(pinned))
  })
})
