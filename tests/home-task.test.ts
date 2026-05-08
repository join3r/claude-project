import { describe, expect, it } from 'vitest'
import {
  createHomeTask,
  isHomeTab,
  isHomeTask,
  type Tab,
  type Task
} from '../src/shared/types'

describe('home task helpers', () => {
  it('createHomeTask returns a task with system="home" and a single home tab', () => {
    const { task, tab } = createHomeTask('project-1')
    expect(task.system).toBe('home')
    expect(task.tabs.left).toHaveLength(1)
    expect(task.tabs.right).toHaveLength(0)
    expect(task.tabs.left[0]).toBe(tab)
    expect(tab.system).toBe('home')
    expect(tab.type).toBe('home')
    expect(task.activeTab.left).toBe(tab.id)
    expect(task.activeTab.right).toBeNull()
  })

  it('isHomeTask returns true only when system flag is set', () => {
    const { task } = createHomeTask('p')
    expect(isHomeTask(task)).toBe(true)
    const regular: Task = {
      id: 't', name: 'Regular',
      tabs: { left: [], right: [] },
      activeTab: { left: null, right: null },
      splitOpen: false, splitRatio: 0.5
    }
    expect(isHomeTask(regular)).toBe(false)
  })

  it('isHomeTab returns true only when system flag is set', () => {
    const { tab } = createHomeTask('p')
    expect(isHomeTab(tab)).toBe(true)
    const regular: Tab = { id: 'x', type: 'terminal', title: 'Terminal' }
    expect(isHomeTab(regular)).toBe(false)
  })
})
