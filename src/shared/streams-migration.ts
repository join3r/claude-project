/**
 * One-time migration of `projects.json` from Project › Task › Tab to
 * Project › Stream › Task (docs/plans/2026-10-07-streams-redesign.md, "Migration").
 *
 * Runs inside `Storage.normalizeProjectsData`, so every load (after the startup
 * backup), every restore from a backup and every save goes through it. It is
 * idempotent: a project already holding `streams` is left alone apart from
 * gaining a `main` stream if it has none, and a legacy project is recognised by
 * its `tasks` array.
 *
 * | Today                                   | Becomes                                                      |
 * | --------------------------------------- | ------------------------------------------------------------ |
 * | Task                                    | Stream, same id, name and worktree (or project folder)       |
 * | Agent tab in it                         | Task in that stream                                          |
 * | Terminal, browser, editor, note tabs    | Extra tabs of the stream's most recently used task           |
 * | Task with no agent tab                  | One terminal task (first terminal; other tabs are extras)     |
 * | Split layout                            | Dropped: every task has one pane                             |
 * | Task's Inbox state                      | Copied to each of its new tasks                              |
 * | Task pin                                | Pin of the new stream                                        |
 * | Home task                               | Kept as a task in `main` until step 3 removes it             |
 */
import { createMainStream, isAgentTabType, mainStreamId } from './types'
import type {
  PinnedItem,
  Project,
  Stream,
  Tab,
  Task,
  TaskInboxState,
  WorkspaceConfig,
  WorkspaceDraft
} from './types'
import { singlePane } from './streams'

/** A task as builds before the streams redesign wrote it. */
export interface LegacyTask {
  id: string
  name: string
  tabs?: { left?: Tab[]; right?: Tab[] }
  activeTab?: { left?: string | null; right?: string | null }
  splitOpen?: boolean
  splitRatio?: number
  workspace?: WorkspaceConfig
  workspaceDraft?: WorkspaceDraft
  lastInteractedAt?: number
  /** Older still: the name `lastInteractedAt` had before. */
  lastFocusedAt?: number
  inbox?: TaskInboxState
  system?: 'home'
}

export type LegacyProject = Omit<Project, 'streams' | 'lastStreamId'> & {
  tasks: LegacyTask[]
  lastTaskId?: string
}

/** Default titles an agent tab is born with; a task named after one says nothing. */
const DEFAULT_AGENT_TAB_TITLES = new Set(['Claude Code', 'Claude', 'Codex', 'Pi'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A project in the pre-streams shape: it has `tasks` and no `streams`. */
export function isLegacyProject(value: unknown): boolean {
  return isRecord(value) && !Array.isArray(value.streams) && Array.isArray(value.tasks)
}

function legacyTabs(task: LegacyTask): Tab[] {
  const left = Array.isArray(task.tabs?.left) ? task.tabs.left : []
  const right = Array.isArray(task.tabs?.right) ? task.tabs.right : []
  return [...left, ...right].filter((tab): tab is Tab => isRecord(tab) && typeof tab.id === 'string')
}

/**
 * The agent tab the user was last on: the one active in the left pane, else in the
 * right pane, else the newest (last) agent tab.
 */
function mostRecentAgentTab(task: LegacyTask, agentTabs: Tab[]): Tab {
  for (const activeId of [task.activeTab?.left, task.activeTab?.right]) {
    const active = activeId ? agentTabs.find(tab => tab.id === activeId) : undefined
    if (active) return active
  }
  return agentTabs[agentTabs.length - 1]
}

/** The tab that was in front, when it is one of `tabs`. */
function previouslyActive(task: LegacyTask, tabs: Tab[]): string | undefined {
  for (const activeId of [task.activeTab?.left, task.activeTab?.right]) {
    if (activeId && tabs.some(tab => tab.id === activeId)) return activeId
  }
  return undefined
}

/**
 * Named after the agent tab's title (the migration table), unless the tab still
 * carries its default label ("Claude Code", "Claude", ...): then the old task's
 * name, which is what the user knew the work by.
 */
function taskNameFor(tab: Tab, legacy: LegacyTask): string {
  const title = typeof tab.title === 'string' ? tab.title.trim() : ''
  return title && !DEFAULT_AGENT_TAB_TITLES.has(title) ? title : legacy.name
}

/** Activity and Inbox state every task cut from `legacy` inherits. */
function inheritedState(legacy: LegacyTask): Pick<Task, 'lastInteractedAt' | 'inbox'> {
  const out: Pick<Task, 'lastInteractedAt' | 'inbox'> = {}
  const lastInteractedAt = typeof legacy.lastInteractedAt === 'number'
    ? legacy.lastInteractedAt
    : typeof legacy.lastFocusedAt === 'number' ? legacy.lastFocusedAt : undefined
  if (lastInteractedAt !== undefined) out.lastInteractedAt = lastInteractedAt
  if (isRecord(legacy.inbox)) out.inbox = { ...legacy.inbox }
  return out
}

/** The id a task cut from an agent tab gets, unless it inherits the old task's id. */
export function migratedTaskId(tabId: string): string {
  return `task-${tabId}`
}

/** The new-shape tasks for one legacy task's tabs; the first one returned is the MRU. */
function tasksOf(legacy: LegacyTask): { tasks: Task[]; lastTaskId: string } {
  const tabs = legacyTabs(legacy)
  const inherited = inheritedState(legacy)
  const draft = !legacy.workspace && isRecord(legacy.workspaceDraft) ? { workspaceDraft: { ...legacy.workspaceDraft } } : {}
  const agentTabs = tabs.filter(tab => isAgentTabType(tab.type))

  if (agentTabs.length === 0) {
    // No agent: one terminal task. Its main tab is the first terminal, and every
    // other tab comes along as an extra. A task with no tab at all stays empty
    // (it opens on the prompt box).
    const main = tabs.find(tab => tab.type === 'terminal')
    const ordered = main ? [main, ...tabs.filter(tab => tab !== main)] : tabs
    const task: Task = {
      id: legacy.id,
      name: legacy.name,
      ...(main ? { mainTabId: main.id } : {}),
      panes: singlePane(ordered, previouslyActive(legacy, ordered) ?? main?.id),
      ...draft,
      ...inherited
    }
    return { tasks: [task], lastTaskId: task.id }
  }

  const mru = mostRecentAgentTab(legacy, agentTabs)
  const extras = tabs.filter(tab => !isAgentTabType(tab.type))
  const tasks = agentTabs.map((tab): Task => {
    const isMru = tab === mru
    const paneTabs = isMru ? [tab, ...extras] : [tab]
    return {
      // The MRU task keeps the old task's id, so the window's selection,
      // `config.lastTaskId` and anything else holding that id land on it.
      id: isMru ? legacy.id : migratedTaskId(tab.id),
      name: taskNameFor(tab, legacy),
      mainTabId: tab.id,
      panes: singlePane(paneTabs, isMru ? previouslyActive(legacy, paneTabs) ?? tab.id : tab.id),
      ...(isMru ? draft : {}),
      ...inherited
    }
  })
  return { tasks, lastTaskId: legacy.id }
}

/** One legacy task as a stream (same id, name and worktree). */
export function migrateLegacyTask(legacy: LegacyTask): Stream {
  const { tasks, lastTaskId } = tasksOf(legacy)
  return {
    id: legacy.id,
    name: legacy.name,
    ...(legacy.workspace ? { workspace: legacy.workspace } : {}),
    tasks,
    lastTaskId
  }
}

/** The Home task in the new shape: one pane holding its tabs, kept in `main`. */
function migrateHomeTask(legacy: LegacyTask): Task {
  const tabs = legacyTabs(legacy)
  const inherited = inheritedState(legacy)
  return {
    id: legacy.id,
    name: legacy.name,
    panes: singlePane(tabs, previouslyActive(legacy, tabs)),
    system: 'home',
    ...inherited
  }
}

export function migrateLegacyProject(legacy: LegacyProject): Project {
  const { tasks: legacyTasks, lastTaskId, ...rest } = legacy
  const homeTasks: Task[] = []
  const streams: Stream[] = []
  for (const task of legacyTasks) {
    if (!isRecord(task) || typeof task.id !== 'string') continue
    if (task.system === 'home') homeTasks.push(migrateHomeTask(task))
    else streams.push(migrateLegacyTask(task))
  }
  const main = createMainStream(legacy.id, homeTasks)
  const project: Project = { ...rest, streams: [main, ...streams] }
  if (lastTaskId) {
    if (homeTasks.some(task => task.id === lastTaskId)) {
      main.lastTaskId = lastTaskId
      project.lastStreamId = main.id
    } else if (streams.some(stream => stream.id === lastTaskId)) {
      project.lastStreamId = lastTaskId
    }
  }
  return project
}

/** A new-shape project with a `main` stream first (added when missing). */
function ensureMainStream(project: Project): Project {
  const main = project.streams.find(stream => stream.isMain)
  if (main && project.streams[0] === main) return project
  if (main) return { ...project, streams: [main, ...project.streams.filter(stream => stream !== main)] }
  const id = project.streams.some(stream => stream.id === mainStreamId(project.id))
    ? `${mainStreamId(project.id)}-${project.streams.length}`
    : mainStreamId(project.id)
  return { ...project, streams: [{ ...createMainStream(project.id), id }, ...project.streams] }
}

/**
 * Every project in the new shape; `migrated` says whether any was legacy. `migratedStreamIds` is the set of streams cut
 * from legacy tasks — the only ids an old task pin can point at.
 */
export function migrateProjects(raw: unknown[]): { projects: Project[]; migrated: boolean; migratedStreamIds: Set<string> } {
  let migrated = false
  const migratedStreamIds = new Set<string>()
  const projects: Project[] = []
  for (const value of raw) {
    if (!isRecord(value)) continue
    if (isLegacyProject(value)) {
      migrated = true
      const project = migrateLegacyProject(value as unknown as LegacyProject)
      for (const stream of project.streams) if (!stream.isMain) migratedStreamIds.add(`${project.id}:${stream.id}`)
      projects.push(project)
      continue
    }
    const streams = Array.isArray(value.streams) ? value.streams as Stream[] : []
    const project = ensureMainStream({
      ...(value as unknown as Project),
      streams: streams
        .filter(stream => isRecord(stream) && typeof stream.id === 'string')
        .map(stream => (Array.isArray(stream.tasks) ? stream : { ...stream, tasks: [] }))
    })
    projects.push(project)
  }
  return { projects, migrated, migratedStreamIds }
}

/**
 * Old pins in the new shape: a task pin with no `streamId` pointed at a legacy
 * task, which is now the stream with the same id. Everything else passes through
 * for `normalizePinnedItems` to check.
 */
export function migratePinnedItems(items: unknown, migratedStreamIds: ReadonlySet<string>): unknown[] {
  if (!Array.isArray(items)) return []
  return items.map((raw): unknown => {
    if (!isRecord(raw) || raw.type !== 'task' || typeof raw.streamId === 'string') return raw
    if (typeof raw.projectId !== 'string' || typeof raw.taskId !== 'string') return raw
    if (!migratedStreamIds.has(`${raw.projectId}:${raw.taskId}`)) return raw
    const pin: PinnedItem = { type: 'stream', projectId: raw.projectId, streamId: raw.taskId }
    return pin
  })
}
