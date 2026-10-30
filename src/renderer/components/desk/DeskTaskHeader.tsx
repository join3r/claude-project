import React, { useEffect, useMemo, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { useApp } from '../../context/AppContext'
import type { Project, Task } from '../../../shared/types'
import { formatLineCount, useTaskDiffSummaries } from '../../hooks/useTaskDiffSummaries'
import { canLandTask, useLandingOp } from '../../taskLanding'
import { useTaskLandingActions } from '../useTaskLandingActions'
import { findStreamOfTask } from '../../../shared/streams'
import { autopilotActive, autopilotLine } from '../../../shared/autopilot'
import { useMenuPosition, type MenuAnchor } from '../../hooks/useMenuPosition'
import { useCloseTask } from '../sidebar/useCloseTask'
import { isSnoozed } from '../inbox'
import { useDeskDone } from './useDeskDone'
import DeskSnoozeMenu, { type DeskSnoozeRequest } from './DeskSnoozeMenu'
import { openBench } from './benchState'

const ghostCls = 'shrink-0 h-[26px] px-2.5 rounded-[7px] border border-border-strong bg-transparent text-sm text-text cursor-pointer hover:bg-sel [-webkit-app-region:no-drag] transition-colors duration-(--motion-fast)'

/**
 * Left of the task menu in the desk's task header: a quiet "N files changed"
 * that opens Changes in the Bench (the one way, besides a status-bar run, the
 * Bench opens by itself), and Snooze (Wake while snoozed).
 */
export function DeskTaskTools({ project, task }: { project: Project; task: Task }): React.ReactElement {
  const { snoozeTask, unsnoozeTask, endAutopilot } = useApp()
  const sources = useMemo(() => [{ project, task }], [project, task])
  const diff = useTaskDiffSummaries(sources).get(task.id)
  const [snoozeAt, setSnoozeAt] = useState<DeskSnoozeRequest | null>(null)
  const files = diff?.files ?? 0
  const snoozed = isSnoozed(task, Date.now())

  return (
    <>
      {autopilotActive(task) && (
        <span
          className="shrink-0 mr-1.5 flex items-center gap-1 h-[22px] pl-2 pr-1 rounded-full border border-border text-xs text-text-muted"
          title={autopilotLine(task.autopilot) ?? 'Autopilot: lands the task and moves it to Done when Claude is finished'}
          data-testid="desk-task-autopilot"
        >
          {autopilotLine(task.autopilot) ?? 'Autopilot'}
          <button
            type="button"
            className="w-[16px] h-[16px] flex items-center justify-center rounded-full border-0 bg-transparent text-text-muted cursor-pointer hover:bg-border hover:text-text [-webkit-app-region:no-drag]"
            aria-label="Turn Autopilot off"
            title="Turn Autopilot off: the task stays as it is, and is yours"
            onClick={() => endAutopilot(project.id, task.id)}
            data-testid="desk-task-autopilot-off"
          >×</button>
        </span>
      )}
      {files > 0 && (
        <button
          type="button"
          className="shrink-0 mr-1.5 bg-transparent border-0 p-0 font-mono text-xs text-info cursor-pointer hover:underline [-webkit-app-region:no-drag]"
          title={`${diff?.added ?? 0} lines added, ${diff?.deleted ?? 0} removed. Opens Changes in the Bench.`}
          onClick={() => openBench(task.id, 'changes')}
          data-testid="desk-files-changed"
        >
          {files === 1 ? '1 file' : `${files} files`}
          {' '}<span className="text-running">+{formatLineCount(diff?.added ?? 0)}</span>
          {' '}<span className="text-crashed">−{formatLineCount(diff?.deleted ?? 0)}</span>
        </button>
      )}
      {snoozed ? (
        <button type="button" className={ghostCls} onClick={() => unsnoozeTask(project.id, task.id)} title="Back to the Inbox now">Wake</button>
      ) : (
        <button
          type="button"
          className={ghostCls}
          aria-haspopup="menu"
          aria-expanded={snoozeAt !== null}
          onClick={(e) => {
            const rect = e.currentTarget.getBoundingClientRect()
            setSnoozeAt({ x: rect.left, y: rect.bottom + 4, projectId: project.id, taskId: task.id })
          }}
        >
          Snooze
        </button>
      )}
      <DeskSnoozeMenu
        request={snoozeAt}
        onSnooze={(projectId, taskId, options) => snoozeTask(projectId, taskId, options)}
        onClose={() => setSnoozeAt(null)}
      />
    </>
  )
}

/**
 * The header's ✓ Done, the one light button on the screen: lands the task and
 * closes it, like Done on its inbox row (`useDeskDone`). A task with a worktree
 * of its own also gets Done's ▾ (decision 4 of the redesign): Land and keep
 * working · Update from stream · Close and keep branch · Discard.
 */
export function DeskDoneButton({ project, task }: { project: Project; task: Task }): React.ReactElement {
  const closeTaskFlow = useCloseTask()
  const done = useDeskDone(closeTaskFlow.closeTask)
  const landingActions = useTaskLandingActions()
  const landingOp = useLandingOp(task.id)
  const landing = !!landingOp || task.landing?.state === 'landing' || task.landing?.state === 'fixing'
  const [menu, setMenu] = useState<MenuAnchor | null>(null)
  const lands = canLandTask(project, task)
  const stream = findStreamOfTask(project, task.id)
  const fill = 'h-[26px] border-0 bg-accent text-accent-ink text-sm font-semibold cursor-pointer hover:brightness-110 disabled:opacity-50 disabled:cursor-default [-webkit-app-region:no-drag]'

  return (
    <>
      <span className="shrink-0 ml-1 flex">
        <button
          type="button"
          className={`${fill} px-3 ${lands ? 'rounded-l-[7px]' : 'rounded-[7px]'}`}
          disabled={landing}
          title="Land the task into its stream and close it (E on its inbox row)"
          onClick={() => { void done(project.id, task.id) }}
          data-testid="desk-task-done"
        >
          {landing ? 'Landing…' : '✓ Done'}
        </button>
        {lands && (
          <button
            type="button"
            className={`${fill} px-1.5 rounded-r-[7px] border-l border-l-[rgba(0,0,0,0.18)]`}
            disabled={landing}
            aria-label="More ways to finish"
            aria-haspopup="menu"
            aria-expanded={menu !== null}
            onClick={(e) => {
              const rect = e.currentTarget.getBoundingClientRect()
              setMenu({ x: rect.right - 240, y: rect.bottom + 4 })
            }}
            data-testid="desk-task-done-more"
          >
            <ChevronDown size={13} />
          </button>
        )}
      </span>
      <DoneMenu
        anchor={menu}
        streamName={stream?.name ?? 'the stream'}
        onClose={() => setMenu(null)}
        onPick={(choice) => {
          setMenu(null)
          if (choice === 'land') void landingActions.land(project, task)
          else if (choice === 'update') void landingActions.update(project, task)
          else if (choice === 'keep') void done(project.id, task.id, 'keep')
          else if (window.confirm(`Discard "${task.name}"? Its worktree and branch go, with every change not landed.`)) {
            void done(project.id, task.id, 'discard')
          }
        }}
      />
      {closeTaskFlow.dialog}
    </>
  )
}

type DoneChoice = 'land' | 'update' | 'keep' | 'discard'

function DoneMenu({ anchor, streamName, onPick, onClose }: {
  anchor: MenuAnchor | null
  streamName: string
  onPick: (choice: DoneChoice) => void
  onClose: () => void
}): React.ReactElement | null {
  const pos = useMenuPosition<HTMLDivElement>(anchor)
  useEffect(() => {
    if (!anchor) return
    const dismiss = (): void => onClose()
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') onClose() }
    window.addEventListener('mousedown', dismiss)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', dismiss)
      window.removeEventListener('keydown', onKey)
    }
  }, [anchor, onClose])
  if (!anchor) return null
  const items: { id: DoneChoice; label: string; hint: string; danger?: boolean }[] = [
    { id: 'land', label: 'Land and keep working', hint: `Into ${streamName}; the task stays open` },
    { id: 'update', label: 'Update from stream', hint: `Take in what ${streamName} gained` },
    { id: 'keep', label: 'Close and keep branch', hint: 'Nothing lands; the branch stays' },
    { id: 'discard', label: 'Discard…', hint: 'Worktree and branch go', danger: true }
  ]
  return (
    <div
      ref={pos.ref}
      role="menu"
      aria-label="Done"
      className="fixed z-(--z-menu) w-[240px] bg-surface-3 border border-border-strong rounded-[10px] p-1 shadow-[0_18px_40px_rgba(0,0,0,0.5)]"
      style={pos.style}
      onMouseDown={(e) => e.stopPropagation()}
      data-testid="desk-done-menu"
    >
      {items.map(item => (
        <button
          key={item.id}
          type="button"
          role="menuitem"
          className="flex w-full flex-col gap-px px-2.5 py-1.5 rounded-md bg-transparent border-0 cursor-pointer hover:bg-sel text-left"
          onClick={() => onPick(item.id)}
        >
          <span className={`text-base ${item.danger ? 'text-crashed' : 'text-text'}`}>{item.label}</span>
          <span className="text-xs text-text-muted">{item.hint}</span>
        </button>
      ))}
    </div>
  )
}
