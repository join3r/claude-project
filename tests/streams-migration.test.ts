import fs from 'fs'
import path from 'path'
import { describe, expect, it } from 'vitest'
import { Storage } from '../src/main/storage'
import { isAgentTabType, mainStreamId, type Project, type ProjectsData, type Tab } from '../src/shared/types'
import { projectTasks, taskTabs } from '../src/shared/streams'
import { isLegacyProject, migratedTaskId, type LegacyProject, type LegacyTask } from '../src/shared/streams-migration'

/*
 * The one-time Project › Task › Tab → Project › Stream › Task migration, run where
 * it runs in the app: `Storage.normalizeProjectsData`.
 *
 * The fixture below is an anonymised `projects.json` with the shapes real snapshots
 * hold (home tasks, empty tasks, terminal-only tasks, several agents in one task, a
 * note next to an agent, a right pane), plus the ones they happen not to (worktrees,
 * a draft worktree, a split, task pins, an SSH and an ephemeral project).
 *
 * Set DEVTOOL_MIGRATION_SNAPSHOTS to a directory of real `projects-*.json` copies to
 * run the same invariants over them; nothing personal is checked in.
 */

const tab = (id: string, type: Tab['type'], title: string, extra: Partial<Tab> = {}): Tab => ({ id, type, title, ...extra })

function legacyTask(id: string, name: string, left: Tab[], extra: Partial<LegacyTask> = {}): LegacyTask {
  return {
    id,
    name,
    tabs: { left, right: [] },
    activeTab: { left: left[left.length - 1]?.id ?? null, right: null },
    splitOpen: false,
    splitRatio: 0.5,
    ...extra
  }
}

/** The Home tab builds before the Home page wrote; `TabType` no longer has 'home'. */
function homeTab(projectId: string): Tab {
  return { id: `home-tab-${projectId}`, type: 'home', title: 'Home', system: 'home' } as unknown as Tab
}

const isHomeTab = (t: Tab): boolean => (t as { type: string }).type === 'home'

/** A Home task; `extra` are tabs the user opened in it next to the Home tab. */
function legacyHome(projectId: string, extra: Tab[] = []): LegacyTask {
  return { ...legacyTask(`home-task-${projectId}`, 'Home', [homeTab(projectId), ...extra]), system: 'home', lastInteractedAt: 1_000 }
}

const inbox = { visitedAt: 5_000, eventAt: 6_000, attentionAt: 6_000, settledAt: 7_000 }
const workspace = {
  worktreePath: '/repo/.worktrees/fix-login',
  branchName: 'fix-login',
  baseBranch: 'main',
  relativeProjectPath: ''
}

function legacyData(): Record<string, unknown> {
  const app: LegacyProject = {
    id: 'p-app',
    name: 'app',
    directory: '/repo',
    lastTaskId: 't-multi',
    lifetimeStats: { tasksCreated: 9, notesCreated: 1 },
    tasks: [
      legacyHome('p-app'),
      // Empty: never got a tab (it opens on the prompt box).
      legacyTask('t-empty', 'Empty draft', [], { lastInteractedAt: 2_000, inbox }),
      // One agent with a terminal next to it, terminal first.
      legacyTask('t-chapter', 'Write intro', [
        tab('tab-ch-term', 'terminal', 'Terminal'),
        tab('tab-ch-claude', 'claude', 'Claude Code', { sessionId: 's-1' })
      ], { activeTab: { left: 'tab-ch-claude', right: null }, lastInteractedAt: 3_000, inbox }),
      // Two agents, renamed chat tabs, a note; the second agent was in front.
      legacyTask('t-multi', 'network', [
        tab('tab-m-note', 'note', 'todo', { noteId: 'n-1' }),
        tab('tab-m-a', 'claude-chat', 'Fix parser', { sessionId: 's-a' }),
        tab('tab-m-b', 'claude-chat', 'Parser docs', { sessionId: 's-b' })
      ], { activeTab: { left: 'tab-m-b', right: null }, lastInteractedAt: 4_000, inbox }),
      // Terminals only.
      legacyTask('t-terms', 'Dev servers', [
        tab('tab-tt-1', 'terminal', 'Terminal'),
        tab('tab-tt-2', 'terminal', 'Terminal'),
        tab('tab-tt-3', 'browser', 'Browser', { url: 'http://localhost:3000' })
      ], { activeTab: { left: 'tab-tt-2', right: null } }),
      // A worktree task with a split: agent on the left, editor and diff on the right.
      {
        ...legacyTask('t-ws', 'fix login', [tab('tab-ws-codex', 'codex', 'Codex')]),
        tabs: {
          left: [tab('tab-ws-codex', 'codex', 'Codex')],
          right: [tab('tab-ws-ed', 'editor', 'login.ts', { filePath: 'src/login.ts' }), tab('tab-ws-diff', 'diff', 'login.ts', { filePath: 'src/login.ts' })]
        },
        activeTab: { left: 'tab-ws-codex', right: 'tab-ws-diff' },
        splitOpen: true,
        splitRatio: 0.6,
        workspace,
        lastFocusedAt: 8_000
      },
      // A draft worktree task: no worktree yet.
      legacyTask('t-draft', 'New Task', [], { workspaceDraft: { baseBranch: 'develop' } }),
      // Only a note: neither an agent nor a terminal.
      legacyTask('t-note', 'notes', [tab('tab-n-note', 'note', 'notes', { noteId: 'n-2' })])
    ]
  }
  const remote: LegacyProject = {
    id: 'p-ssh',
    name: 'server',
    directory: '',
    ssh: { host: 'example.test', port: 22, username: 'dev', remoteDir: '/srv/app' },
    lastTaskId: 'home-task-p-ssh',
    tasks: [
      // A Claude Code tab opened in Home survives as a task in `main`.
      legacyHome('p-ssh', [tab('tab-home-cc', 'claude', 'Claude Code', { sessionId: 's-home' })]),
      legacyTask('t-ssh', 'Metrics', [
        tab('tab-s-1', 'claude', 'Claude Code', { sessionId: 's-s1' }),
        tab('tab-s-2', 'claude', 'Claude Code', { sessionId: 's-s2' })
      ], { activeTab: { left: null, right: null }, inbox })
    ]
  }
  const adhoc: LegacyProject = {
    id: 'p-adhoc',
    name: 'scratch',
    directory: '/tmp/scratch',
    ephemeral: true,
    tasks: [legacyHome('p-adhoc'), legacyTask('t-adhoc', 'explore', [tab('tab-ad-pi', 'pi', 'Pi')])]
  }
  return {
    projects: [app, remote, adhoc],
    tags: [],
    projectOrder: ['p-app', 'p-ssh', 'p-adhoc'],
    pinnedItems: [
      { type: 'project', projectId: 'p-ssh' },
      { type: 'task', projectId: 'p-app', taskId: 't-ws' },
      { type: 'task', projectId: 'p-app', taskId: 't-gone' }
    ]
  }
}

function migrate(raw: Record<string, unknown>): ProjectsData {
  return Storage.normalizeProjectsData(JSON.parse(JSON.stringify(raw)) as Record<string, unknown>)
}

function project(data: ProjectsData, id: string): Project {
  const found = data.projects.find(p => p.id === id)
  if (!found) throw new Error(`no project ${id}`)
  return found
}

function stream(data: ProjectsData, projectId: string, streamId: string) {
  const found = project(data, projectId).streams.find(s => s.id === streamId)
  if (!found) throw new Error(`no stream ${streamId}`)
  return found
}

/**
 * What must hold for any legacy snapshot: every tab lands in exactly one task and
 * keeps its fields, every legacy task is a stream with the same id, name and
 * worktree, Inbox state and activity are copied to each task cut from it, the Home
 * task is gone (any other tab it held is a task in `main`), and running the
 * migration again changes nothing.
 */
function expectLossless(raw: Record<string, unknown>): ProjectsData {
  const migrated = migrate(raw)
  const legacyProjects = (raw.projects as unknown[]).filter(isLegacyProject) as LegacyProject[]
  const byId = new Map(migrated.projects.map(p => [p.id, p]))

  for (const legacy of legacyProjects) {
    const next = byId.get(legacy.id)
    // A spent ephemeral project is swept by normalize, before and after the redesign.
    if (!next) {
      expect(legacy.ephemeral).toBe(true)
      continue
    }
    expect(next).not.toHaveProperty('tasks')
    expect(next).not.toHaveProperty('lastTaskId')
    expect(next.streams[0]).toMatchObject({ id: mainStreamId(legacy.id), isMain: true })
    expect(next.streams.filter(s => s.isMain)).toHaveLength(1)

    const newTabs = projectTasks(next).flatMap(taskTabs)
    const newTabById = new Map(newTabs.map(t => [t.id, t]))
    expect(newTabById.size).toBe(newTabs.length)
    // Every tab but Home's own, which went with the Home task.
    const oldTabs = legacy.tasks
      .flatMap(t => [...(t.tabs?.left ?? []), ...(t.tabs?.right ?? [])])
      .filter(t => !isHomeTab(t))
    expect(newTabs).toHaveLength(oldTabs.length)
    for (const oldTab of oldTabs) expect(newTabById.get(oldTab.id)).toEqual(oldTab)

    for (const old of legacy.tasks) {
      if (old.system === 'home') {
        const kept = [...(old.tabs?.left ?? []), ...(old.tabs?.right ?? [])].some(t => !isHomeTab(t))
        if (kept) expect(next.streams[0].tasks.map(t => t.id)).toContain(old.id)
        else expect(projectTasks(next).map(t => t.id)).not.toContain(old.id)
        continue
      }
      const s = next.streams.find(candidate => candidate.id === old.id)
      expect(s, `stream for ${old.id}`).toBeDefined()
      expect(s!.name).toBe(old.name)
      expect(s!.workspace).toEqual(old.workspace)
      expect(s!.tasks.some(t => t.id === old.id)).toBe(true)
      for (const task of s!.tasks) {
        expect(task.inbox).toEqual(old.inbox)
        expect(task.lastInteractedAt).toBe(old.lastInteractedAt ?? old.lastFocusedAt ?? task.lastInteractedAt)
        expect(task.panes.length).toBeLessThanOrEqual(1)
        if (task.panes[0]) expect(task.panes[0].tabs.map(t => t.id)).toContain(task.panes[0].activeTabId)
        const agents = taskTabs(task).filter(t => isAgentTabType(t.type))
        expect(agents.length).toBeLessThanOrEqual(1)
        if (agents[0]) expect(task.mainTabId).toBe(agents[0].id)
      }
    }
  }

  expect(migrate(migrated as unknown as Record<string, unknown>)).toEqual(migrated)
  return migrated
}

describe('streams migration', () => {
  it('loses nothing and is idempotent', () => {
    expectLossless(legacyData())
  })

  it('turns every task into a stream, in order, after main', () => {
    const data = migrate(legacyData())
    expect(project(data, 'p-app').streams.map(s => s.id)).toEqual([
      'main-p-app', 't-empty', 't-chapter', 't-multi', 't-terms', 't-ws', 't-draft', 't-note'
    ])
  })

  it('drops the Home task: main starts empty', () => {
    const main = stream(migrate(legacyData()), 'p-app', 'main-p-app')
    expect(main.name).toBe('main')
    expect(main.tasks).toEqual([])
  })

  it('keeps tabs opened in Home as a task of main with the Home task id', () => {
    const main = stream(migrate(legacyData()), 'p-ssh', 'main-p-ssh')
    expect(main.tasks).toEqual([{
      id: 'home-task-p-ssh',
      name: 'Home',
      mainTabId: 'tab-home-cc',
      panes: [{ tabs: [expect.objectContaining({ id: 'tab-home-cc' })], activeTabId: 'tab-home-cc', width: 1 }],
      lastInteractedAt: 1_000
    }])
  })

  it('makes one task per agent tab; the one in front keeps the id and takes the other tabs', () => {
    const multi = stream(migrate(legacyData()), 'p-app', 't-multi')
    expect(multi.lastTaskId).toBe('t-multi')
    expect(multi.tasks).toEqual([
      {
        id: migratedTaskId('tab-m-a'),
        name: 'Fix parser',
        mainTabId: 'tab-m-a',
        panes: [{ tabs: [expect.objectContaining({ id: 'tab-m-a' })], activeTabId: 'tab-m-a', width: 1 }],
        lastInteractedAt: 4_000,
        inbox
      },
      {
        id: 't-multi',
        name: 'Parser docs',
        mainTabId: 'tab-m-b',
        panes: [{
          tabs: [expect.objectContaining({ id: 'tab-m-b' }), expect.objectContaining({ id: 'tab-m-note' })],
          activeTabId: 'tab-m-b',
          width: 1
        }],
        lastInteractedAt: 4_000,
        inbox
      }
    ])
  })

  it('names a task after the old task when its agent tab still has the default title', () => {
    const chapter = stream(migrate(legacyData()), 'p-app', 't-chapter')
    expect(chapter.tasks).toHaveLength(1)
    expect(chapter.tasks[0]).toMatchObject({ id: 't-chapter', name: 'Write intro', mainTabId: 'tab-ch-claude' })
    // The main tab leads; the terminal follows as an extra tab.
    expect(chapter.tasks[0].panes[0].tabs.map(t => t.id)).toEqual(['tab-ch-claude', 'tab-ch-term'])
  })

  it('without an active agent tab, the last agent tab is the most recent', () => {
    const ssh = stream(migrate(legacyData()), 'p-ssh', 't-ssh')
    expect(ssh.tasks.map(t => [t.id, t.name, t.mainTabId])).toEqual([
      [migratedTaskId('tab-s-1'), 'Metrics', 'tab-s-1'],
      ['t-ssh', 'Metrics', 'tab-s-2']
    ])
  })

  it('turns a task without an agent into one terminal task, keeping the tab in front', () => {
    const terms = stream(migrate(legacyData()), 'p-app', 't-terms')
    expect(terms.tasks).toHaveLength(1)
    expect(terms.tasks[0]).toMatchObject({ id: 't-terms', name: 'Dev servers', mainTabId: 'tab-tt-1' })
    expect(terms.tasks[0].panes).toEqual([{
      tabs: [
        expect.objectContaining({ id: 'tab-tt-1' }),
        expect.objectContaining({ id: 'tab-tt-2' }),
        expect.objectContaining({ id: 'tab-tt-3', url: 'http://localhost:3000' })
      ],
      activeTabId: 'tab-tt-2',
      width: 1
    }])
  })

  it('keeps an empty task empty, and a task with neither agent nor terminal without a main tab', () => {
    const data = migrate(legacyData())
    expect(stream(data, 'p-app', 't-empty').tasks).toEqual([
      { id: 't-empty', name: 'Empty draft', panes: [], lastInteractedAt: 2_000, inbox }
    ])
    const note = stream(data, 'p-app', 't-note').tasks[0]
    expect(note.mainTabId).toBeUndefined()
    expect(note.panes[0].tabs.map(t => t.id)).toEqual(['tab-n-note'])
  })

  it('moves the worktree to the stream and drops the split', () => {
    const ws = stream(migrate(legacyData()), 'p-app', 't-ws')
    expect(ws.workspace).toEqual(workspace)
    expect(ws.tasks).toHaveLength(1)
    const [task] = ws.tasks
    expect(task).not.toHaveProperty('workspace')
    expect(task).not.toHaveProperty('splitOpen')
    expect(task).not.toHaveProperty('tabs')
    expect(task.lastInteractedAt).toBe(8_000)
    expect(task.panes).toEqual([{
      tabs: [
        expect.objectContaining({ id: 'tab-ws-codex' }),
        expect.objectContaining({ id: 'tab-ws-ed' }),
        expect.objectContaining({ id: 'tab-ws-diff' })
      ],
      activeTabId: 'tab-ws-codex',
      width: 1
    }])
  })

  it('keeps a draft worktree on the task of a folder stream', () => {
    const draft = stream(migrate(legacyData()), 'p-app', 't-draft')
    expect(draft.workspace).toBeUndefined()
    expect(draft.tasks[0].workspaceDraft).toEqual({ baseBranch: 'develop' })
  })

  it('remembers the last task through the stream', () => {
    const data = migrate(legacyData())
    expect(project(data, 'p-app').lastStreamId).toBe('t-multi')
    expect(project(data, 'p-ssh').lastStreamId).toBe('main-p-ssh')
    expect(stream(data, 'p-ssh', 'main-p-ssh').lastTaskId).toBe('home-task-p-ssh')
    expect(project(data, 'p-adhoc').lastStreamId).toBeUndefined()
  })

  it('turns a task pin into a pin of its stream and drops a dangling one', () => {
    expect(migrate(legacyData()).pinnedItems).toEqual([
      { type: 'project', projectId: 'p-ssh' },
      { type: 'stream', projectId: 'p-app', streamId: 't-ws' }
    ])
  })

  it('keeps everything else on the project', () => {
    const app = project(migrate(legacyData()), 'p-app')
    expect(app).toMatchObject({ name: 'app', directory: '/repo', lifetimeStats: { tasksCreated: 9, notesCreated: 1 } })
    expect(project(migrate(legacyData()), 'p-ssh').ssh).toEqual({ host: 'example.test', port: 22, username: 'dev', remoteDir: '/srv/app' })
    expect(project(migrate(legacyData()), 'p-adhoc').ephemeral).toBe(true)
  })

  it('still sweeps a spent ephemeral project', () => {
    const raw = legacyData()
    const adhoc = (raw.projects as LegacyProject[])[2]
    adhoc.tasks = [legacyHome('p-adhoc')]
    expect(migrate(raw).projects.map(p => p.id)).toEqual(['p-app', 'p-ssh'])
  })

  it('migrates a mix of old and new projects, and gives a new one without main its main', () => {
    const raw = legacyData()
    const once = migrate(raw)
    const already = { ...project(once, 'p-app') }
    const noMain = { id: 'p-new', name: 'new', directory: '/new', streams: [{ id: 's-1', name: '0.5.0', tasks: [] }] }
    const mixed = migrate({ ...raw, projects: [already, (raw.projects as unknown[])[1], noMain] })
    expect(project(mixed, 'p-app')).toEqual(already)
    expect(project(mixed, 'p-ssh').streams[0].id).toBe('main-p-ssh')
    expect(project(mixed, 'p-new').streams.map(s => s.id)).toEqual(['main-p-new', 's-1'])
  })

  it('treats a project with neither tasks nor streams as new and empty', () => {
    const data = migrate({ projects: [{ id: 'p-bare', name: 'bare', directory: '/bare' }] })
    expect(project(data, 'p-bare').streams).toEqual([{ id: 'main-p-bare', name: 'main', isMain: true, tasks: [] }])
  })

  const snapshotDir = process.env.DEVTOOL_MIGRATION_SNAPSHOTS
  it.runIf(!!snapshotDir)('loses nothing on the real snapshots in DEVTOOL_MIGRATION_SNAPSHOTS', () => {
    const files = fs.readdirSync(snapshotDir!).filter(f => f.endsWith('.json'))
    expect(files.length).toBeGreaterThan(0)
    for (const file of files) {
      const raw = JSON.parse(fs.readFileSync(path.join(snapshotDir!, file), 'utf-8')) as Record<string, unknown>
      if (!Array.isArray(raw.projects)) continue
      expectLossless(raw)
    }
  })
})
