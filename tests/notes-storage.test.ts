import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { NotesStorage } from '../src/main/notes-storage'
import { RevisionStore } from '../src/main/revision-store'
import type { NotesEnvelope, NotesRecord } from '../src/shared/types'
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

  describe('behind a RevisionStore', () => {
    const note = (id: string, content: string) =>
      ({ id, name: id, content, createdAt: 1, updatedAt: 1 })

    function buildStore(): { store: RevisionStore<NotesRecord>; broadcasts: NotesEnvelope[] } {
      storage.save({ p1: [note('n-a', 'a0'), note('n-b', 'b0')] })
      const broadcasts: NotesEnvelope[] = []
      const store = new RevisionStore<NotesRecord>({
        initial: storage.load(),
        persist: (data) => storage.save(data),
        broadcast: (envelope) => broadcasts.push(envelope)
      })
      return { store, broadcasts }
    }

    it('writes nothing to disk for a save that quotes a stale revision', () => {
      const { store } = buildStore()
      const stale = store.get()

      store.save(stale.revision, { p1: [note('n-a', 'a1'), note('n-b', 'b0')] })
      const refused = store.save(stale.revision, { p1: [note('n-a', 'a0'), note('n-b', 'b1')] })

      expect(refused.ok).toBe(false)
      // The whole-record write from the stale window never reached the file, so the
      // accepted edit is still there.
      expect(storage.load().p1.find(n => n.id === 'n-a')?.content).toBe('a1')
    })

    it('broadcasts every accepted note save so other windows learn about it', () => {
      const { store, broadcasts } = buildStore()

      store.save(store.getRevision(), { p1: [note('n-a', 'a1'), note('n-b', 'b0')] })

      expect(broadcasts).toHaveLength(1)
      expect(broadcasts[0].revision).toBe(1)
      expect(broadcasts[0].data.p1.find(n => n.id === 'n-a')?.content).toBe('a1')
    })
  })
})
