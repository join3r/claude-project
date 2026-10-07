/**
 * Fixture builders for the Project › Stream › Task model, written so tests that
 * used to spell tasks as `{ tabs: { left, right } }` stay short.
 *
 * These are plain shape adapters, not the one-time migration
 * (`src/shared/streams-migration.ts`): a fixture task stays one task.
 */
import { createMainStream } from '../../src/shared/types'
import type { Project, Stream, Tab, Task, TaskPane, WorkspaceConfig } from '../../src/shared/types'
import { resolveMainTabId } from '../../src/shared/streams'

export interface FixtureTask extends Omit<Partial<Task>, 'panes'> {
  id: string
  /** Tabs per side; `right` becomes a second pane. */
  tabs?: { left?: Tab[]; right?: Tab[] }
  /** Active tab per side. */
  activeTab?: { left?: string | null; right?: string | null }
  /** Puts the task in a stream of its own with this worktree. */
  workspace?: WorkspaceConfig
  panes?: TaskPane[]
}

/** A task in the new shape, from tabs given per side. */
export function fixtureTask(spec: FixtureTask): Task {
  const { tabs, activeTab, workspace: _workspace, panes: explicit, ...rest } = spec
  const left = tabs?.left ?? []
  const right = tabs?.right ?? []
  const panes: TaskPane[] = explicit ?? []
  if (!explicit) {
    const sides: Array<[Tab[], string | null | undefined]> = [[left, activeTab?.left], [right, activeTab?.right]]
    const nonEmpty = sides.filter(([sideTabs]) => sideTabs.length > 0)
    for (const [sideTabs, active] of nonEmpty) {
      panes.push({
        tabs: sideTabs,
        activeTabId: active && sideTabs.some(t => t.id === active) ? active : sideTabs[sideTabs.length - 1].id,
        width: 1 / nonEmpty.length
      })
    }
  }
  const mainTabId = rest.mainTabId ?? resolveMainTabId([...left, ...right, ...(explicit ?? []).flatMap(p => p.tabs)])
  return {
    name: spec.id,
    ...rest,
    ...(mainTabId ? { mainTabId } : {}),
    panes
  }
}

export interface FixtureProject extends Omit<Partial<Project>, 'streams'> {
  id: string
  /** Tasks; one with a `workspace` gets a stream of its own (id `stream-<taskId>`), the rest go to `main`. */
  tasks?: FixtureTask[]
  /** Extra streams, appended after those built from `tasks`. */
  streams?: Stream[]
  /** The task the project was last left on: sets `lastStreamId` and that stream's `lastTaskId`. */
  lastTaskId?: string
}

/** A project in the new shape: a `main` stream plus one stream per workspace task. */
export function fixtureProject(spec: FixtureProject): Project {
  const { tasks = [], streams: extra = [], lastTaskId, ...rest } = spec
  const main = createMainStream(spec.id)
  const streams: Stream[] = [main]
  for (const taskSpec of tasks) {
    const task = fixtureTask(taskSpec)
    if (taskSpec.workspace) {
      streams.push({ id: `stream-${task.id}`, name: task.name, workspace: taskSpec.workspace, tasks: [task] })
    } else {
      main.tasks.push(task)
    }
  }
  const all = [...streams, ...extra]
  const lastStream = lastTaskId ? all.find(stream => stream.tasks.some(task => task.id === lastTaskId)) : undefined
  if (lastStream) lastStream.lastTaskId = lastTaskId
  return {
    name: spec.id,
    directory: `/tmp/${spec.id}`,
    ...rest,
    ...(lastStream ? { lastStreamId: lastStream.id } : {}),
    streams: all
  }
}
