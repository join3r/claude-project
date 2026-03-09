import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Storage } from '../src/main/storage'
import { isRemoteProject } from '../src/shared/types'
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

  it('isRemoteProject returns true for projects with ssh config', () => {
    expect(isRemoteProject({ id: '1', name: 'R', directory: '', tasks: [], ssh: { host: 'h', port: 22, username: 'u', remoteDir: '/d' } })).toBe(true)
    expect(isRemoteProject({ id: '2', name: 'L', directory: '/local', tasks: [] })).toBe(false)
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
})
