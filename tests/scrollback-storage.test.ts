import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { ScrollbackStorage } from '../src/main/scrollback-storage'
import fs from 'fs'
import path from 'path'
import os from 'os'

describe('ScrollbackStorage', () => {
  let storage: ScrollbackStorage
  let testDir: string

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devtool-scrollback-test-'))
    storage = new ScrollbackStorage(testDir)
  })

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true })
  })

  it('creates scrollback directory if it does not exist', () => {
    expect(fs.existsSync(testDir)).toBe(true)
  })

  it('saves and loads scrollback data', () => {
    storage.save('tab-1', 'line1\r\nline2\r\nline3')
    const data = storage.load('tab-1')
    expect(data).toBe('line1\r\nline2\r\nline3')
  })

  it('returns null for non-existent tab', () => {
    const data = storage.load('nonexistent')
    expect(data).toBeNull()
  })

  it('deletes scrollback data', () => {
    storage.save('tab-1', 'some data')
    storage.delete('tab-1')
    expect(storage.load('tab-1')).toBeNull()
  })

  it('delete is a no-op for non-existent tab', () => {
    expect(() => storage.delete('nonexistent')).not.toThrow()
  })

  it('overwrites existing scrollback on save', () => {
    storage.save('tab-1', 'old data')
    storage.save('tab-1', 'new data')
    expect(storage.load('tab-1')).toBe('new data')
  })
})
