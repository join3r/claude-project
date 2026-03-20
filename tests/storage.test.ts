import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Storage } from '../src/main/storage'
import { isRemoteProject, type ProjectsData } from '../src/shared/types'
import fs from 'fs'
import path from 'path'
import os from 'os'

describe('Storage', () => {
  let storage: Storage
  let testDir: string

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devtool-test-'))
    storage = new Storage(testDir)
  })

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true })
  })

  it('creates config directory if it does not exist', () => {
    expect(fs.existsSync(testDir)).toBe(true)
  })

  it('returns default config when no config file exists', () => {
    const config = storage.loadConfig()
    expect(config.fontFamily).toBe('monospace')
    expect(config.theme).toBe('system')
  })

  it('saves and loads config', () => {
    storage.saveConfig({ fontFamily: 'MesloLGS NF', fontSize: 16, theme: 'dark', terminalTheme: 'dark', defaultShell: '/bin/bash' })
    const config = storage.loadConfig()
    expect(config.fontFamily).toBe('MesloLGS NF')
    expect(config.fontSize).toBe(16)
  })

  it('returns empty projects when no projects file exists', () => {
    const data = storage.loadProjects()
    expect(data.projects).toEqual([])
  })

  it('saves and loads projects', () => {
    const projects = {
      projects: [{
        id: '1', name: 'Test', directory: '/tmp', tasks: []
      }]
    }
    storage.saveProjects(projects)
    const loaded = storage.loadProjects()
    expect(loaded.projects).toHaveLength(1)
    expect(loaded.projects[0].name).toBe('Test')
  })

  it('saves and loads lastProjectId and lastTaskId', () => {
    const config = storage.loadConfig()
    expect(config.lastProjectId).toBeNull()
    expect(config.lastTaskId).toBeNull()

    storage.saveConfig({ ...config, lastProjectId: 'proj-1', lastTaskId: 'task-1' })
    const loaded = storage.loadConfig()
    expect(loaded.lastProjectId).toBe('proj-1')
    expect(loaded.lastTaskId).toBe('task-1')
  })

  it('saves and loads projects with ssh config', () => {
    const projects = {
      projects: [{
        id: '1', name: 'Remote', directory: '', tasks: [],
        ssh: { host: 'dev.example.com', port: 22, username: 'deploy', remoteDir: '/home/deploy/app' }
      }]
    }
    storage.saveProjects(projects)
    const loaded = storage.loadProjects()
    expect(loaded.projects[0].ssh).toBeDefined()
    expect(loaded.projects[0].ssh!.host).toBe('dev.example.com')
    expect(loaded.projects[0].ssh!.port).toBe(22)
    expect(loaded.projects[0].ssh!.username).toBe('deploy')
    expect(loaded.projects[0].ssh!.remoteDir).toBe('/home/deploy/app')
    expect(loaded.projects[0].directory).toBe('')
  })

  it('saves and loads projects with ssh keyFile', () => {
    const projects = {
      projects: [{
        id: '1', name: 'Remote Key', directory: '', tasks: [],
        ssh: { host: 'dev.example.com', port: 2222, username: 'deploy', keyFile: '/home/user/.ssh/id_ed25519', remoteDir: '/opt/app' }
      }]
    }
    storage.saveProjects(projects)
    const loaded = storage.loadProjects()
    expect(loaded.projects[0].ssh!.keyFile).toBe('/home/user/.ssh/id_ed25519')
    expect(loaded.projects[0].ssh!.port).toBe(2222)
  })

  it('saves and loads projects with tunnel config', () => {
    const projects = {
      projects: [{
        id: '1',
        name: 'Remote Tunnel',
        directory: '',
        tasks: [],
        ssh: { host: 'dev.example.com', port: 22, username: 'deploy', remoteDir: '/opt/app' },
        tunnel: { host: 'localhost', sourcePort: 3000, destinationPort: 8080 }
      }]
    }
    storage.saveProjects(projects)
    const loaded = storage.loadProjects()
    expect(loaded.projects[0].tunnel).toEqual({
      host: 'localhost',
      sourcePort: 3000,
      destinationPort: 8080
    })
  })

  it('isRemoteProject returns true for projects with ssh config', () => {
    expect(isRemoteProject({ id: '1', name: 'R', directory: '', tasks: [], ssh: { host: 'h', port: 22, username: 'u', remoteDir: '/d' } })).toBe(true)
    expect(isRemoteProject({ id: '2', name: 'L', directory: '/local', tasks: [] })).toBe(false)
  })

  it('normalizes legacy data without folders or rootOrder', () => {
    const legacyData = {
      projects: [
        { id: 'p1', name: 'Project 1', directory: '/tmp/p1', tasks: [] },
        { id: 'p2', name: 'Project 2', directory: '/tmp/p2', tasks: [] }
      ]
    }
    fs.writeFileSync(path.join(testDir, 'projects.json'), JSON.stringify(legacyData))
    const loaded = storage.loadProjects()
    expect(loaded.folders).toEqual([])
    expect(loaded.rootOrder).toEqual(['p1', 'p2'])
  })

  it('returns empty folders and rootOrder on error fallback', () => {
    const loaded = storage.loadProjects()
    expect(loaded.folders).toEqual([])
    expect(loaded.rootOrder).toEqual([])
  })

  it('removes orphaned IDs from rootOrder and folder.projectIds', () => {
    const data = {
      projects: [{ id: 'p1', name: 'P1', directory: '/tmp', tasks: [] }],
      folders: [{ id: 'f1', name: 'Folder', projectIds: ['p1', 'deleted-project'] }],
      rootOrder: ['f1', 'also-deleted']
    }
    fs.writeFileSync(path.join(testDir, 'projects.json'), JSON.stringify(data))
    const loaded = storage.loadProjects()
    expect(loaded.folders[0].projectIds).toEqual(['p1'])
    expect(loaded.rootOrder).toEqual(['f1'])
  })

  it('deduplicates project appearing in multiple folders', () => {
    const data = {
      projects: [
        { id: 'p1', name: 'P1', directory: '/tmp', tasks: [] },
        { id: 'p2', name: 'P2', directory: '/tmp', tasks: [] }
      ],
      folders: [
        { id: 'f1', name: 'F1', projectIds: ['p1'] },
        { id: 'f2', name: 'F2', projectIds: ['p1', 'p2'] }
      ],
      rootOrder: ['f1', 'f2']
    }
    fs.writeFileSync(path.join(testDir, 'projects.json'), JSON.stringify(data))
    const loaded = storage.loadProjects()
    expect(loaded.folders[0].projectIds).toEqual(['p1'])
    expect(loaded.folders[1].projectIds).toEqual(['p2'])
  })

  it('appends unplaced projects to rootOrder', () => {
    const data = {
      projects: [
        { id: 'p1', name: 'P1', directory: '/tmp', tasks: [] },
        { id: 'p2', name: 'P2', directory: '/tmp', tasks: [] }
      ],
      folders: [],
      rootOrder: ['p1']
    }
    fs.writeFileSync(path.join(testDir, 'projects.json'), JSON.stringify(data))
    const loaded = storage.loadProjects()
    expect(loaded.rootOrder).toEqual(['p1', 'p2'])
  })

  it('preserves sessionId on tabs', () => {
    const projects = {
      projects: [{
        id: '1', name: 'Test', directory: '/tmp', tasks: [{
          id: 't1', name: 'Task', splitOpen: false, splitRatio: 0.5,
          activeTab: { left: 'tab1', right: null },
          tabs: {
            left: [{ id: 'tab1', type: 'claude' as const, title: 'Claude Code', sessionId: 'sess-abc-123' }],
            right: []
          }
        }]
      }]
    }
    storage.saveProjects(projects)
    const loaded = storage.loadProjects()
    expect(loaded.projects[0].tasks[0].tabs.left[0].sessionId).toBe('sess-abc-123')
  })

  it('saves and loads window session state', () => {
    const projectsData: ProjectsData = {
      projects: [{
        id: 'project-1',
        name: 'Project 1',
        directory: '/tmp/project-1',
        tasks: [{
          id: 'task-1',
          name: 'Task 1',
          tabs: {
            left: [{ id: 'left-1', type: 'terminal', title: 'Terminal' }],
            right: []
          },
          activeTab: { left: 'left-1', right: null },
          splitOpen: false,
          splitRatio: 0.5
        }]
      }],
      folders: [{ id: 'folder-1', name: 'Folder', projectIds: ['project-1'] }],
      rootOrder: ['folder-1']
    }
    const session = {
      windows: [{
        geometry: { x: 100, y: 120, width: 1200, height: 800, isMaximized: true },
        viewState: {
          selectedProjectId: 'project-1',
          selectedTaskId: 'task-1',
          collapsedFolderIds: ['folder-1'],
          taskStates: {
            'task-1': {
              activeTab: { left: 'left-1', right: null },
              splitOpen: false,
              splitRatio: 0.5
            }
          }
        }
      }]
    }

    storage.saveWindowSession(session)
    const loaded = storage.loadWindowSession(projectsData)

    // reconcileWindowViewState adds default file browser fields
    expect(loaded).toEqual({
      windows: [{
        geometry: session.windows[0].geometry,
        viewState: {
          ...session.windows[0].viewState,
          fileBrowserOpen: false,
          fileBrowserWidth: 250,
          fileBrowserActiveTab: 'files'
        }
      }]
    })
  })

  it('normalizes persisted window sessions against current projects and folders', () => {
    const projectsData: ProjectsData = {
      projects: [{
        id: 'project-1',
        name: 'Project 1',
        directory: '/tmp/project-1',
        tasks: [{
          id: 'task-1',
          name: 'Task 1',
          tabs: {
            left: [{ id: 'left-1', type: 'terminal', title: 'Terminal' }],
            right: [{ id: 'right-1', type: 'browser', title: 'Browser', url: 'https://example.com' }]
          },
          activeTab: { left: 'left-1', right: 'right-1' },
          splitOpen: true,
          splitRatio: 0.6
        }]
      }],
      folders: [{ id: 'folder-1', name: 'Folder', projectIds: ['project-1'] }],
      rootOrder: ['folder-1']
    }

    fs.writeFileSync(path.join(testDir, 'window-session.json'), JSON.stringify({
      windows: [
        {
          geometry: { x: 10, y: 20, width: 0, height: 800, isMaximized: false },
          viewState: {
            selectedProjectId: 'project-1',
            selectedTaskId: 'task-1',
            collapsedFolderIds: ['folder-1'],
            taskStates: {}
          }
        },
        {
          geometry: { x: 50, y: 60, width: 1200, height: 800, isMaximized: false },
          viewState: {
            selectedProjectId: 'missing-project',
            selectedTaskId: 'missing-task',
            collapsedFolderIds: ['folder-1', 'missing-folder'],
            taskStates: {
              'task-1': {
                activeTab: { left: 'missing-tab', right: 'right-1' },
                splitOpen: true,
                splitRatio: 0.75
              }
            }
          }
        }
      ]
    }))

    const loaded = storage.loadWindowSession(projectsData)

    expect(loaded.windows).toHaveLength(1)
    expect(loaded.windows[0].geometry).toEqual({ x: 50, y: 60, width: 1200, height: 800, isMaximized: false })
    expect(loaded.windows[0].viewState.selectedProjectId).toBeNull()
    expect(loaded.windows[0].viewState.selectedTaskId).toBeNull()
    expect(loaded.windows[0].viewState.collapsedFolderIds).toEqual(['folder-1'])
    expect(loaded.windows[0].viewState.taskStates['task-1']).toEqual({
      activeTab: { left: 'left-1', right: 'right-1' },
      splitOpen: true,
      splitRatio: 0.75
    })
  })

  it('returns empty window session when the file contains no saved windows', () => {
    fs.writeFileSync(path.join(testDir, 'window-session.json'), JSON.stringify({ windows: [] }))
    const loaded = storage.loadWindowSession({ projects: [], folders: [], rootOrder: [] })
    expect(loaded.windows).toEqual([])
  })
})
