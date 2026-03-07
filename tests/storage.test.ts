import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Storage } from '../src/main/storage'
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
    storage.saveConfig({ fontFamily: 'MesloLGS NF', fontSize: 16, theme: 'dark', defaultShell: '/bin/bash' })
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
})
