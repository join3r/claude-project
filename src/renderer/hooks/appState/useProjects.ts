import { useCallback, useRef } from 'react'
import { v4 as uuid } from 'uuid'
import { createMainStream } from '../../../shared/types'
import { projectTasks, taskTabs } from '../../../shared/streams'
import type {
  AiTabType,
  PinnedItem,
  Project,
  ProjectsData,
  SshConfig,
  Tag,
  WorkspaceDeleteResult
} from '../../../shared/types'
import type { AppStateCore } from './useAppStateCore'
import type { ConnectSsh } from './remote'
import {
  appendProject,
  findOrCreateTagId,
  getProjectDir,
  includePendingTags as includePendingTagsIn,
  mapProject,
  removeProjectFromData,
  renameTagInData,
  reorderList,
  tabIdsOfTask,
  togglePinnedItemInData
} from './projectsData'
import { removeProjectView } from './viewState'

export type ProjectUpdate = Partial<Pick<Project, 'directory' | 'aiToolArgs' | 'condaEnvName' | 'condaEnvPrefix' | 'tunnel' | 'emoji' | 'icon' | 'tagIds' | 'ephemeral' | 'hideFromMobile'>>

export interface ProjectsActions {
  addProject: (name: string, directory: string, tagIds?: string[]) => Project
  addRemoteProject: (
    name: string,
    sshConfig: SshConfig,
    aiToolArgs?: Partial<Record<AiTabType, string>>,
    tagIds?: string[]
  ) => Project
  addShellCommandProject: (name: string, command: string, tagIds?: string[]) => Project
  connectSsh: ConnectSsh
  getProjectDir: (project: Project) => string
  removeProject: (id: string) => Promise<void>
  renameProject: (id: string, name: string) => void
  updateProject: (id: string, updates: ProjectUpdate) => void
  reorderProjects: (fromIndex: number, toIndex: number) => void
  /** Returns the id of the tag named `name`, minting a pending one when it is new ('' for a blank name). */
  addTag: (name: string) => string
  renameTag: (tagId: string, name: string) => void
  setProjectTags: (projectId: string, tagIds: string[]) => void
  findOrCreateTagId: (data: ProjectsData, name: string) => { data: ProjectsData; tagId: string }
  togglePinnedItem: (item: PinnedItem) => void
  setPinnedOrder: (items: PinnedItem[]) => void
}

/**
 * These deletions are fire-and-forget and nobody is standing in front of a dialog for them,
 * but a refusal still must not vanish: 'invalid-worktree' means main deliberately left a
 * directory on disk rather than recursively deleting something it could not identify.
 */
export function reportRefusedWorkspaceDelete(result: WorkspaceDeleteResult): void {
  if (result.status === 'ok') return
  console.warn(`Workspace not removed (${result.status}): ${result.reason ?? 'no reason given'}`)
}

/** Projects, their tags and the pinned-items list. */
export function useProjects(
  core: AppStateCore,
  deps: {
    connectSsh: ConnectSsh
    confirmDiscardDirty: (tabIds: string[]) => Promise<'proceed' | 'cancel'>
    selectProject: (id: string | null) => void
  }
): ProjectsActions {
  const { mutateProjects, projectsRef, projectsDataRef, updateWindowViewState } = core
  const { connectSsh, confirmDiscardDirty, selectProject } = deps
  const pendingTagsRef = useRef<Map<string, Tag>>(new Map())

  const includePendingTags = useCallback((data: ProjectsData, tagIds?: readonly string[]): ProjectsData => {
    return includePendingTagsIn(data, tagIds, pendingTagsRef.current)
  }, [])

  const addProject = useCallback((name: string, directory: string, tagIds?: string[]) => {
    const id = uuid()
    const project: Project = {
      id,
      name,
      directory,
      streams: [createMainStream(id)],
      ...(tagIds && tagIds.length > 0 ? { tagIds } : {})
    }
    mutateProjects(prev => appendProject(includePendingTags(prev, tagIds), project))
    selectProject(project.id)
    return project
  }, [includePendingTags, mutateProjects, selectProject])

  const addRemoteProject = useCallback((
    name: string,
    sshConfig: SshConfig,
    aiToolArgs?: Partial<Record<AiTabType, string>>,
    tagIds?: string[]
  ) => {
    const id = uuid()
    const project: Project = {
      id,
      name,
      directory: '',
      ssh: sshConfig,
      streams: [createMainStream(id)],
      ...(aiToolArgs ? { aiToolArgs } : {}),
      ...(tagIds && tagIds.length > 0 ? { tagIds } : {})
    }
    mutateProjects(prev => appendProject(includePendingTags(prev, tagIds), project))
    selectProject(project.id)
    connectSsh(project.id, sshConfig).catch(() => {})
    return project
  }, [connectSsh, includePendingTags, mutateProjects, selectProject])

  const addShellCommandProject = useCallback((name: string, command: string, tagIds?: string[]) => {
    const id = uuid()
    const project: Project = {
      id,
      name,
      directory: '',
      shellCommand: { command },
      streams: [createMainStream(id)],
      ...(tagIds && tagIds.length > 0 ? { tagIds } : {})
    }
    mutateProjects(prev => appendProject(includePendingTags(prev, tagIds), project))
    selectProject(project.id)
    return project
  }, [includePendingTags, mutateProjects, selectProject])

  const removeProject = useCallback(async (id: string) => {
    const doomed = projectsRef.current.find(p => p.id === id)
    // One dialog for the whole project, asked before anything is torn down.
    if (doomed) {
      const tabIds = projectTasks(doomed).flatMap(tabIdsOfTask)
      if (await confirmDiscardDirty(tabIds) === 'cancel') return
    }

    const project = projectsRef.current.find(p => p.id === id)
    if (project) {
      for (const task of projectTasks(project)) {
        for (const tab of taskTabs(task)) {
          window.dispatchEvent(new CustomEvent('tab-removed', { detail: { tabId: tab.id } }))
          void window.api.scrollbackDelete(tab.id)
        }
      }
      for (const { workspace } of project.streams) {
        if (workspace) {
          await window.api.workspaceDelete(
            {
              projectDir: getProjectDir(project),
              projectId: id,
              sshConfig: project.ssh,
              worktreePath: workspace.worktreePath,
              branchName: workspace.branchName,
              baseBranch: workspace.baseBranch,
              force: true
            }
          ).then(reportRefusedWorkspaceDelete).catch(() => {})
        }
      }
      if (project.ssh) {
        await window.api.sshDisconnect(id, project.ssh).catch(() => {})
      }
    }

    mutateProjects(prev => removeProjectFromData(prev, id))
    updateWindowViewState(prev => removeProjectView(prev, id))
  }, [confirmDiscardDirty, mutateProjects, updateWindowViewState])

  const renameProject = useCallback((id: string, name: string) => {
    mutateProjects(prev => mapProject(prev, id, project => ({ ...project, name })))
  }, [mutateProjects])

  const updateProject = useCallback((id: string, updates: ProjectUpdate) => {
    mutateProjects(prev => mapProject(includePendingTags(prev, updates.tagIds), id, project => ({ ...project, ...updates })))
  }, [includePendingTags, mutateProjects])

  const addTag = useCallback((name: string): string => {
    const trimmed = name.trim()
    if (!trimmed) return ''
    const existing = projectsDataRef.current.tags.find(t => t.name.toLowerCase() === trimmed.toLowerCase())
    if (existing) return existing.id
    const pending = [...pendingTagsRef.current.values()].find(t => t.name.toLowerCase() === trimmed.toLowerCase())
    if (pending) return pending.id
    const tag: Tag = { id: uuid(), name: trimmed }
    pendingTagsRef.current.set(tag.id, tag)
    return tag.id
  }, [])

  const renameTag = useCallback((tagId: string, name: string) => {
    const trimmed = name.trim()
    if (!trimmed) return
    mutateProjects(prev => renameTagInData(prev, tagId, trimmed))
  }, [mutateProjects])

  const setProjectTags = useCallback((projectId: string, tagIds: string[]) => {
    mutateProjects(prev => mapProject(includePendingTags(prev, tagIds), projectId, project => ({ ...project, tagIds })))
  }, [includePendingTags, mutateProjects])

  const reorderProjects = useCallback((fromIndex: number, toIndex: number) => {
    mutateProjects(prev => ({ ...prev, projectOrder: reorderList(prev.projectOrder, fromIndex, toIndex) }))
  }, [mutateProjects])

  const togglePinnedItem = useCallback((item: PinnedItem) => {
    mutateProjects(prev => togglePinnedItemInData(prev, item))
  }, [mutateProjects])

  const setPinnedOrder = useCallback((items: PinnedItem[]) => {
    mutateProjects(prev => ({ ...prev, pinnedItems: [...items] }))
  }, [mutateProjects])

  return {
    addProject,
    addRemoteProject,
    addShellCommandProject,
    connectSsh,
    getProjectDir,
    removeProject,
    renameProject,
    updateProject,
    reorderProjects,
    addTag,
    renameTag,
    setProjectTags,
    findOrCreateTagId,
    togglePinnedItem,
    setPinnedOrder
  }
}
