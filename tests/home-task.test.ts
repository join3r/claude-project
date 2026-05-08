import { describe, expect, it } from 'vitest'
import {
  createHomeTask,
  isHomeTab,
  isHomeTask,
  type Tab,
  type Task
} from '../src/shared/types'
import {
  DEFAULT_CONFIG,
  ensureHomeTasks,
  reconcileTaskViewState,
  resolveStoredSelection,
  type Project
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

describe('ensureHomeTasks migration', () => {
  it('injects a home task at index 0 when missing', () => {
    const projects: Project[] = [
      { id: 'p1', name: 'P1', directory: '/p1', tasks: [
        { id: 't1', name: 'T1', tabs: { left: [], right: [] }, activeTab: { left: null, right: null }, splitOpen: false, splitRatio: 0.5 }
      ]}
    ]
    const { projects: out, changed } = ensureHomeTasks(projects)
    expect(changed).toBe(true)
    expect(out[0].tasks[0].system).toBe('home')
    expect(out[0].tasks[1].id).toBe('t1')
  })

  it('is idempotent when projects already have home tasks', () => {
    const projects: Project[] = [
      { id: 'p1', name: 'P1', directory: '/p1', tasks: [] }
    ]
    const first = ensureHomeTasks(projects)
    const second = ensureHomeTasks(first.projects)
    expect(first.changed).toBe(true)
    expect(second.changed).toBe(false)
    expect(second.projects[0].tasks).toHaveLength(1)
  })

  it('reconcileTaskViewState injects the home tab into a home task that lost it', () => {
    const homeTask = {
      id: 'home-task-p1', name: 'Home',
      tabs: { left: [], right: [] },
      activeTab: { left: null, right: null },
      splitOpen: false, splitRatio: 0.5,
      system: 'home' as const
    }
    const state = reconcileTaskViewState(homeTask)
    // After reconcile the home tab is present and active
    expect(state.activeTab.left).toBeTruthy()
  })

  it('resolveStoredSelection defaults to the home task when no task remembered', () => {
    const projects: Project[] = [
      { id: 'p1', name: 'P1', directory: '/p1', tasks: [
        { id: 'home-task-p1', name: 'Home', tabs: { left: [{ id: 'home-tab-p1', type: 'home', title: 'Home', system: 'home' }], right: [] }, activeTab: { left: 'home-tab-p1', right: null }, splitOpen: false, splitRatio: 0.5, system: 'home' }
      ]}
    ]
    const result = resolveStoredSelection(projects, { ...DEFAULT_CONFIG, lastProjectId: 'p1', lastTaskId: null })
    expect(result.selectedProjectId).toBe('p1')
    expect(result.selectedTaskId).toBe('home-task-p1')
  })
})
