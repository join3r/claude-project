import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { NotesStorage } from '../src/main/notes-storage'
import fs from 'fs'
import path from 'path'
import os from 'os'

describe('NotesStorage', () => {
  let storage: NotesStorage
  let testDir: string

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devtool-notes-test-'))
    storage = new NotesStorage(testDir)
  })

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true })
  })

  it('returns empty object when no notes file exists', () => {
    expect(storage.load()).toEqual({})
  })

  it('saves and loads notes for a project', () => {
    const data = {
      'proj-1': [
        { id: 'n1', name: 'My Note', content: '# Hello', createdAt: 1000, updatedAt: 1000 }
      ]
    }
    storage.save(data)
    expect(storage.load()).toEqual(data)
  })

  it('overwrites existing data on save', () => {
    storage.save({ 'proj-1': [{ id: 'n1', name: 'Old', content: '', createdAt: 1, updatedAt: 1 }] })
    const newer = { 'proj-1': [{ id: 'n1', name: 'New', content: 'hello', createdAt: 1, updatedAt: 2 }] }
    storage.save(newer)
    expect(storage.load()).toEqual(newer)
  })

  it('handles notes for multiple projects', () => {
    const data = {
      'proj-1': [{ id: 'n1', name: 'Note A', content: '', createdAt: 1, updatedAt: 1 }],
      'proj-2': [{ id: 'n2', name: 'Note B', content: 'foo', createdAt: 2, updatedAt: 2 }]
    }
    storage.save(data)
    expect(storage.load()).toEqual(data)
  })

  it('returns empty object when notes file is corrupt JSON', () => {
    const filePath = path.join(testDir, 'notes.json')
    fs.writeFileSync(filePath, 'not valid json')
    expect(storage.load()).toEqual({})
  })
})
