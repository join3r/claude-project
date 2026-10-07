import { describe, expect, it } from 'vitest'
import { openInIdeToEntities } from '../src/renderer/palette/sources/openInIde'
import { DEFAULT_CONFIG, type Project } from '../src/shared/types'
import type { AppActions } from '../src/renderer/hooks/useAppState'
import { fixtureProject } from './helpers/streams-fixtures'

const project: Project = fixtureProject({
  id: 'p1',
  name: 'Demo',
  directory: 'C:\\Repos\\demo',
  tasks: [{ id: 't1', name: 'Main' }]
})

function actions(patch: Partial<AppActions> = {}): AppActions {
  return {
    projects: [project],
    selectedProjectId: 'p1',
    selectedTaskId: 't1',
    config: {
      ...DEFAULT_CONFIG,
      externalEditors: {
        editors: [{ id: 'cursor', name: 'Cursor', command: 'Cursor.exe', extraArgs: '' }],
        defaultId: 'cursor'
      }
    },
    ...patch
  } as AppActions
}

describe('openInIdeToEntities', () => {
  it('lists Open in {name} for a local project', () => {
    const ents = openInIdeToEntities(actions())
    expect(ents.map((e) => e.title)).toEqual(['Open in Cursor'])
    expect(ents[0].id).toBe('command:open-ide:cursor')
    expect(ents[0].searchable).toMatch(/cursor/i)
  })

  it('returns nothing without a local folder', () => {
    expect(openInIdeToEntities(actions({ selectedProjectId: null } as Partial<AppActions>))).toEqual([])
  })
})
