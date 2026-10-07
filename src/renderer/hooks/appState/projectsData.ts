/**
 * Pure state transitions over `ProjectsData`. Every function here is a plain
 * `prev -> next` step with no React, refs or IPC, so the updaters handed to
 * `mutateProjects` stay idempotent under a compare-and-swap replay and can be
 * unit-tested directly.
 */
import { v4 as uuid } from 'uuid'
import { createMainStream, pinnedItemKey } from '../../../shared/types'
import type { PinnedItem, Project, ProjectsData, Stream, Tab, Tag, Task, WorkspaceConfig } from '../../../shared/types'
import {
  addTaskToStream,
  findStreamOfTask,
  findTaskInProject,
  mapTaskInProject,
  resolveMainTabId,
  singlePane,
  taskTabIds
} from '../../../shared/streams'
import { addTabToPane, patchTabInTask } from '../../../shared/panes'
import { dirBasename } from '../../../shared/paths'
import { incrementLifetimeStat } from '../lifetimeStats'

/** The task literal every "add a task" path starts from. */
export function makeTask(name: string, initialTabs: Tab[]): Task {
  const mainTabId = resolveMainTabId(initialTabs)
  return {
    id: uuid(),
    name,
    ...(mainTabId ? { mainTabId } : {}),
    panes: singlePane(initialTabs),
    // Creating a task is an interaction: without the stamp a brand-new task has
    // no activity at all and sinks to the bottom of the inbox's active group.
    lastInteractedAt: Date.now()
  }
}

/** The stream literal the new-stream dialog creates: a worktree, or the project folder. */
export function makeStream(name: string, workspace?: WorkspaceConfig): Stream {
  return { id: uuid(), name, ...(workspace ? { workspace } : {}), tasks: [] }
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

/** Patch one tab in place; every other tab keeps its identity. */
export function patchTab(
  data: ProjectsData,
  projectId: string,
  taskId: string,
  tabId: string,
  patch: Partial<Tab>
): ProjectsData {
  return mapTask(data, projectId, taskId, task => patchTabInTask(task, tabId, patch))
}

export function renameTabInData(
  data: ProjectsData,
  projectId: string,
  taskId: string,
  tabId: string,
  title: string
): ProjectsData {
  return patchTab(data, projectId, taskId, tabId, { title })
}

/**
 * Put a tab back where it was closed from: at `index` in pane `pane`, both clamped
 * into the task's row as it is now. A replay that finds the tab already there is a
 * no-op.
 */
export function insertTabAt(
  data: ProjectsData,
  projectId: string,
  taskId: string,
  pane: number,
  index: number,
  tab: Tab
): ProjectsData {
  return mapTask(data, projectId, taskId, task => addTabToPane(task, pane, tab, { index }))
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

/**
 * `task` appended to stream `streamId` (`main` when absent or gone). A replay
 * that finds the task there is a no-op.
 */
export function placeTask(project: Project, task: Task, streamId?: string | null): Project {
  if (findTaskInProject(project, task.id)) return project
  return addTaskToStream(project, streamId ?? null, task)
}

/** Add a task to a project's stream and count it in the project's lifetime stats. */
export function appendTaskToProject(data: ProjectsData, projectId: string, task: Task, streamId?: string | null): ProjectsData {
  return {
    ...data,
    projects: data.projects.map(project =>
      project.id === projectId && !findTaskInProject(project, task.id)
        ? incrementLifetimeStat(placeTask(project, task, streamId), 'tasksCreated')
        : project
    )
  }
}

/** Add a stream at the end of the project's list. A replay that finds it there is a no-op. */
export function addStreamInData(data: ProjectsData, projectId: string, stream: Stream): ProjectsData {
  return mapProject(data, projectId, project => (
    project.streams.some(candidate => candidate.id === stream.id)
      ? project
      : { ...project, streams: [...project.streams, stream] }
  ))
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
  task: Task
): ProjectsData {
  if (data.projects.some(p => p.id === ownerId)) {
    return appendTaskToProject(data, ownerId, task)
  }
  const project: Project = placeTask({
    id: ownerId,
    name: dirBasename(directory),
    directory,
    ephemeral: true,
    streams: [createMainStream(ownerId)]
  }, task)
  return {
    ...data,
    projects: [...data.projects, incrementLifetimeStat(project, 'tasksCreated')],
    projectOrder: [...data.projectOrder, project.id]
  }
}

/**
 * Move a task to `toIndex` of stream `toStreamId` (counted without the task),
 * within its stream or to another one. The stream it leaves stays even when
 * emptied, so a worktree never goes away under a drag; its "last task" follows
 * the task, and so does a pin of the task. Returns `data` itself for a no-op.
 */
export function moveTaskInData(
  data: ProjectsData,
  projectId: string,
  taskId: string,
  toStreamId: string,
  toIndex: number
): ProjectsData {
  const project = data.projects.find(candidate => candidate.id === projectId)
  const from = findStreamOfTask(project, taskId)
  const to = project?.streams.find(stream => stream.id === toStreamId)
  const task = findTaskInProject(project, taskId)
  if (!project || !from || !to || !task) return data
  const fromIndex = from.tasks.indexOf(task)
  const targetTasks = to.tasks.filter(candidate => candidate.id !== taskId)
  const index = Math.max(0, Math.min(toIndex, targetTasks.length))
  if (from === to && index === fromIndex) return data
  const wasLast = from.lastTaskId === taskId
  const streams = project.streams.map(stream => {
    if (stream === to) {
      const tasks = [...targetTasks.slice(0, index), task, ...targetTasks.slice(index)]
      return { ...stream, tasks, ...(wasLast && from !== to ? { lastTaskId: taskId } : {}) }
    }
    if (stream === from) {
      const { lastTaskId: _last, ...rest } = stream
      return { ...(wasLast ? rest : stream), tasks: stream.tasks.filter(t => t.id !== taskId) }
    }
    return stream
  })
  const next: Project = {
    ...project,
    streams,
    ...(wasLast && project.lastStreamId === from.id ? { lastStreamId: to.id } : {})
  }
  return {
    ...data,
    projects: data.projects.map(candidate => (candidate === project ? next : candidate)),
    pinnedItems: (data.pinnedItems ?? []).map(item => (
      item.type === 'task' && item.projectId === projectId && item.taskId === taskId ? { ...item, streamId: to.id } : item
    ))
  }
}

/** Rename a stream. Its branch keeps its name. */
export function renameStreamInData(data: ProjectsData, projectId: string, streamId: string, name: string): ProjectsData {
  return mapProject(data, projectId, project => ({
    ...project,
    streams: project.streams.map(stream => (stream.id === streamId ? { ...stream, name } : stream))
  }))
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
