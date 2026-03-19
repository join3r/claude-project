import { describe, expect, it } from 'vitest'
import {
  DEFAULT_CONFIG,
  buildWindowViewState,
  reconcileWindowViewState,
  type Project,
  type WindowViewState
} from '../src/shared/types'

describe('window view state', () => {
  const projects: Project[] = [
    {
      id: 'project-1',
      name: 'Project 1',
      directory: '/tmp/project-1',
      lastTaskId: 'task-1',
      tasks: [
        {
          id: 'task-1',
          name: 'Task 1',
          tabs: {
            left: [{ id: 'left-1', type: 'terminal', title: 'Terminal' }],
            right: [{ id: 'right-1', type: 'browser', title: 'Browser', url: 'https://example.com' }]
          },
          activeTab: { left: 'left-1', right: 'right-1' },
          splitOpen: true,
          splitRatio: 0.6
        }
      ]
    }
  ]

  it('builds an initial window view state from stored selection', () => {
    const state = buildWindowViewState(
      projects,
      { ...DEFAULT_CONFIG, lastProjectId: 'project-1', lastTaskId: 'task-1', collapsedFolderIds: ['folder-1'] }
    )

    expect(state.selectedProjectId).toBe('project-1')
    expect(state.selectedTaskId).toBe('task-1')
    expect(state.collapsedFolderIds).toEqual(['folder-1'])
  })

  it('prefers a seeded view state when opening a second window', () => {
    const state = buildWindowViewState(projects, DEFAULT_CONFIG, {
      selectedProjectId: 'project-1',
      selectedTaskId: 'task-1',
      taskStates: {
        'task-1': {
          activeTab: { left: 'left-1', right: null },
          splitOpen: false,
          splitRatio: 0.5
        }
      }
    })

    expect(state.selectedProjectId).toBe('project-1')
    expect(state.selectedTaskId).toBe('task-1')
    expect(state.taskStates['task-1'].splitOpen).toBe(false)
    expect(state.taskStates['task-1'].activeTab.right).toBeNull()
  })

  it('reconciles stale task state against shared projects', () => {
    const state: WindowViewState = {
      selectedProjectId: 'project-1',
      selectedTaskId: 'task-1',
      collapsedFolderIds: [],
      taskStates: {
        'task-1': {
          activeTab: { left: 'missing-tab', right: 'right-1' },
          splitOpen: true,
          splitRatio: 0.75
        },
        'deleted-task': {
          activeTab: { left: 'x', right: null },
          splitOpen: false,
          splitRatio: 0.5
        }
      }
    }

    const next = reconcileWindowViewState(state, projects)

    expect(next.taskStates['task-1'].activeTab.left).toBe('left-1')
    expect(next.taskStates['task-1'].activeTab.right).toBe('right-1')
    expect(next.taskStates['deleted-task']).toBeUndefined()
  })
})
