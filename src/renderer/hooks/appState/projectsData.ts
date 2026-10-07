/**
 * Pure state transitions over `ProjectsData`. Every function here is a plain
 * `prev -> next` step with no React, refs or IPC, so the updaters handed to
 * `mutateProjects` stay idempotent under a compare-and-swap replay and can be
 * unit-tested directly.
 */
import { v4 as uuid } from 'uuid'
import { createMainStream, isSpentEphemeralProject, pinnedItemKey } from '../../../shared/types'
import type { PinnedItem, Project, ProjectsData, Stream, Tab, Tag, Task, WorkspaceConfig, WorkspaceDraft } from '../../../shared/types'
import {
  addTaskToStream,
  findStreamOfTask,
  findTaskInProject,
  projectTasks,
  mapTaskInProject,
  paneSideOfTab,
  paneTabs,
  removeTaskFromProject,
  resolveMainTabId,
  singlePane,
  taskTabIds,
  withPaneTabs,
  type PaneSide
} from '../../../shared/streams'
import { dirBasename } from '../../../shared/paths'
import { incrementLifetimeStat } from '../lifetimeStats'

/** TEMPORARY (step 4 replaces it): the window's two panes, `panes[0]` and `panes[1]`. */
export type Pane = PaneSide

/** The task literal every "add a task" path starts from. */
export function makeTask(name: string, initialTabs: Tab[], workspaceDraft?: WorkspaceDraft): Task {
  const mainTabId = resolveMainTabId(initialTabs)
  return {
    id: uuid(),
    name,
    ...(mainTabId ? { mainTabId } : {}),
    panes: singlePane(initialTabs),
    ...(workspaceDraft ? { workspaceDraft } : {}),
    // Creating a task is an interaction: without the stamp a brand-new task has
    // no activity at all and sinks to the bottom of the inbox's active group.
    lastInteractedAt: Date.now()
  }
}

/**
 * Where a new task goes: a new stream named after it when it brings a worktree
 * (TEMPORARY until the new-stream dialog, step 6), else the project's `main`.
 */
export interface TaskPlacement {
  /** A new stream to create around the task, holding this worktree. */
  workspace?: WorkspaceConfig
  /** A new (still folder) stream, for a task whose worktree comes later (`workspaceDraft`). */
  ownStream?: boolean
  /** Precomputed so a replayed updater creates the same stream. */
  streamId?: string
}

export function tabIdsOfTask(task: Task): string[] {
  return taskTabIds(task)
}

/** A remote project's working directory lives on the far side of its SSH config. */
export function getProjectDir(project: Project): string {
  return project.ssh ? project.ssh.remoteDir : project.directory
}

/** Move one element of a list, as the sidebar drag-and-drop reports it. */
export function reorderList<T>(list: readonly T[], fromIndex: number, toIndex: number): T[] {
  const next = [...list]
  const [moved] = next.splice(fromIndex, 1)
  next.splice(toIndex, 0, moved)
  return next
}

export function mapProject(data: ProjectsData, projectId: string, fn: (project: Project) => Project): ProjectsData {
  return {
    ...data,
    projects: data.projects.map(project => (project.id === projectId ? fn(project) : project))
  }
}

export function mapTask(
  data: ProjectsData,
  projectId: string,
  taskId: string,
  fn: (task: Task) => Task
): ProjectsData {
  return mapProject(data, projectId, project => mapTaskInProject(project, taskId, fn))
}

/** Replace one pane's tab list of one task. */
export function mapPaneTabs(
  data: ProjectsData,
  projectId: string,
  taskId: string,
  pane: Pane,
  fn: (tabs: Tab[]) => Tab[]
): ProjectsData {
  return mapTask(data, projectId, taskId, task => withPaneTabs(task, pane, fn(paneTabs(task, pane))))
}

/** Patch one tab in place; every other tab keeps its identity. */
export function patchTab(
  data: ProjectsData,
  projectId: string,
  taskId: string,
  pane: Pane,
  tabId: string,
  patch: Partial<Tab>
): ProjectsData {
  return mapPaneTabs(data, projectId, taskId, pane, tabs =>
    tabs.map(tab => (tab.id === tabId ? { ...tab, ...patch } : tab))
  )
}

export function renameTabInData(
  data: ProjectsData,
  projectId: string,
  taskId: string,
  pane: Pane,
  tabId: string,
  title: string
): ProjectsData {
  return mapPaneTabs(data, projectId, taskId, pane, tabs =>
    tabs.map(tab => (tab.id === tabId && tab.title !== title ? { ...tab, title } : tab))
  )
}

/**
 * Put a tab back where it was closed from, clamped into the pane. A replay that
 * finds the tab already there is a no-op.
 */
export function insertTabAt(
  data: ProjectsData,
  projectId: string,
  taskId: string,
  pane: Pane,
  index: number,
  tab: Tab
): ProjectsData {
  return mapTask(data, projectId, taskId, task => {
    if (paneTabs(task, pane).some(existingTab => existingTab.id === tab.id)) return task
    const nextTabs = [...paneTabs(task, pane)]
    nextTabs.splice(Math.min(Math.max(index, 0), nextTabs.length), 0, tab)
    return withPaneTabs(task, pane, nextTabs)
  })
}

export function appendProject(data: ProjectsData, project: Project): ProjectsData {
  return {
    ...data,
    projects: [...data.projects, project],
    projectOrder: [...data.projectOrder, project.id]
  }
}

export function removeProjectFromData(data: ProjectsData, projectId: string): ProjectsData {
  return {
    ...data,
    projects: data.projects.filter(project => project.id !== projectId),
    projectOrder: data.projectOrder.filter(rootId => rootId !== projectId)
  }
}

/** `task` placed in `project` per `placement`. A replay that finds the task there is a no-op. */
export function placeTask(project: Project, task: Task, placement: TaskPlacement = {}): Project {
  if (findTaskInProject(project, task.id)) return project
  if (placement.workspace || placement.ownStream) {
    const stream: Stream = {
      id: placement.streamId ?? uuid(),
      name: task.name,
      ...(placement.workspace ? { workspace: placement.workspace } : {}),
      tasks: [task],
      lastTaskId: task.id
    }
    return { ...project, streams: [...project.streams, stream] }
  }
  return addTaskToStream(project, null, task)
}

/** Add a task to a project and count it in the project's lifetime stats. */
export function appendTaskToProject(data: ProjectsData, projectId: string, task: Task, placement?: TaskPlacement): ProjectsData {
  return {
    ...data,
    projects: data.projects.map(project =>
      project.id === projectId
        ? incrementLifetimeStat(placeTask(project, task, placement), 'tasksCreated')
        : project
    )
  }
}

/**
 * File `task` under the hidden project `ownerId` for `directory`, minting the
 * project in the same step when it does not exist yet so an empty ad-hoc
 * project never reaches disk.
 */
export function addTaskInDirectoryData(
  data: ProjectsData,
  ownerId: string,
  directory: string,
  task: Task,
  placement?: TaskPlacement
): ProjectsData {
  if (data.projects.some(p => p.id === ownerId)) {
    return appendTaskToProject(data, ownerId, task, placement)
  }
  const project: Project = placeTask({
    id: ownerId,
    name: dirBasename(directory),
    directory,
    ephemeral: true,
    streams: [createMainStream(ownerId)]
  }, task, placement)
  return {
    ...data,
    projects: [...data.projects, incrementLifetimeStat(project, 'tasksCreated')],
    projectOrder: [...data.projectOrder, project.id]
  }
}

/**
 * Drop a task; a hidden ad-hoc project left with no task goes with it in the
 * same step.
 */
export function removeTaskFromData(data: ProjectsData, projectId: string, taskId: string): ProjectsData {
  const withoutTask = data.projects.map(project =>
    project.id === projectId ? removeTaskFromProject(project, taskId) : project
  )
  const spent = withoutTask.find(p => p.id === projectId && isSpentEphemeralProject(p))
  if (!spent) return { ...data, projects: withoutTask }
  return {
    ...data,
    projects: withoutTask.filter(p => p.id !== projectId),
    projectOrder: data.projectOrder.filter(id => id !== projectId)
  }
}

/**
 * Point a task's stream at the worktree just created for it and end the task's
 * draft. A task sitting in `main` (which never takes a worktree) moves into a new
 * stream `streamId` first.
 */
export function attachWorkspaceInData(
  data: ProjectsData,
  projectId: string,
  taskId: string,
  workspace: WorkspaceConfig,
  streamId: string
): ProjectsData {
  return mapProject(data, projectId, project => {
    const stream = findStreamOfTask(project, taskId)
    const task = findTaskInProject(project, taskId)
    if (!stream || !task) return project
    const { workspaceDraft: _draft, ...plain } = task
    if (stream.isMain) {
      return placeTask(removeTaskFromProject(project, taskId), plain, { workspace, streamId })
    }
    return {
      ...project,
      streams: project.streams.map(candidate => (
        candidate === stream
          ? { ...candidate, workspace, tasks: candidate.tasks.map(t => (t.id === taskId ? plain : t)) }
          : candidate
      ))
    }
  })
}

/**
 * Move a task within its stream, by positions in the project's flat task list
 * (`projectTasks`). TEMPORARY (step 5 adds dragging between streams): a drop
 * into another stream is ignored.
 */
export function reorderTaskInData(data: ProjectsData, projectId: string, fromIndex: number, toIndex: number): ProjectsData {
  return mapProject(data, projectId, project => {
    const flat = projectTasks(project)
    const moved = flat[fromIndex]
    if (!moved) return project
    const stream = findStreamOfTask(project, moved.id)
    if (!stream) return project
    const first = flat.indexOf(stream.tasks[0])
    const localFrom = fromIndex - first
    const localTo = toIndex - first
    if (localTo < 0 || localTo >= stream.tasks.length || localFrom === localTo) return project
    return {
      ...project,
      streams: project.streams.map(candidate => (
        candidate === stream ? { ...candidate, tasks: reorderList(candidate.tasks, localFrom, localTo) } : candidate
      ))
    }
  })
}

/**
 * Tags minted by `addTag` live outside the data until something references them;
 * this folds the referenced ones in.
 */
export function includePendingTags(
  data: ProjectsData,
  tagIds: readonly string[] | undefined,
  pendingTags: ReadonlyMap<string, Tag>
): ProjectsData {
  if (!tagIds?.length) return data
  const existingTagIds = new Set(data.tags.map(tag => tag.id))
  const pending = tagIds
    .map(tagId => pendingTags.get(tagId))
    .filter((tag): tag is Tag => !!tag && !existingTagIds.has(tag.id))
  if (pending.length === 0) return data
  return { ...data, tags: [...data.tags, ...pending] }
}

/** Case-insensitive lookup by name, adding the tag when it is new. An empty name yields `''`. */
export function findOrCreateTagId(data: ProjectsData, name: string): { data: ProjectsData; tagId: string } {
  const trimmed = name.trim()
  if (!trimmed) return { data, tagId: '' }
  const existing = data.tags.find(t => t.name.toLowerCase() === trimmed.toLowerCase())
  if (existing) return { data, tagId: existing.id }
  const tagId = uuid()
  const tag: Tag = { id: tagId, name: trimmed }
  return { data: { ...data, tags: [...data.tags, tag] }, tagId }
}

export function renameTagInData(data: ProjectsData, tagId: string, name: string): ProjectsData {
  return {
    ...data,
    tags: data.tags.map(tag => (tag.id === tagId ? { ...tag, name } : tag))
  }
}

/** Pin the item, or unpin it when it is already pinned. */
export function togglePinnedItemInData(data: ProjectsData, item: PinnedItem): ProjectsData {
  const key = pinnedItemKey(item)
  const existing = data.pinnedItems ?? []
  const without = existing.filter(candidate => pinnedItemKey(candidate) !== key)
  return {
    ...data,
    pinnedItems: without.length < existing.length ? without : [...existing, item]
  }
}

export function findTask(projects: readonly Project[], projectId: string, taskId: string | null): Task | undefined {
  return findTaskInProject(projects.find(candidate => candidate.id === projectId), taskId)
}

/** The pane a tab lives in, when the task has it. */
export function paneOfTab(task: Task, tab: Tab): Pane {
  return paneSideOfTab(task, tab.id) ?? 'left'
}
