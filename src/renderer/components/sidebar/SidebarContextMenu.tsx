import React, { useEffect, useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { useApp } from '../../context/AppContext'
import { isEphemeralProject } from '../../../shared/types'
import type { PinnedItem, Task } from '../../../shared/types'
import { useMenuPosition } from '../../hooks/useMenuPosition'
import { isSnoozed, isUnread, snoozePresets } from '../inbox'
import { menuCls, menuItemCls } from '../ui'
import { revealInFolderLabel } from '../../utils/revealLabel'
import type { SidebarContextMenuState } from './SidebarParts'
import { findStreamOfTask, findTaskInProject } from '../../../shared/streams'
import { useTabStatusStore } from '../../context/TabStatusContext'
import { canLandTask, getLandingOp } from '../../taskLanding'
import { useTaskLandingActions } from '../useTaskLandingActions'
import { landingActionBlocker } from './closeRules'
import {
  MoveToStreamItems, ProjectMenuItems, StreamMenuHeader, StreamMenuItems, SubmenuBack, SubmenuButton
} from '../menus/EntityMenus'
import { revealFolder } from '../menus/projectMenuRules'

export {
  revealFolder, projectDeletePrompt, canTrashProjectFolder, projectDeleteWithFolderPrompt
} from '../menus/projectMenuRules'

/** A task menu's other pages: its stream's menu, its project's, and the streams it can move to. */
type TaskMenuPage = 'main' | 'stream' | 'project' | 'move'

/**
 * The right-click menu for a project, stream or task row, and the snooze
 * presets that replace its body rather than fly out sideways — a nested flyout
 * would run off the edge of a 240px sidebar. A task's stream and project menus,
 * and the streams it can move to, are pages of the same menu for that reason.
 */
export default function SidebarContextMenu({
  contextMenu,
  snoozeSubmenu,
  setSnoozeSubmenu,
  closeContextMenu,
  findTask,
  handleCloseTask,
  handleCloseStream,
  beginEdit,
  isPinned,
  missingDirs
}: {
  contextMenu: SidebarContextMenuState | null
  snoozeSubmenu: boolean
  setSnoozeSubmenu: (open: boolean) => void
  /** Closes the menu and resets the snooze page. */
  closeContextMenu: () => void
  findTask: (projectId: string, taskId: string) => Task | undefined
  handleCloseTask: (projectId: string, taskId: string) => void | Promise<void>
  handleCloseStream: (projectId: string, streamId: string) => void | Promise<void>
  /** Rename inline; `streamId` opens that stream so the row is on screen. */
  beginEdit: (id: string, name: string, projectId?: string, streamId?: string) => void
  isPinned: (item: PinnedItem) => boolean
  /** Projects whose folder is gone. */
  missingDirs?: ReadonlySet<string>
}): React.ReactElement {
  const {
    projects, togglePinnedItem, updateProject, setProjectExpanded,
    snoozeTask, unsnoozeTask, markTaskUnread, markTaskVisited
  } = useApp()
  // Keeps the popup inside the window — a right-click near the bottom of the
  // sidebar would otherwise render items below the edge, unreachable.
  const tabStatusStore = useTabStatusStore()
  const landingActions = useTaskLandingActions()
  const [page, setPage] = useState<TaskMenuPage>('main')
  useEffect(() => { setPage('main') }, [contextMenu])
  const contextMenuPos = useMenuPosition<HTMLDivElement>(contextMenu)
  const snoozeMenuPos = useMenuPosition<HTMLDivElement>(contextMenu)
  const pageMenuPos = useMenuPosition<HTMLDivElement>(contextMenu)

  const project = contextMenu ? projects.find(p => p.id === contextMenu.projectId) : undefined

  const renderTaskPage = (): React.ReactElement | null => {
    if (!contextMenu || contextMenu.type !== 'task' || !project) return null
    const stream = findStreamOfTask(project, contextMenu.taskId)
    if (!stream) return null
    const back = <SubmenuBack label={findTask(project.id, contextMenu.taskId!)?.name ?? 'Back'} onClick={() => setPage('main')} />
    if (page === 'stream') {
      return (
        <>
          {back}
          <StreamMenuHeader project={project} streamId={stream.id} />
          <StreamMenuItems
            project={project}
            streamId={stream.id}
            onDone={closeContextMenu}
            newTaskLabel="New task here"
            onCloseStream={() => void handleCloseStream(project.id, stream.id)}
          />
        </>
      )
    }
    if (page === 'project') {
      return (
        <>
          {back}
          <ProjectMenuItems project={project} onDone={closeContextMenu} folderMissing={!!missingDirs?.has(project.id)} />
        </>
      )
    }
    return (
      <>
        {back}
        <MoveToStreamItems project={project} taskId={contextMenu.taskId!} onDone={closeContextMenu} />
      </>
    )
  }

  return (
    <>
      {contextMenu && snoozeSubmenu && contextMenu.type === 'task' && (
        <div ref={snoozeMenuPos.ref} className={`fixed z-(--z-menu) ${menuCls}`} style={snoozeMenuPos.style} onMouseDown={(e) => e.stopPropagation()}>
          {snoozePresets(Date.now()).map(preset => (
            <button
              key={preset.id}
              className={`${menuItemCls} flex items-center gap-6 justify-between`}
              onClick={() => {
                snoozeTask(contextMenu.projectId, contextMenu.taskId!, {
                  until: preset.until,
                  untilAttention: preset.untilAttention
                })
                closeContextMenu()
              }}
            >
              <span>{preset.label}</span>
              {preset.hint && <span className="text-text-subtle text-xs tabular-nums">{preset.hint}</span>}
            </button>
          ))}
        </div>
      )}

      {contextMenu && !snoozeSubmenu && page !== 'main' && (
        <div ref={pageMenuPos.ref} className={`fixed z-(--z-menu) min-w-[200px] ${menuCls}`} style={pageMenuPos.style} onMouseDown={(e) => e.stopPropagation()} data-testid={`task-menu-${page}`}>
          {renderTaskPage()}
        </div>
      )}

      {contextMenu && !snoozeSubmenu && page === 'main' && (
        <div ref={contextMenuPos.ref} className={`fixed z-(--z-menu) ${menuCls}`} style={contextMenuPos.style} onMouseDown={(e) => e.stopPropagation()}>
          {contextMenu.type === 'project' && project && (
            <ProjectMenuItems
              project={project}
              onDone={closeContextMenu}
              folderMissing={!!missingDirs?.has(project.id)}
              onRenameInline={() => beginEdit(project.id, project.name)}
            />
          )}
          {contextMenu.type === 'stream' && project && contextMenu.streamId && (
            <StreamMenuItems
              project={project}
              streamId={contextMenu.streamId}
              onDone={closeContextMenu}
              onRenameInline={() => {
                const stream = project.streams.find(s => s.id === contextMenu.streamId)
                beginEdit(contextMenu.streamId!, stream?.name ?? '', project.id)
              }}
              onCloseStream={() => void handleCloseStream(project.id, contextMenu.streamId!)}
            />
          )}
          {contextMenu.type === 'task' && renderTaskMain()}
        </div>
      )}
    </>
  )

  function renderTaskMain(): React.ReactElement | null {
    if (!contextMenu || contextMenu.type !== 'task') return null
    const taskId = contextMenu.taskId!
    const task = findTask(contextMenu.projectId, taskId)
    if (!task) return null
    const stream = findStreamOfTask(project, taskId)
    const snoozed = isSnoozed(task, Date.now())
    const landing = (() => {
      // A task with a worktree of its own lands into its stream; not while its agent works.
      const projectTask = findTaskInProject(project, taskId)
      if (!project || !projectTask || !stream || !canLandTask(project, projectTask)) return null
      const blocked = landingActionBlocker(projectTask, (tabId) => tabStatusStore.getStatus(tabId), !!getLandingOp(projectTask.id))
      const item = (label: string, run: () => Promise<void>) => (
        <button
          className={`${menuItemCls} flex items-center gap-6 justify-between disabled:opacity-50 disabled:cursor-default`}
          disabled={!!blocked}
          onClick={() => {
            closeContextMenu()
            void run()
          }}
        >
          <span>{label}</span>
          {blocked && <span className="text-text-subtle text-xs">{blocked}</span>}
        </button>
      )
      return (
        <div className="border-b border-hair pb-1 mb-1">
          {item(`Land into ${stream.name}`, () => landingActions.land(project, projectTask))}
          {item(`Update from ${stream.name}`, () => landingActions.update(project, projectTask))}
        </div>
      )
    })()
    // A "task in a directory" has no project you chose to have: no stream or project menu.
    const showPlaces = !!project && !!stream && !isEphemeralProject(project)
    const pinItem: PinnedItem = { type: 'task', projectId: contextMenu.projectId, streamId: stream?.id ?? '', taskId }
    const folder = revealFolder(projects, contextMenu.projectId, taskId)
    return (
      <>
        <div className="border-b border-hair pb-1 mb-1">
          {snoozed ? (
            <button className={menuItemCls} onClick={() => {
              unsnoozeTask(contextMenu.projectId, taskId)
              closeContextMenu()
            }}>Wake now</button>
          ) : (
            <button
              className={`${menuItemCls} flex items-center gap-6 justify-between`}
              onClick={() => setSnoozeSubmenu(true)}
            >
              <span>Snooze</span>
              <ChevronRight size={11} className="text-text-subtle" />
            </button>
          )}
          {isUnread(task) ? (
            <button className={menuItemCls} onClick={() => {
              markTaskVisited(contextMenu.projectId, taskId)
              closeContextMenu()
            }}>Mark read</button>
          ) : (
            <button className={menuItemCls} onClick={() => {
              markTaskUnread(contextMenu.projectId, taskId)
              closeContextMenu()
            }}>Mark unread</button>
          )}
        </div>
        {landing}
        {showPlaces && (
          <div className="border-b border-hair pb-1 mb-1">
            <SubmenuButton label="Stream" detail={stream!.name} onClick={() => setPage('stream')} testId="task-menu-open-stream" />
            <SubmenuButton label="Project" detail={project!.name} onClick={() => setPage('project')} testId="task-menu-open-project" />
            {project!.streams.length > 1 && (
              <SubmenuButton label="Move to stream" onClick={() => setPage('move')} testId="task-menu-open-move" />
            )}
          </div>
        )}
        <button className={menuItemCls} onClick={() => {
          beginEdit(taskId, task.name, contextMenu.projectId, stream?.id)
          closeContextMenu()
        }}>Rename</button>
        <button className={menuItemCls} onClick={() => {
          togglePinnedItem(pinItem)
          closeContextMenu()
        }}>{isPinned(pinItem) ? 'Unpin task' : 'Pin task'}</button>
        {/* Promote the hidden project a "task in a directory" is filed under:
            clearing the flag is all it takes for the tree to show it. */}
        {project && isEphemeralProject(project) && (
          <button className={menuItemCls} onClick={() => {
            updateProject(project.id, { ephemeral: undefined })
            setProjectExpanded(project.id, true)
            closeContextMenu()
          }}>Save as project</button>
        )}
        {folder && (
          <button className={menuItemCls} onClick={() => {
            closeContextMenu()
            window.api.revealInFolder(folder, undefined, contextMenu.projectId).catch((err: unknown) => {
              window.alert(`Couldn't open ${folder}: ${err instanceof Error ? err.message : String(err)}`)
            })
          }}>{revealInFolderLabel()}</button>
        )}
        <button className={`${menuItemCls} text-danger`} onClick={() => {
          closeContextMenu()
          void handleCloseTask(contextMenu.projectId, taskId)
        }}>Close task</button>
      </>
    )
  }
}
