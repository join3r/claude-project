export interface TaskDragItemLayout {
  id: string
  index: number
  top: number
  height: number
}

export function getTaskDropIndex(
  items: TaskDragItemLayout[],
  cursorY: number,
  draggedTaskId: string
): number {
  let bestIndex = 0

  for (const item of items) {
    if (item.id === draggedTaskId) continue
    if (cursorY > item.top + item.height / 2) {
      bestIndex = item.index + 1
    }
  }

  return bestIndex
}

export function getReorderInsertIndex(fromIndex: number, dropIndex: number): number | null {
  if (dropIndex === fromIndex || dropIndex === fromIndex + 1) {
    return null
  }

  return dropIndex > fromIndex ? dropIndex - 1 : dropIndex
}
