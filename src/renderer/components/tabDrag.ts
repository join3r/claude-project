import type { PaneDropTarget } from '../../shared/panes'

export interface TabDragItemLayout {
  id: string
  index: number
  left: number
  width: number
}

export interface TabDragState {
  projectId: string
  taskId: string
  tabId: string
  fromPane: number
  fromIndex: number
}

/** Where a dragged tab would land, plus whether the pointer is over a pane's body (not its tab bar). */
export type TabDropTarget = PaneDropTarget & { inBody?: boolean }

/** How far into a pane's body, from its left or right edge, a drop splits it (share of its width, capped in px). */
const SPLIT_EDGE_SHARE = 0.25
const SPLIT_EDGE_MAX_PX = 160

export function getTabDropIndex(
  items: TabDragItemLayout[],
  cursorX: number,
  draggedTabId: string
): number {
  let bestIndex = 0

  for (const item of items) {
    if (item.id === draggedTabId) continue
    if (cursorX > item.left + item.width / 2) {
      bestIndex = item.index + 1
    }
  }

  return bestIndex
}

/**
 * A drop over a pane body at `cursorX`: near the left or right edge splits the
 * pane on that side, anywhere else adds the tab at the end of the pane.
 */
export function getBodyDropTarget(
  pane: number,
  rect: { left: number; width: number },
  cursorX: number,
  tabCount: number
): TabDropTarget {
  const edge = Math.min(rect.width * SPLIT_EDGE_SHARE, SPLIT_EDGE_MAX_PX)
  if (cursorX < rect.left + edge) return { kind: 'split', pane, side: 'left', inBody: true }
  if (cursorX > rect.left + rect.width - edge) return { kind: 'split', pane, side: 'right', inBody: true }
  return { kind: 'tab', pane, index: tabCount, inBody: true }
}

function paneIndexOf(element: HTMLElement): number | null {
  const index = Number(element.dataset.paneIndex)
  return Number.isInteger(index) && index >= 0 ? index : null
}

function contains(rect: DOMRect, x: number, y: number): boolean {
  return rect.width > 0 && rect.height > 0 && x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom
}

/** The drop target under the pointer, read off the task's rendered tab bars and pane bodies. */
export function resolveTabDropTarget(
  projectId: string,
  taskId: string,
  cursorX: number,
  cursorY: number,
  draggedTabId: string
): TabDropTarget | null {
  const scope = `[data-project-id="${projectId}"][data-task-id="${taskId}"]`

  for (const tabList of document.querySelectorAll<HTMLElement>(`.tab-list${scope}`)) {
    const pane = paneIndexOf(tabList)
    if (pane === null || !contains(tabList.getBoundingClientRect(), cursorX, cursorY)) continue
    const items = Array.from(tabList.querySelectorAll<HTMLElement>('.tab')).map((item) => {
      const itemRect = item.getBoundingClientRect()
      return {
        id: item.dataset.tabId ?? '',
        index: Number(item.dataset.tabIndex ?? '-1'),
        left: itemRect.left,
        width: itemRect.width
      }
    })
    return { kind: 'tab', pane, index: getTabDropIndex(items, cursorX, draggedTabId) }
  }

  for (const body of document.querySelectorAll<HTMLElement>(`.pane-slot${scope}`)) {
    const pane = paneIndexOf(body)
    const rect = body.getBoundingClientRect()
    if (pane === null || !contains(rect, cursorX, cursorY)) continue
    return getBodyDropTarget(pane, rect, cursorX, Number(body.dataset.tabCount ?? '0'))
  }

  return null
}
