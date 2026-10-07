/**
 * Mouse-driven drag-and-drop for the sidebar: reordering projects, moving tasks
 * within and between a project's streams, and reordering the pinned list. Plain mousedown/mousemove rather
 * than HTML5 DnD so a click that never passes the threshold stays a click.
 */
import React, { useState, useRef, useEffect, useCallback } from 'react'
import type { PinnedItem } from '../../../shared/types'
import { getReorderInsertIndex, getTaskDropIndex } from '../sidebarDrag'
import type { DragState, DropTarget } from './SidebarParts'
import { resolveTaskMove, taskDropSlot, type TreeRowLayout } from './streamTree'

const DRAG_THRESHOLD = 5

export function useSidebarTreeDrag({
  editingId,
  projectOrder,
  treeProjectIds,
  moveTask,
  reorderProjects
}: {
  /** No drag starts while a row is being renamed. */
  editingId: string | null
  projectOrder: string[]
  /** The project ids the tree actually shows, in order. */
  treeProjectIds: string[]
  /** A task dropped somewhere else: `toIndex` counts the target stream without the task. */
  moveTask: (projectId: string, taskId: string, toStreamId: string, toIndex: number) => void
  reorderProjects: (fromIndex: number, toIndex: number) => void
}): {
  dragState: DragState | null
  dropTarget: DropTarget
  handleDragMouseDown: (
    e: React.MouseEvent, type: 'project' | 'task', id: string, index: number, projectId?: string, streamId?: string
  ) => void
} {
  const [dragState, setDragState] = useState<DragState | null>(null)
  const dragStateRef = useRef<DragState | null>(null)
  const [dropTarget, setDropTarget] = useState<DropTarget>(null)
  const dropTargetRef = useRef<DropTarget>(null)

  useEffect(() => {
    dragStateRef.current = dragState
  }, [dragState])

  useEffect(() => {
    dropTargetRef.current = dropTarget
  }, [dropTarget])

  const handleDragMouseDown = useCallback((
    e: React.MouseEvent,
    type: 'project' | 'task',
    id: string,
    index: number,
    projectId?: string,
    streamId?: string
  ) => {
    if (e.button !== 0 || editingId) return
    const startY = e.clientY
    const startX = e.clientX
    let dragging = false

    const onMouseMove = (ev: MouseEvent) => {
      if (!dragging) {
        if (Math.abs(ev.clientY - startY) + Math.abs(ev.clientX - startX) < DRAG_THRESHOLD) return
        dragging = true
        const nextDragState: DragState = { type, id, index, projectId, streamId }
        dragStateRef.current = nextDragState
        setDragState(nextDragState)
      }

      const sidebarList = document.querySelector('.sidebar-list')
      if (!sidebarList) return

      if (type === 'task' && projectId) {
        // Every stream and task row of this project, in screen order; a task
        // stays in its project.
        const rows = sidebarList.querySelectorAll<HTMLElement>(
          `.sidebar-project[data-project-id="${projectId}"] [data-tree-row]`
        )
        const slot = taskDropSlot(
          Array.from(rows).map((row): TreeRowLayout => {
            const rect = row.getBoundingClientRect()
            return {
              kind: row.dataset.treeRow === 'stream' ? 'stream' : 'task',
              streamId: row.dataset.streamId ?? '',
              index: Number(row.dataset.taskIndex ?? '-1'),
              taskCount: Number(row.dataset.taskCount ?? '0'),
              top: rect.top,
              height: rect.height
            }
          }),
          ev.clientY
        )
        const nextDropTarget: DropTarget = slot ? { type: 'task-slot', projectId, ...slot } : null
        dropTargetRef.current = nextDropTarget
        setDropTarget(nextDropTarget)
        return
      }

      const projectItems = sidebarList.querySelectorAll<HTMLElement>('[data-drag-type="project"]')
      let newTarget: DropTarget = null

      for (let i = 0; i < projectItems.length; i++) {
        const item = projectItems[i]
        const rect = item.getBoundingClientRect()
        if (ev.clientY < rect.top || ev.clientY > rect.bottom) continue

        const itemId = item.dataset.dragId!
        const listIdx = treeProjectIds.indexOf(itemId)
        if (listIdx < 0) break
        const midY = rect.top + rect.height / 2
        const insertIdx = ev.clientY > midY ? listIdx + 1 : listIdx
        newTarget = { type: 'between-projects', index: insertIdx }
        break
      }

      if (!newTarget) {
        newTarget = { type: 'between-projects', index: treeProjectIds.length }
      }

      dropTargetRef.current = newTarget
      setDropTarget(newTarget)
    }

    const onMouseUp = () => {
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
      document.body.style.cursor = ''

      if (!dragging) return

      const currentDragState = dragStateRef.current
      const currentDropTarget = dropTargetRef.current

      if (currentDragState && currentDropTarget) {
        if (
          currentDragState.type === 'task' && currentDragState.projectId && currentDragState.streamId
          && currentDropTarget.type === 'task-slot'
        ) {
          const move = resolveTaskMove(
            { streamId: currentDragState.streamId, index: currentDragState.index },
            currentDropTarget
          )
          if (move) moveTask(currentDragState.projectId, currentDragState.id, move.toStreamId, move.toIndex)
        } else if (currentDragState.type === 'project' && currentDropTarget.type === 'between-projects') {
          const fromIdx = projectOrder.indexOf(currentDragState.id)
          const orderDropIndex = currentDropTarget.index >= treeProjectIds.length
            ? projectOrder.length
            : projectOrder.indexOf(treeProjectIds[currentDropTarget.index] ?? '')
          if (orderDropIndex >= 0) {
            const toIdx = getReorderInsertIndex(fromIdx, orderDropIndex)
            if (toIdx !== null) {
              reorderProjects(fromIdx, toIdx)
            }
          }
        }
      }

      dragStateRef.current = null
      dropTargetRef.current = null
      setDragState(null)
      setDropTarget(null)
    }

    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
  }, [editingId, projectOrder, treeProjectIds, moveTask, reorderProjects])

  return { dragState, dropTarget, handleDragMouseDown }
}

export function usePinnedDrag<P extends { item: PinnedItem }>(
  resolvedPins: P[],
  setPinnedOrder: (items: PinnedItem[]) => void
): {
  pinDragIndex: number | null
  pinDropIndex: number | null
  handlePinMouseDown: (e: React.MouseEvent, key: string, index: number) => void
} {
  const [pinDragIndex, setPinDragIndex] = useState<number | null>(null)
  const [pinDropIndex, setPinDropIndex] = useState<number | null>(null)
  const pinDropIndexRef = useRef<number | null>(null)

  const handlePinMouseDown = useCallback((e: React.MouseEvent, key: string, index: number) => {
    if (e.button !== 0) return
    const startY = e.clientY
    const startX = e.clientX
    let dragging = false

    const onMouseMove = (ev: MouseEvent) => {
      if (!dragging) {
        if (Math.abs(ev.clientY - startY) + Math.abs(ev.clientX - startX) < DRAG_THRESHOLD) return
        dragging = true
        setPinDragIndex(index)
      }
      const list = document.querySelector('.sidebar-pinned-list')
      if (!list) return
      const items = list.querySelectorAll<HTMLElement>('[data-pin-key]')
      const bestIndex = getTaskDropIndex(
        Array.from(items).map((item) => {
          const rect = item.getBoundingClientRect()
          return {
            id: item.dataset.pinKey ?? '',
            index: Number(item.dataset.pinIndex ?? '-1'),
            top: rect.top,
            height: rect.height
          }
        }),
        ev.clientY,
        key
      )
      pinDropIndexRef.current = bestIndex
      setPinDropIndex(bestIndex)
    }

    const onMouseUp = () => {
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
      if (dragging) {
        const dropIndex = pinDropIndexRef.current
        if (dropIndex !== null) {
          const toIndex = getReorderInsertIndex(index, dropIndex)
          if (toIndex !== null) {
            const next = resolvedPins.map(pin => pin.item)
            const [moved] = next.splice(index, 1)
            next.splice(toIndex, 0, moved)
            setPinnedOrder(next)
          }
        }
      }
      pinDropIndexRef.current = null
      setPinDragIndex(null)
      setPinDropIndex(null)
    }

    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
  }, [resolvedPins, setPinnedOrder])

  return { pinDragIndex, pinDropIndex, handlePinMouseDown }
}
