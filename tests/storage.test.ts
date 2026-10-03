import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { Storage, atomicWriteFileSync } from '../src/main/storage'
import {
  DEFAULT_CONFIG,
  createDefaultWindowViewState,
  isRemoteProject,
  type ProjectsData,
  type WindowSessionState,
  type WindowViewState
} from '../src/shared/types'
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
    expect(config.editorWordWrap).toBe('off')
    expect(config.diffRenderSideBySide).toBe(true)
    expect(config.defaultSidebarTab).toBe('inbox')
    expect(config.promptBoxAgent).toBe('claude-chat')
    expect(config.promptBoxMode).toBe('')
    expect(config.piCommand).toBe('')
    expect(config.claudeCommand).toBe('')
    expect(config.codexCommand).toBe('')
    expect(config.portableNodeDir).toBe('')
    expect(config.windowsTerminal).toBe('git-bash')
    expect(config.externalEditors).toEqual({ editors: [], defaultId: null })
  })

  it('drops the retired new-task auto-open setting on load', () => {
    fs.writeFileSync(path.join(testDir, 'config.json'), JSON.stringify({ newTaskAutoOpen: 'claude' }))
    const config = storage.loadConfig() as unknown as Record<string, unknown>
    expect('newTaskAutoOpen' in config).toBe(false)
  })

  it('fills in new config defaults for configs written before the key existed', () => {
    fs.writeFileSync(path.join(testDir, 'config.json'), JSON.stringify({ fontSize: 16 }))
    const config = storage.loadConfig()
    expect(config.fontSize).toBe(16)
    expect(config.defaultSidebarTab).toBe('inbox')
    expect(config.promptBoxAgent).toBe('claude-chat')
    expect(config.piCommand).toBe('')
    expect(config.portableNodeDir).toBe('')
    expect(config.windowsTerminal).toBe('git-bash')
    expect(config.externalEditors).toEqual({ editors: [], defaultId: null })
  })

  it('round-trips the portable Node directory', () => {
    storage.saveConfig({ ...DEFAULT_CONFIG, portableNodeDir: 'C:\\Tools\\node-v22' })
    const loaded = storage.loadConfig()
    expect(loaded.portableNodeDir).toBe('C:\\Tools\\node-v22')
  })

  it('saves and loads config', () => {
    storage.saveConfig({
      ...DEFAULT_CONFIG,
      fontFamily: 'MesloLGS NF',
      fontSize: 16,
      theme: 'dark',
      terminalTheme: 'dark',
      defaultShell: '/bin/bash',
      editorFontFamily: 'JetBrains Mono',
      editorWordWrap: 'bounded',
      diffRenderSideBySide: false
    })
    const config = storage.loadConfig()
    expect(config.fontFamily).toBe('MesloLGS NF')
    expect(config.fontSize).toBe(16)
    expect(config.editorFontFamily).toBe('JetBrains Mono')
    expect(config.editorWordWrap).toBe('bounded')
    expect(config.diffRenderSideBySide).toBe(false)
    expect(config.windowsTerminal).toBe('git-bash')
  })

  it('coerces legacy PowerShell and cmd terminal presets to Git Bash', () => {
    fs.writeFileSync(
      path.join(testDir, 'config.json'),
      JSON.stringify({ fontSize: 16, windowsTerminal: 'powershell' })
    )
    expect(storage.loadConfig().windowsTerminal).toBe('git-bash')
    fs.writeFileSync(
      path.join(testDir, 'config.json'),
      JSON.stringify({ fontSize: 16, windowsTerminal: 'cmd' })
    )
    expect(storage.loadConfig().windowsTerminal).toBe('git-bash')
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
    storage.saveProjects(projects as unknown as ProjectsData)
    const loaded = storage.loadProjects()
    expect(loaded.projects).toHaveLength(1)
    expect(loaded.projects[0].name).toBe('Test')
  })

  it('round-trips a project conda env name and prefix', () => {
    storage.saveProjects({
      projects: [{
        id: '1',
        name: 'ML',
        directory: 'C:\\Repos\\ml',
        tasks: [],
        condaEnvName: 'ml',
        condaEnvPrefix: 'C:\\Users\\me\\miniconda3\\envs\\ml'
      }],
      tags: [],
      projectOrder: [],
      pinnedItems: []
    } as unknown as ProjectsData)
    const loaded = storage.loadProjects().projects[0]
    expect(loaded.condaEnvName).toBe('ml')
    expect(loaded.condaEnvPrefix).toBe('C:\\Users\\me\\miniconda3\\envs\\ml')
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
    storage.saveProjects(projects as unknown as ProjectsData)
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
    storage.saveProjects(projects as unknown as ProjectsData)
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
    storage.saveProjects(projects as unknown as ProjectsData)
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

  it('defaults projectOrder from projects when missing', () => {
    const legacyData = {
      projects: [
        { id: 'p1', name: 'Project 1', directory: '/tmp/p1', tasks: [] },
        { id: 'p2', name: 'Project 2', directory: '/tmp/p2', tasks: [] }
      ]
    }
    fs.writeFileSync(path.join(testDir, 'projects.json'), JSON.stringify(legacyData))
    const loaded = storage.loadProjects()
    expect(loaded.tags).toEqual([])
    expect(loaded.projectOrder).toEqual(['p1', 'p2'])
  })

  it('returns empty tags and projectOrder on error fallback', () => {
    const loaded = storage.loadProjects()
    expect(loaded.tags).toEqual([])
    expect(loaded.projectOrder).toEqual([])
  })

  it('ignores legacy folders and rootOrder', () => {
    const data = {
      projects: [{ id: 'p1', name: 'P1', directory: '/tmp', tasks: [] }],
      folders: [{ id: 'f1', name: 'Folder', projectIds: ['p1'] }],
      rootOrder: ['f1']
    }
    fs.writeFileSync(path.join(testDir, 'projects.json'), JSON.stringify(data))
    const loaded = storage.loadProjects()
    expect(loaded.tags).toEqual([])
    expect(loaded.projectOrder).toEqual(['p1'])
  })

  it('prunes orphan projectOrder and tagIds', () => {
    const data = {
      projects: [{ id: 'p1', name: 'P1', directory: '/tmp', tasks: [], tagIds: ['t1', 'missing'] }],
      tags: [{ id: 't1', name: 'work' }, { id: 'orphan', name: 'unused' }],
      projectOrder: ['p1', 'deleted']
    }
    fs.writeFileSync(path.join(testDir, 'projects.json'), JSON.stringify(data))
    const loaded = storage.loadProjects()
    expect(loaded.projectOrder).toEqual(['p1'])
    expect(loaded.projects[0].tagIds).toEqual(['t1'])
    expect(loaded.tags).toEqual([{ id: 't1', name: 'work' }])
  })

  it('appends unplaced projects to projectOrder', () => {
    const data = {
      projects: [
        { id: 'p1', name: 'P1', directory: '/tmp', tasks: [] },
        { id: 'p2', name: 'P2', directory: '/tmp', tasks: [] }
      ],
      tags: [],
      projectOrder: ['p1']
    }
    fs.writeFileSync(path.join(testDir, 'projects.json'), JSON.stringify(data))
    const loaded = storage.loadProjects()
    expect(loaded.projectOrder).toEqual(['p1', 'p2'])
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
    storage.saveProjects(projects as unknown as ProjectsData)
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
      tags: [{ id: 'tag-1', name: 'work' }],
      projectOrder: ['project-1'],
      pinnedItems: []
    }
    const session = {
      windows: [{
        geometry: { x: 100, y: 120, width: 1200, height: 800, isMaximized: true },
        viewState: {
          selectedProjectId: 'project-1',
          selectedTaskId: 'task-1',
          selectedTagIds: ['tag-1'],
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

    storage.saveWindowSession(session as unknown as WindowSessionState)
    const loaded = storage.loadWindowSession(projectsData)

    // reconcileWindowViewState adds default file browser fields
    expect(loaded).toEqual({
      windows: [{
        geometry: session.windows[0].geometry,
        viewState: {
          ...session.windows[0].viewState,
          expandedProjectIds: [],
          fileBrowserOpen: false,
          fileBrowserWidth: 250,
          fileBrowserActiveTab: 'files',
          sidebarWidth: 240,
          sidebarProjectsCollapsed: false,
          sidebarTab: 'projects'
        }
      }]
    })
  })

  it('restores the persisted sidebar tab, and only falls back to the configured default when absent', () => {
    const projectsData: ProjectsData = { projects: [], tags: [], projectOrder: [], pinnedItems: [] }
    const geometry = { x: 0, y: 0, width: 1200, height: 800, isMaximized: false }

    storage.saveWindowSession({
      windows: [{ geometry, viewState: { ...createDefaultWindowViewState(), sidebarTab: 'inbox' } }]
    })
    expect(storage.loadWindowSession(projectsData, 'projects').windows[0].viewState.sidebarTab).toBe('inbox')

    storage.saveWindowSession({
      windows: [{ geometry, viewState: { ...createDefaultWindowViewState(), sidebarTab: 'projects' } }]
    })
    expect(storage.loadWindowSession(projectsData, 'inbox').windows[0].viewState.sidebarTab).toBe('projects')

    // legacy session written before the field existed
    const { sidebarTab: _omitted, ...legacyViewState } = createDefaultWindowViewState()
    storage.saveWindowSession({
      windows: [{ geometry, viewState: legacyViewState as WindowViewState }]
    })
    expect(storage.loadWindowSession(projectsData, 'inbox').windows[0].viewState.sidebarTab).toBe('inbox')
  })

  it('normalizes persisted window sessions against current projects and tags', () => {
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
      tags: [{ id: 'tag-1', name: 'work' }],
      projectOrder: ['project-1'],
      pinnedItems: []
    }

    fs.writeFileSync(path.join(testDir, 'window-session.json'), JSON.stringify({
      windows: [
        {
          geometry: { x: 10, y: 20, width: 0, height: 800, isMaximized: false },
          viewState: {
            selectedProjectId: 'project-1',
            selectedTaskId: 'task-1',
            selectedTagIds: ['tag-1'],
            taskStates: {}
          }
        },
        {
          geometry: { x: 50, y: 60, width: 1200, height: 800, isMaximized: false },
          viewState: {
            selectedProjectId: 'missing-project',
            selectedTaskId: 'missing-task',
            selectedTagIds: ['tag-1', 'missing-tag'],
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
    expect(loaded.windows[0].viewState.selectedTagIds).toEqual(['tag-1'])
    expect(loaded.windows[0].viewState.taskStates['task-1']).toEqual({
      activeTab: { left: 'left-1', right: 'right-1' },
      splitOpen: true,
      splitRatio: 0.75
    })
  })

  it('migrates legacy lastFocusedAt to lastInteractedAt on load', () => {
    const legacy = {
      projects: [{
        id: 'p1',
        name: 'P1',
        type: 'local',
        dir: '/tmp/p1',
        tasks: [{
          id: 't1',
          name: 'T1',
          tabs: { left: [], right: [] },
          activeTab: { left: null, right: null },
          splitOpen: false,
          splitRatio: 0.5,
          lastFocusedAt: 12345
        }, {
          id: 't2',
          name: 'T2',
          tabs: { left: [], right: [] },
          activeTab: { left: null, right: null },
          splitOpen: false,
          splitRatio: 0.5
        }],
        tabIdCounter: 0
      }],
      projectOrder: ['p1']
    }

    const normalized = Storage.normalizeProjectsData(legacy as Record<string, unknown>)
    const tasks = normalized.projects[0].tasks
    expect(tasks[0].lastInteractedAt).toBe(12345)
    expect((tasks[0] as any).lastFocusedAt).toBeUndefined()
    // t2 has no stamp of any kind — it gets one now rather than reading as infinitely idle.
    expect(tasks[1].lastInteractedAt).toBeGreaterThan(12345)
  })

  it('starts the clock now for a task with no activity stamp at all', () => {
    const before = Date.now()
    const data = {
      projects: [{
        id: 'p1',
        name: 'P1',
        dir: '/tmp/p1',
        tasks: [{
          id: 't1',
          name: 'T1',
          tabs: { left: [], right: [] },
          activeTab: { left: null, right: null },
          splitOpen: false,
          splitRatio: 0.5
        }]
      }],
      projectOrder: ['p1']
    }

    const normalized = Storage.normalizeProjectsData(data as Record<string, unknown>)
    const stamp = normalized.projects[0].tasks[0].lastInteractedAt
    expect(stamp).toBeGreaterThanOrEqual(before)
    expect(stamp).toBeLessThanOrEqual(Date.now())
  })

  it('leaves a task with only an inbox event stamp alone', () => {
    const data = {
      projects: [{
        id: 'p1',
        name: 'P1',
        dir: '/tmp/p1',
        tasks: [{
          id: 't1',
          name: 'T1',
          tabs: { left: [], right: [] },
          activeTab: { left: null, right: null },
          splitOpen: false,
          splitRatio: 0.5,
          inbox: { eventAt: 4242 }
        }]
      }],
      projectOrder: ['p1']
    }

    const normalized = Storage.normalizeProjectsData(data as Record<string, unknown>)
    expect(normalized.projects[0].tasks[0].lastInteractedAt).toBeUndefined()
  })

  it('does not overwrite existing lastInteractedAt', () => {
    const data = {
      projects: [{
        id: 'p1',
        name: 'P1',
        type: 'local',
        dir: '/tmp/p1',
        tasks: [{
          id: 't1',
          name: 'T1',
          tabs: { left: [], right: [] },
          activeTab: { left: null, right: null },
          splitOpen: false,
          splitRatio: 0.5,
          lastFocusedAt: 100,
          lastInteractedAt: 999
        }],
        tabIdCounter: 0
      }],
      projectOrder: ['p1']
    }

    const normalized = Storage.normalizeProjectsData(data as Record<string, unknown>)
    const tasks = normalized.projects[0].tasks
    expect(tasks[0].lastInteractedAt).toBe(999)
    expect((tasks[0] as any).lastFocusedAt).toBeUndefined()
  })

  describe('ad-hoc (ephemeral) projects', () => {
    const task = (id: string, system?: 'home'): Record<string, unknown> => ({
      id,
      name: id,
      tabs: { left: [], right: [] },
      activeTab: { left: null, right: null },
      splitOpen: false,
      splitRatio: 0.5,
      lastInteractedAt: 1,
      ...(system ? { system } : {})
    })

    it('drops one whose last real task is gone, order entry included', () => {
      const data = {
        projects: [
          { id: 'p1', name: 'P1', directory: '/tmp/p1', tasks: [task('t1')] },
          { id: 'adhoc', name: 'scratch', directory: '/tmp/scratch', ephemeral: true, tasks: [task('home', 'home')] }
        ],
        projectOrder: ['p1', 'adhoc'],
        tags: [],
        pinnedItems: []
      }

      const normalized = Storage.normalizeProjectsData(data as Record<string, unknown>)
      expect(normalized.projects.map(p => p.id)).toEqual(['p1'])
      expect(normalized.projectOrder).toEqual(['p1'])
    })

    it('keeps one that still holds a real task', () => {
      const data = {
        projects: [
          { id: 'adhoc', name: 'scratch', directory: '/tmp/scratch', ephemeral: true, tasks: [task('home', 'home'), task('t1')] }
        ],
        projectOrder: ['adhoc'],
        tags: [],
        pinnedItems: []
      }

      const normalized = Storage.normalizeProjectsData(data as Record<string, unknown>)
      expect(normalized.projects.map(p => p.id)).toEqual(['adhoc'])
      expect(normalized.projectOrder).toEqual(['adhoc'])
    })

    it('leaves an ordinary empty project alone', () => {
      const data = {
        projects: [{ id: 'p1', name: 'P1', directory: '/tmp/p1', tasks: [task('home', 'home')] }],
        projectOrder: ['p1'],
        tags: [],
        pinnedItems: []
      }

      const normalized = Storage.normalizeProjectsData(data as Record<string, unknown>)
      expect(normalized.projects.map(p => p.id)).toEqual(['p1'])
    })

    it('prunes pins that pointed at the project it dropped', () => {
      const data = {
        projects: [
          { id: 'adhoc', name: 'scratch', directory: '/tmp/scratch', ephemeral: true, tasks: [task('home', 'home')] }
        ],
        projectOrder: ['adhoc'],
        tags: [],
        pinnedItems: [{ type: 'project', projectId: 'adhoc' }]
      }

      const normalized = Storage.normalizeProjectsData(data as Record<string, unknown>)
      expect(normalized.pinnedItems).toEqual([])
    })
  })

  it('returns empty window session when the file contains no saved windows', () => {
    fs.writeFileSync(path.join(testDir, 'window-session.json'), JSON.stringify({ windows: [] }))
    const loaded = storage.loadWindowSession({ projects: [], tags: [], projectOrder: [], pinnedItems: [] })
    expect(loaded.windows).toEqual([])
  })

  it('backupProjectsOnStartup is a no-op when projects.json does not exist', () => {
    // Nothing on disk is nothing to lose, so this still counts as a snapshot for
    // the callers that refuse to delete without one.
    expect(storage.backupProjectsOnStartup()).toBe(true)
    expect(fs.existsSync(path.join(testDir, 'backups'))).toBe(false)
  })

  it('backupProjectsOnStartup reports failure instead of swallowing it', () => {
    fs.writeFileSync(path.join(testDir, 'projects.json'), '{"projects":[]}')
    // A file where backups/ has to go: the copy cannot happen, and idle cleanup
    // must be able to see that (finding #9).
    fs.writeFileSync(path.join(testDir, 'backups'), 'not a directory')

    expect(storage.backupProjectsOnStartup()).toBe(false)
  })

  it('backupProjectsOnStartup snapshots projects.json into backups/', () => {
    fs.writeFileSync(path.join(testDir, 'projects.json'), '{"projects":[]}')
    expect(storage.backupProjectsOnStartup()).toBe(true)
    const backups = fs.readdirSync(path.join(testDir, 'backups'))
    expect(backups).toHaveLength(1)
    expect(backups[0]).toMatch(/^projects-.*\.json$/)
    expect(fs.readFileSync(path.join(testDir, 'backups', backups[0]), 'utf-8')).toBe('{"projects":[]}')
  })

  it('backupProjectsOnStartup prunes oldest snapshots beyond the keep limit', () => {
    const backupsDir = path.join(testDir, 'backups')
    fs.mkdirSync(backupsDir)
    for (let i = 0; i < 12; i++) {
      fs.writeFileSync(path.join(backupsDir, `projects-2026-01-${String(i + 1).padStart(2, '0')}.json`), '{}')
    }
    fs.writeFileSync(path.join(testDir, 'projects.json'), '{"projects":[]}')
    storage.backupProjectsOnStartup(10)
    const remaining = fs.readdirSync(backupsDir).sort()
    expect(remaining).toHaveLength(10)
    expect(remaining[0]).toBe('projects-2026-01-04.json')
  })

  describe('data safety', () => {
    const projectsFile = () => path.join(testDir, 'projects.json')
    const backupsDir = () => path.join(testDir, 'backups')
    const sampleProjects = (name: string): ProjectsData => ({
      projects: [{ id: 'p1', name, path: '/tmp/p1', tasks: [], tagIds: [] } as unknown as ProjectsData['projects'][number]],
      tags: [],
      projectOrder: ['p1'],
      pinnedItems: []
    })
    let errorSpy: ReturnType<typeof vi.spyOn>

    beforeEach(() => {
      errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    })
    afterEach(() => {
      errorSpy.mockRestore()
    })

    it('atomicWriteFileSync replaces the target and leaves no temp files', () => {
      const target = path.join(testDir, 'x.json')
      fs.writeFileSync(target, 'old')
      atomicWriteFileSync(target, 'new')
      expect(fs.readFileSync(target, 'utf-8')).toBe('new')
      expect(fs.readdirSync(testDir)).toEqual(['x.json'])
    })

    it('atomicWriteFileSync leaves the original intact when the write fails', () => {
      const target = path.join(testDir, 'x.json')
      fs.writeFileSync(target, 'old')
      const spy = vi.spyOn(fs, 'renameSync').mockImplementation(() => { throw new Error('boom') })
      try {
        expect(() => atomicWriteFileSync(target, 'new')).toThrow('boom')
      } finally {
        spy.mockRestore()
      }
      expect(fs.readFileSync(target, 'utf-8')).toBe('old')
      expect(fs.readdirSync(testDir)).toEqual(['x.json'])
    })

    it('saves projects, config and window session without leaving temp files', () => {
      storage.saveProjects(sampleProjects('A'))
      storage.saveConfig({ ...DEFAULT_CONFIG })
      storage.saveWindowSession({ windows: [] })
      expect(fs.readdirSync(testDir).sort()).toEqual(['config.json', 'projects.json', 'window-session.json'])
      expect(storage.loadProjects().projects[0].name).toBe('A')
    })

    it('treats a missing projects.json as a fresh start without logging', () => {
      expect(storage.loadProjects()).toEqual({ projects: [], tags: [], projectOrder: [], pinnedItems: [] })
      expect(errorSpy).not.toHaveBeenCalled()
      expect(fs.readdirSync(testDir)).toEqual([])
    })

    it('restores a corrupt projects.json from the newest parseable backup', () => {
      fs.mkdirSync(backupsDir())
      fs.writeFileSync(path.join(backupsDir(), 'projects-2026-01-01.json'), JSON.stringify(sampleProjects('older')))
      fs.writeFileSync(path.join(backupsDir(), 'projects-2026-01-02.json'), JSON.stringify(sampleProjects('newest-good')))
      fs.writeFileSync(path.join(backupsDir(), 'projects-2026-01-03.json'), '{"projects": [tru')
      fs.writeFileSync(projectsFile(), '{"projects": [{"id": "p1", "na')

      const loaded = storage.loadProjects()
      expect(loaded.projects.map(p => p.name)).toEqual(['newest-good'])
      // The bad file is kept for inspection, and projects.json is the restored copy.
      const corrupt = fs.readdirSync(testDir).filter(f => f.startsWith('projects.json.corrupt-'))
      expect(corrupt).toHaveLength(1)
      expect(fs.readFileSync(path.join(testDir, corrupt[0]), 'utf-8')).toBe('{"projects": [{"id": "p1", "na')
      expect(JSON.parse(fs.readFileSync(projectsFile(), 'utf-8')).projects[0].name).toBe('newest-good')
      expect(errorSpy).toHaveBeenCalled()
    })

    it('treats an empty or non-object projects.json as corrupt', () => {
      fs.mkdirSync(backupsDir())
      fs.writeFileSync(path.join(backupsDir(), 'projects-2026-01-01.json'), JSON.stringify(sampleProjects('good')))
      fs.writeFileSync(projectsFile(), '')
      expect(storage.loadProjects().projects.map(p => p.name)).toEqual(['good'])
      fs.writeFileSync(projectsFile(), 'null')
      expect(storage.loadProjects().projects.map(p => p.name)).toEqual(['good'])
    })

    it('falls back to empty data for a corrupt projects.json with no usable backup, keeping the bad file', () => {
      fs.writeFileSync(projectsFile(), '{not json')
      expect(storage.loadProjects()).toEqual({ projects: [], tags: [], projectOrder: [], pinnedItems: [] })
      expect(fs.existsSync(projectsFile())).toBe(false)
      const corrupt = fs.readdirSync(testDir).filter(f => f.startsWith('projects.json.corrupt-'))
      expect(corrupt).toHaveLength(1)
      expect(errorSpy).toHaveBeenCalled()
    })

    it('moves a corrupt config.json aside instead of letting defaults overwrite it', () => {
      fs.writeFileSync(path.join(testDir, 'config.json'), '{"fontSize": 1')
      const config = storage.loadConfig()
      expect(config).toEqual({ ...DEFAULT_CONFIG })
      expect(fs.existsSync(path.join(testDir, 'config.json'))).toBe(false)
      expect(fs.readdirSync(testDir).some(f => f.startsWith('config.json.corrupt-'))).toBe(true)
    })

    it('backupProjectsOnStartup does not snapshot an unparseable projects.json', () => {
      fs.writeFileSync(projectsFile(), '{"projects": [')
      expect(storage.backupProjectsOnStartup()).toBe(false)
      expect(fs.existsSync(backupsDir())).toBe(false)
    })

    it('backupProjectsOnStartup skips a snapshot identical to the newest one', () => {
      fs.writeFileSync(projectsFile(), '{"projects":[]}')
      expect(storage.backupProjectsOnStartup()).toBe(true)
      expect(storage.backupProjectsOnStartup()).toBe(true)
      expect(fs.readdirSync(backupsDir())).toHaveLength(1)

      fs.writeFileSync(projectsFile(), '{"projects":[],"tags":[]}')
      expect(storage.backupProjectsOnStartup()).toBe(true)
      const snaps = fs.readdirSync(backupsDir()).sort()
      expect(fs.readFileSync(path.join(backupsDir(), snaps[snaps.length - 1]), 'utf-8')).toBe('{"projects":[],"tags":[]}')
    })

    it('repeated launches on identical data do not rotate good backups out', () => {
      fs.mkdirSync(backupsDir())
      for (let i = 0; i < 10; i++) {
        fs.writeFileSync(path.join(backupsDir(), `projects-2026-01-${String(i + 1).padStart(2, '0')}.json`), `{"v":${i}}`)
      }
      fs.writeFileSync(projectsFile(), '{"v":9}')
      for (let i = 0; i < 5; i++) storage.backupProjectsOnStartup(10)
      expect(fs.readdirSync(backupsDir()).sort()[0]).toBe('projects-2026-01-01.json')
    })
  })
})
