import { describe, expect, it } from 'vitest'
import { getReorderInsertIndex, getTaskDropIndex } from '../src/renderer/components/sidebarDrag'

describe('sidebar drag helpers', () => {
  const items = [
    { id: 'task-a', index: 0, top: 0, height: 20 },
    { id: 'task-b', index: 1, top: 20, height: 20 },
    { id: 'task-c', index: 2, top: 40, height: 20 }
  ]

  it('ignores the dragged task when calculating task drop positions', () => {
    expect(getTaskDropIndex(items, 25, 'task-c')).toBe(1)
    expect(getTaskDropIndex(items, 55, 'task-b')).toBe(3)
  })

  it('treats drops in the current slot as no-op reorders', () => {
    expect(getTaskDropIndex(items, 25, 'task-b')).toBe(1)
    expect(getReorderInsertIndex(1, 1)).toBeNull()
    expect(getReorderInsertIndex(1, 2)).toBeNull()
  })

  it('computes the final insert index for adjacent moves', () => {
    expect(getReorderInsertIndex(2, 1)).toBe(1)
    expect(getReorderInsertIndex(1, 3)).toBe(2)
  })
})
