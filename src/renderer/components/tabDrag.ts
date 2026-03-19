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
  fromPane: 'left' | 'right'
  fromIndex: number
}

export interface TabDropTarget {
  pane: 'left' | 'right'
  index: number
}

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

export function getTabReorderInsertIndex(fromIndex: number, dropIndex: number): number | null {
  if (dropIndex === fromIndex || dropIndex === fromIndex + 1) {
    return null
  }

  return dropIndex > fromIndex ? dropIndex - 1 : dropIndex
}
