import React from 'react'
import { ChevronRight } from 'lucide-react'
import { useApp } from '../../context/AppContext'
import { isEphemeralProject, isRemoteProject, isShellCommandProject } from '../../../shared/types'
import type { PinnedItem, Project, Task } from '../../../shared/types'
import { useMenuPosition } from '../../hooks/useMenuPosition'
import { isSettled, isSnoozed, isUnread, snoozePresets } from '../inbox'
import { menuCls, menuItemCls } from '../ui'
import { revealInFolderLabel } from '../../utils/revealLabel'
import { joinWorkspaceDir } from '../../../shared/workspace-path'
import type { SidebarContextMenuState } from './SidebarParts'
import { findStreamOfTask, findTaskInProject, projectTasks, taskWorkspace } from '../../../shared/streams'

/**
 * The local folder a project, stream or task works in, for "Reveal in Finder":
 * the stream's worktree when it has one, else the project directory. Remote and
 * shell-command projects have none on this machine.
 */
export function revealFolder(
  projects: readonly Project[],
  projectId: string,
  taskId?: string,
  streamId?: string
): string | null {
  const project = projects.find(p => p.id === projectId)
  if (!project || isRemoteProject(project) || isShellCommandProject(project)) return null
  const workspace = taskId
    ? taskWorkspace(project, taskId)
    : streamId ? project.streams.find(stream => stream.id === streamId)?.workspace : undefined
  if (workspace?.worktreePath) return joinWorkspaceDir(workspace.worktreePath, workspace.relativeProjectPath)
  return project.directory || null
}

/** The confirmation for deleting a project, naming what goes with it. */
export function projectDeletePrompt(project: Project): string {
  const tasks = projectTasks(project).length
  const workspaces = project.streams.filter(s => s.workspace).length
  const lines = [`Delete project "${project.name}"?`]
  if (tasks > 0) lines.push(`${tasks === 1 ? 'Its task closes' : `Its ${tasks} tasks close`}, with their tabs.`)
  if (workspaces > 0) lines.push(`${workspaces === 1 ? 'Its workspace worktree is' : `Its ${workspaces} workspace worktrees are`} removed from disk, even with uncommitted changes.`)
  if (!isRemoteProject(project) && !isShellCommandProject(project)) lines.push('The project folder itself is not touched.')
  return lines.join('\n\n')
}

/**
 * The right-click menu for a project or task row, and the snooze presets that
 * replace its body rather than fly out sideways — a nested flyout would run off
 * the edge of a 240px sidebar.
 */
export default function SidebarContextMenu({
  contextMenu,
  snoozeSubmenu,
  setSnoozeSubmenu,
  closeContextMenu,
  setContextMenu,
  findTask,
  handleToggleSettled,
  handleDeleteTask,
  handleDeleteStream,
  beginEdit,
  isPinned,
  setDuplicateProjectId,
  setProjectSettingsId,
  onAddTask,
  onAddWorkspace
}: {
  contextMenu: SidebarContextMenuState | null
  snoozeSubmenu: boolean
  setSnoozeSubmenu: (open: boolean) => void
  /** Closes the menu and resets the snooze page. */
  closeContextMenu: () => void
  setContextMenu: (menu: null) => void
  findTask: (projectId: string, taskId: string) => Task | undefined
  handleToggleSettled: (projectId: string, taskId: string) => void
  handleDeleteTask: (projectId: string, taskId: string) => void
  handleDeleteStream: (projectId: string, streamId: string) => void
  /** Rename inline; `streamId` opens that stream so the row is on screen. */
  beginEdit: (id: string, name: string, projectId?: string, streamId?: string) => void
  isPinned: (item: PinnedItem) => boolean
  setDuplicateProjectId: (projectId: string) => void
  setProjectSettingsId: (projectId: string) => void
  onAddTask: (projectId: string) => void
  onAddWorkspace: (projectId: string) => void
}): React.ReactElement {
  const {
    projects, togglePinnedItem, updateProject, setProjectExpanded, connectSsh, removeProject,
    snoozeTask, unsnoozeTask, markTaskUnread, markTaskVisited
  } = useApp()
  // Keeps the popup inside the window — a right-click near the bottom of the
  // sidebar would otherwise render items below the edge, unreachable.
  const contextMenuPos = useMenuPosition<HTMLDivElement>(contextMenu)
  const snoozeMenuPos = useMenuPosition<HTMLDivElement>(contextMenu)

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

      {contextMenu && !snoozeSubmenu && (
        <div ref={contextMenuPos.ref} className={`fixed z-(--z-menu) ${menuCls}`} style={contextMenuPos.style} onMouseDown={(e) => e.stopPropagation()}>
          <>
            {contextMenu.type === 'project' && (() => {
              const project = projects.find(p => p.id === contextMenu.projectId)
              if (!project) return null
              return (
                <div className="border-b border-hair pb-1 mb-1">
                  <button className={menuItemCls} onClick={() => {
                    onAddTask(project.id)
                    closeContextMenu()
                  }}>New task</button>
                  {!isShellCommandProject(project) && (
                    <button className={menuItemCls} onClick={() => {
                      onAddWorkspace(project.id)
                      closeContextMenu()
                    }}>New workspace</button>
                  )}
                </div>
              )
            })()}
            {contextMenu.type === 'task' && (() => {
              const task = findTask(contextMenu.projectId, contextMenu.taskId!)
              if (!task) return null
              const settled = isSettled(task)
              const snoozed = isSnoozed(task, Date.now())
              return (
                <div className="border-b border-hair pb-1 mb-1">
                  <button className={menuItemCls} onClick={() => {
                    handleToggleSettled(contextMenu.projectId, contextMenu.taskId!)
                    closeContextMenu()
                  }}>{settled ? 'Unsettle' : 'Settle'}</button>
                  {snoozed ? (
                    <button className={menuItemCls} onClick={() => {
                      unsnoozeTask(contextMenu.projectId, contextMenu.taskId!)
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
                      markTaskVisited(contextMenu.projectId, contextMenu.taskId!)
                      closeContextMenu()
                    }}>Mark read</button>
                  ) : (
                    <button className={menuItemCls} onClick={() => {
                      markTaskUnread(contextMenu.projectId, contextMenu.taskId!)
                      closeContextMenu()
                    }}>Mark unread</button>
                  )}
                </div>
              )
            })()}
            <button className={menuItemCls} onClick={() => {
                const project = projects.find((p) => p.id === contextMenu.projectId)
                if (contextMenu.type === 'project') {
                  beginEdit(contextMenu.projectId, project?.name ?? '')
                } else if (contextMenu.type === 'stream') {
                  const stream = project?.streams.find(s => s.id === contextMenu.streamId)
                  beginEdit(contextMenu.streamId!, stream?.name ?? '', contextMenu.projectId)
                } else {
                  const task = findTaskInProject(project, contextMenu.taskId)
                  const stream = findStreamOfTask(project, contextMenu.taskId)
                  beginEdit(contextMenu.taskId!, task?.name ?? '', contextMenu.projectId, stream?.id)
                }
                setContextMenu(null)
              }}>Rename</button>
              {(() => {
                const project = projects.find(p => p.id === contextMenu.projectId)
                let item: PinnedItem
                if (contextMenu.type === 'project') {
                  item = { type: 'project', projectId: contextMenu.projectId }
                } else if (contextMenu.type === 'stream') {
                  item = { type: 'stream', projectId: contextMenu.projectId, streamId: contextMenu.streamId! }
                } else {
                  const streamId = findStreamOfTask(project, contextMenu.taskId)?.id ?? ''
                  item = { type: 'task', projectId: contextMenu.projectId, streamId, taskId: contextMenu.taskId! }
                }
                const pinned = isPinned(item)
                return (
                  <button className={menuItemCls} onClick={() => {
                    togglePinnedItem(item)
                    setContextMenu(null)
                  }}>{pinned ? `Unpin ${contextMenu.type}` : `Pin ${contextMenu.type}`}</button>
                )
              })()}
              {/* Promote the hidden project a "task in a directory" is filed under:
                  clearing the flag is all it takes for the tree to show it. */}
              {contextMenu.type === 'task' && (() => {
                const project = projects.find(p => p.id === contextMenu.projectId)
                if (!project || !isEphemeralProject(project)) return null
                return (
                  <button className={menuItemCls} onClick={() => {
                    updateProject(project.id, { ephemeral: undefined })
                    setProjectExpanded(project.id, true)
                    setContextMenu(null)
                  }}>Save as project</button>
                )
              })()}
              {contextMenu.type === 'project' && (
                <button className={menuItemCls} onClick={() => {
                  setDuplicateProjectId(contextMenu.projectId)
                  setContextMenu(null)
                }}>Duplicate</button>
              )}
              {contextMenu.type === 'project' && (
                <button className={menuItemCls} onClick={() => {
                  setProjectSettingsId(contextMenu.projectId)
                  setContextMenu(null)
                }}>Settings</button>
              )}
              {contextMenu.type === 'project' && (() => {
                const project = projects.find(p => p.id === contextMenu.projectId)
                if (!project || !isRemoteProject(project)) return null
                return (
                  <button className={menuItemCls} onClick={() => {
                    connectSsh(project.id, project.ssh!).catch(() => {})
                    setContextMenu(null)
                  }}>Reconnect SSH</button>
                )
              })()}
              {(() => {
                const folder = revealFolder(projects, contextMenu.projectId, contextMenu.taskId, contextMenu.streamId)
                if (!folder) return null
                return (
                  <button className={menuItemCls} onClick={() => {
                    setContextMenu(null)
                    window.api.revealInFolder(folder).catch((err: unknown) => {
                      window.alert(`Couldn't open ${folder}: ${err instanceof Error ? err.message : String(err)}`)
                    })
                  }}>{revealInFolderLabel()}</button>
                )
              })()}
              {/* `main` can't be removed, only emptied. */}
              {!(contextMenu.type === 'stream' && projects.find(p => p.id === contextMenu.projectId)
                ?.streams.find(s => s.id === contextMenu.streamId)?.isMain) && (
              <button className={`${menuItemCls} text-danger`} onClick={() => {
                setContextMenu(null)
                if (contextMenu.type === 'task') {
                  void handleDeleteTask(contextMenu.projectId, contextMenu.taskId!)
                  return
                }
                if (contextMenu.type === 'stream') {
                  void handleDeleteStream(contextMenu.projectId, contextMenu.streamId!)
                  return
                }
                const project = projects.find(p => p.id === contextMenu.projectId)
                if (!project) return
                if (!window.confirm(projectDeletePrompt(project))) return
                void removeProject(project.id)
              }}>Delete…</button>
              )}
              {contextMenu.type === 'project' && (() => {
                const project = projects.find(p => p.id === contextMenu.projectId)
                if (!project) return null
                const details: { label: string; value: string }[] = []
                if (isShellCommandProject(project)) {
                  details.push({ label: 'Command', value: project.shellCommand!.command })
                } else if (isRemoteProject(project)) {
                  details.push({ label: 'Connection', value: `${project.ssh!.username}@${project.ssh!.host}:${project.ssh!.port}` })
                  details.push({ label: 'Dir', value: project.ssh!.remoteDir || '(remote home)' })
                } else {
                  details.push({ label: 'Dir', value: project.directory })
                }
                return (
                  <div className="border-t border-hair mt-1 px-2.5 pt-1.5 pb-1">
                    {details.map(d => (
                      <div key={d.label} className="text-text-subtle text-xs leading-snug overflow-hidden text-ellipsis whitespace-nowrap max-w-[260px] select-text cursor-text" title={d.value}>
                        <span className="opacity-70">{d.label}:</span> {d.value}
                      </div>
                    ))}
                  </div>
                )
              })()}
          </>
        </div>
      )}
    </>
  )
}
