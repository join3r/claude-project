import { describe, expect, it } from 'vitest'
import { buildInbox, inboxContentKey, type InboxTabLookup } from '../src/main/mobile/inbox'
import { createHomeTask, type Project, type ProjectsData, type Tab, type TabStatusValue, type Task } from '../src/shared/types'
import { emptyActivity, type AgentActivity } from '../src/shared/agent-activity'

const DESKTOP = { id: 'd'.repeat(32), name: 'join3r-mbp' }
const NOW = 1_790_000_000_000

function tab(id: string, type: Tab['type'], title = id): Tab {
  return { id, type, title }
}

function task(id: string, tabs: Tab[], extra: Partial<Task> = {}): Task {
  return {
    id,
    name: `task ${id}`,
    tabs: { left: tabs, right: [] },
    activeTab: { left: tabs[0]?.id ?? null, right: null },
    splitOpen: false,
    splitRatio: 0.5,
    ...extra
  }
}

function project(id: string, tasks: Task[], extra: Partial<Project> = {}): Project {
  return { id, name: `project ${id}`, directory: `/src/${id}`, tasks: [createHomeTask(id).task, ...tasks], ...extra }
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
      tasks: [{
        id: 't1',
        name: 'task t1',
        lastInteractedAt: 5,
        attentionAt: 7,
        tabs: [{ id: 'a', type: 'claude-chat', title: 'Claude', status: 'working', since: 3 }]
      }]
    }])
  })

  it('omits optional fields that are absent', () => {
    const inbox = buildInbox(data([project('p1', [task('t1', [tab('a', 'terminal')])])]), lookup(), DESKTOP, NOW)
    const [p] = inbox.projects
    expect('emoji' in p).toBe(false)
    const [t] = p.tasks
    expect('lastInteractedAt' in t).toBe(false)
    expect('attentionAt' in t).toBe(false)
    expect('branch' in t).toBe(false)
    expect(t.tabs[0]).toEqual({ id: 'a', type: 'terminal', title: 'a', status: 'idle' })
  })

  it('names the branch of a workspace task', () => {
    const workspace = { worktreePath: '/src/p1/.worktrees/fix', branchName: 'fix', baseBranch: 'main', relativeProjectPath: '' }
    const inbox = buildInbox(data([project('p1', [task('t1', [], { workspace })])]), lookup(), DESKTOP, NOW)
    expect(inbox.projects[0].tasks[0].branch).toBe('fix')
  })

  it('marks SSH projects as remote', () => {
    const p = project('p1', [], { ssh: { host: 'h', port: 22, username: 'u', remoteDir: '' } })
    expect(buildInbox(data([p]), lookup(), DESKTOP, NOW).projects[0].remote).toBe(true)
  })

  it('keeps only agent and terminal tabs, left pane then right', () => {
    const t = task('t1', [
      tab('chat', 'claude-chat'), tab('cc', 'claude'), tab('browser', 'browser'), tab('ed', 'editor')
    ])
    t.tabs.right = [tab('cx', 'codex'), tab('pi', 'pi'), tab('diff', 'diff'), tab('note', 'note'), tab('sh', 'terminal')]
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

  it('shortens long activity labels to one phone row', () => {
    const long: AgentActivity = { ...emptyActivity(1), lastMessage: 'x'.repeat(160) }
    const t = task('t1', [tab('a', 'claude')])
    const inbox = buildInbox(data([project('p1', [t])]), lookup({}, { a: long }), DESKTOP, NOW)
    const label = inbox.projects[0].tasks[0].tabs[0].activity!
    expect(label.length).toBe(100)
    expect(label.endsWith('…')).toBe(true)
  })

  it('never includes home tasks', () => {
    const inbox = buildInbox(data([project('p1', [task('t1', [])])]), lookup(), DESKTOP, NOW)
    expect(inbox.projects[0].tasks.map(t => t.id)).toEqual(['t1'])
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

  it('excludes spent ephemeral projects but keeps live ones without their home task', () => {
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

  it('does not share structure with the input', () => {
    const p = project('p1', [task('t1', [tab('a', 'terminal')])])
    const inbox = buildInbox(data([p]), lookup(), DESKTOP, NOW)
    inbox.projects[0].tasks[0].tabs[0].title = 'changed'
    expect(p.tasks[1].tabs.left[0].title).toBe('a')
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
  })
})
