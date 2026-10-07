import { useCallback } from 'react'
import { v4 as uuid } from 'uuid'
import type { NotesRecord, ProjectNote } from '../../../shared/types'
import { resolveLandingTaskId } from '../taskNavigation'
import { incrementLifetimeStat } from '../lifetimeStats'
import type { AppStateCore } from './useAppStateCore'
import { mapProject, paneOfTab, type Pane } from './projectsData'
import {
  addNoteToRecord,
  deleteNoteFromRecord,
  isNoteTab,
  noteTabIds,
  patchNoteInRecord,
  removeNoteTabs,
  retitleNoteTabs
} from './notesData'
import { reassignActiveTabsAfterNoteDelete } from './viewState'
import type { TabsActions } from './useTabs'
import { findTaskInProject, taskTabs } from '../../../shared/streams'

export interface NotesActions {
  notes: NotesRecord
  createNote: (projectId: string, name: string) => ProjectNote
  renameNote: (projectId: string, noteId: string, name: string) => void
  deleteNote: (projectId: string, noteId: string) => void
  /** Debounced: the edit shows at once, the write waits for typing to pause. */
  updateNoteContent: (projectId: string, noteId: string, content: string) => void
  openOrFocusNoteTab: (projectId: string, taskId: string | null, pane: Pane, noteId: string) => void
}

/** Project notes and the note tabs that show them. */
export function useNotes(
  core: AppStateCore,
  deps: Pick<TabsActions, 'addTab' | 'setActiveTab'> & {
    switchToTask: (projectId: string, taskId: string) => void
  }
): NotesActions {
  const { notes, notesRef, mutateNotes, mutateProjects, projectsRef, windowViewStateRef, updateWindowViewState } = core
  const { addTab, setActiveTab, switchToTask } = deps

  const createNote = useCallback((projectId: string, name: string): ProjectNote => {
    const note: ProjectNote = {
      id: uuid(),
      name,
      content: '',
      createdAt: Date.now(),
      updatedAt: Date.now()
    }
    mutateNotes(prev => addNoteToRecord(prev, projectId, note))
    mutateProjects(prev => mapProject(prev, projectId, project => incrementLifetimeStat(project, 'notesCreated')))
    return note
  }, [mutateNotes, mutateProjects])

  const renameNote = useCallback((projectId: string, noteId: string, name: string) => {
    const renamedAt = Date.now()
    // Renaming a note another window deleted is dropped, not a resurrection.
    mutateNotes(prev => patchNoteInRecord(prev, projectId, noteId, { name, updatedAt: renamedAt }))
    mutateProjects(prev => retitleNoteTabs(prev, projectId, noteId, name))
  }, [mutateProjects])

  const deleteNote = useCallback((projectId: string, noteId: string) => {
    mutateNotes(prev => deleteNoteFromRecord(prev, projectId, noteId))

    const project = projectsRef.current.find(p => p.id === projectId)
    const removedTabIds = project ? noteTabIds(project, noteId) : []
    if (removedTabIds.length === 0) return

    updateWindowViewState(prev => {
      if (!project) return prev
      return reassignActiveTabsAfterNoteDelete(prev, project, noteId)
    })

    mutateProjects(prev => removeNoteTabs(prev, projectId, noteId))

    for (const tabId of removedTabIds) {
      window.dispatchEvent(new CustomEvent('tab-removed', { detail: { tabId } }))
    }
  }, [mutateNotes, mutateProjects, updateWindowViewState])

  const updateNoteContent = useCallback((projectId: string, noteId: string, content: string) => {
    const now = Date.now()
    mutateNotes(
      // The documented policy for a replay onto state where another window deleted
      // this note: the deletion wins and the edit is dropped. Resurrecting the note
      // would undo a deliberate delete with a keystroke nobody aimed at it.
      prev => patchNoteInRecord(prev, projectId, noteId, { content, updatedAt: now }),
      // One coalesced entry per note: every keystroke replaces the last, so a replay
      // writes the newest text once instead of every intermediate value in order.
      { key: `note-content:${projectId}:${noteId}`, defer: true }
    )
  }, [mutateNotes])

  const openOrFocusNoteTab = useCallback((
    projectId: string,
    taskId: string | null,
    pane: Pane,
    noteId: string
  ) => {
    const project = projectsRef.current.find(p => p.id === projectId)
    if (!project) return

    // `taskId` may be missing, stale, or belong to a different project (the
    // palette can surface notes from any project). Fall back to the project's
    // own landing task instead of silently doing nothing.
    const targetTaskId = resolveLandingTaskId(project, taskId)
    const task = targetTaskId ? findTaskInProject(project, targetTaskId) : null
    if (!task || !targetTaskId) return

    const view = windowViewStateRef.current
    if (view.selectedProjectId !== projectId || view.selectedTaskId !== targetTaskId) {
      switchToTask(projectId, targetTaskId)
    }

    const allTabs = taskTabs(task)
    const existingTab = allTabs.find(t => isNoteTab(t, noteId))
    if (existingTab) {
      setActiveTab(projectId, targetTaskId, paneOfTab(task, existingTab), existingTab.id)
      return
    }

    const note = notesRef.current[projectId]?.find(n => n.id === noteId)
    if (!note) return

    addTab(projectId, targetTaskId, pane, 'note', { noteId, noteName: note.name })
  }, [addTab, setActiveTab, switchToTask])

  return { notes, createNote, renameNote, deleteNote, updateNoteContent, openOrFocusNoteTab }
}
