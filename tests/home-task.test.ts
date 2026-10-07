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
import { findMainStream, paneTabs, projectTasks } from '../src/shared/streams'
import { fixtureProject } from './helpers/streams-fixtures'

describe('home task helpers', () => {
  it('createHomeTask returns a task with system="home" and a single home tab', () => {
    const { task, tab } = createHomeTask('project-1')
    expect(task.system).toBe('home')
    expect(task.panes).toHaveLength(1)
    expect(paneTabs(task, 'left')).toHaveLength(1)
    expect(paneTabs(task, 'right')).toHaveLength(0)
    expect(paneTabs(task, 'left')[0]).toBe(tab)
    expect(tab.system).toBe('home')
    expect(tab.type).toBe('home')
    expect(task.panes[0].activeTabId).toBe(tab.id)
  })

  it('isHomeTask returns true only when system flag is set', () => {
    const { task } = createHomeTask('p')
    expect(isHomeTask(task)).toBe(true)
    const regular: Task = { id: 't', name: 'Regular', panes: [] }
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
  it('injects a home task at the front of main when missing', () => {
    const projects: Project[] = [fixtureProject({ id: 'p1', tasks: [{ id: 't1' }] })]
    const { projects: out, changed } = ensureHomeTasks(projects)
    expect(changed).toBe(true)
    const main = findMainStream(out[0])!
    expect(main.tasks[0].system).toBe('home')
    expect(main.tasks[1].id).toBe('t1')
  })

  it('creates the main stream for the home task when a project has none', () => {
    const projects: Project[] = [{ id: 'p1', name: 'P1', directory: '/p1', streams: [] }]
    const { projects: out } = ensureHomeTasks(projects)
    expect(out[0].streams).toHaveLength(1)
    expect(out[0].streams[0].isMain).toBe(true)
    expect(out[0].streams[0].tasks[0].system).toBe('home')
  })

  it('is idempotent when projects already have home tasks', () => {
    const projects: Project[] = [fixtureProject({ id: 'p1' })]
    const first = ensureHomeTasks(projects)
    const second = ensureHomeTasks(first.projects)
    expect(first.changed).toBe(true)
    expect(second.changed).toBe(false)
    expect(second.projects).toBe(first.projects)
    expect(projectTasks(second.projects[0])).toHaveLength(1)
  })

  it('reconcileTaskViewState puts the home tab in front of a home task by default', () => {
    const { task: homeTask, tab } = createHomeTask('p1')
    expect(reconcileTaskViewState(homeTask).activeTab.left).toBe(tab.id)
    expect(reconcileTaskViewState(homeTask, {
      activeTab: { left: null, right: null }, splitOpen: false, splitRatio: 0.5
    }).activeTab.left).toBe(tab.id)
  })

  it('resolveStoredSelection defaults to the home task when no task remembered', () => {
    const projects: Project[] = [fixtureProject({ id: 'p1', tasks: [
      { id: 'home-task-p1', name: 'Home', tabs: { left: [{ id: 'home-tab-p1', type: 'home', title: 'Home', system: 'home' }] }, system: 'home' },
      { id: 't1', tabs: { left: [{ id: 'term', type: 'terminal', title: 'Terminal' }] } }
    ] })]
    const result = resolveStoredSelection(projects, { ...DEFAULT_CONFIG, lastProjectId: 'p1', lastTaskId: null })
    expect(result.selectedProjectId).toBe('p1')
    expect(result.selectedTaskId).toBe('home-task-p1')
  })
})
