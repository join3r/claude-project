import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { CodexSessionManager } from '../src/main/codex-session-manager'

// Mock child_process.execFile at module level
vi.mock('child_process', () => ({
  execFile: vi.fn()
}))

import { execFile } from 'child_process'

function mockExecFile(stdout: string, err?: Error): void {
  const mock = execFile as unknown as ReturnType<typeof vi.fn>
  mock.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null, stdout: string, stderr: string) => void) => {
    if (err) cb(err, '', err.message)
    else cb(null, stdout, '')
  })
}

describe('CodexSessionManager', () => {
  let sharedHome: string
  let manager: CodexSessionManager

  beforeEach(() => {
    sharedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'devtool-codex-home-'))
    manager = new CodexSessionManager(sharedHome)
    vi.clearAllMocks()
  })

  afterEach(() => {
    fs.rmSync(sharedHome, { recursive: true, force: true })
  })

  describe('findStateDbs', () => {
    it('returns empty array when no state_*.sqlite files exist', () => {
      expect(manager.findStateDbs()).toEqual([])
    })

    it('returns the only state db', () => {
      fs.writeFileSync(path.join(sharedHome, 'state_5.sqlite'), '')
      expect(manager.findStateDbs()).toEqual([path.join(sharedHome, 'state_5.sqlite')])
    })

    it('returns state dbs sorted by number descending', () => {
      fs.writeFileSync(path.join(sharedHome, 'state_1.sqlite'), '')
      fs.writeFileSync(path.join(sharedHome, 'state_5.sqlite'), '')
      fs.writeFileSync(path.join(sharedHome, 'state_10.sqlite'), '')
      expect(manager.findStateDbs()).toEqual([
        path.join(sharedHome, 'state_10.sqlite'),
        path.join(sharedHome, 'state_5.sqlite'),
        path.join(sharedHome, 'state_1.sqlite')
      ])
    })

    it('ignores non-matching files', () => {
      fs.writeFileSync(path.join(sharedHome, 'logs_1.sqlite'), '')
      fs.writeFileSync(path.join(sharedHome, 'state_5.sqlite'), '')
      fs.writeFileSync(path.join(sharedHome, 'config.toml'), '')
      expect(manager.findStateDbs()).toEqual([path.join(sharedHome, 'state_5.sqlite')])
    })

    it('ignores WAL and SHM journal files', () => {
      fs.writeFileSync(path.join(sharedHome, 'state_5.sqlite'), '')
      fs.writeFileSync(path.join(sharedHome, 'state_5.sqlite-wal'), '')
      fs.writeFileSync(path.join(sharedHome, 'state_5.sqlite-shm'), '')
      expect(manager.findStateDbs()).toEqual([path.join(sharedHome, 'state_5.sqlite')])
    })

    it('returns empty array when sharedHome does not exist', () => {
      const bad = new CodexSessionManager('/tmp/does-not-exist-codex-test')
      expect(bad.findStateDbs()).toEqual([])
    })
  })

  describe('readLatestSessionId', () => {
    it('returns null when no state db exists', async () => {
      expect(await manager.readLatestSessionId('/some/cwd')).toBeNull()
    })

    it('returns session id from sqlite3 output', async () => {
      fs.writeFileSync(path.join(sharedHome, 'state_5.sqlite'), '')
      mockExecFile('019cdee3-2ba9-7771-9e5e-a151984336d0\n')

      const result = await manager.readLatestSessionId('/some/cwd', 1000)

      expect(result).toBe('019cdee3-2ba9-7771-9e5e-a151984336d0')
      const mock = execFile as unknown as ReturnType<typeof vi.fn>
      const [cmd, args] = mock.mock.calls[0]
      expect(cmd).toBe('sqlite3')
      expect(args).toContain('-readonly')
      expect(args[1]).toBe(path.join(sharedHome, 'state_5.sqlite'))
      expect(args[2]).toContain("cwd = '/some/cwd'")
      expect(args[2]).toContain('created_at >= 1000')
    })

    it('returns null on empty output', async () => {
      fs.writeFileSync(path.join(sharedHome, 'state_5.sqlite'), '')
      mockExecFile('')

      expect(await manager.readLatestSessionId('/some/cwd')).toBeNull()
    })

    it('returns null on sqlite3 error with single db', async () => {
      fs.writeFileSync(path.join(sharedHome, 'state_5.sqlite'), '')
      mockExecFile('', new Error('no such table: threads'))

      expect(await manager.readLatestSessionId('/some/cwd')).toBeNull()
    })

    it('falls back to next db on error', async () => {
      fs.writeFileSync(path.join(sharedHome, 'state_10.sqlite'), '')
      fs.writeFileSync(path.join(sharedHome, 'state_5.sqlite'), '')
      const mock = execFile as unknown as ReturnType<typeof vi.fn>
      mock.mockImplementationOnce((_cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null, stdout: string, stderr: string) => void) => {
        cb(new Error('database disk image is malformed'), '', '')
      })
      mock.mockImplementationOnce((_cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null, stdout: string, stderr: string) => void) => {
        cb(null, 'fallback-session-id\n', '')
      })

      const result = await manager.readLatestSessionId('/some/cwd')
      expect(result).toBe('fallback-session-id')
      expect(mock).toHaveBeenCalledTimes(2)
    })

    it('escapes single quotes in cwd', async () => {
      fs.writeFileSync(path.join(sharedHome, 'state_5.sqlite'), '')
      mockExecFile('abc-123\n')

      await manager.readLatestSessionId("/user's dir", 0)

      const mock = execFile as unknown as ReturnType<typeof vi.fn>
      const sql = mock.mock.calls[0][1][2] as string
      expect(sql).toContain("cwd = '/user''s dir'")
    })

    it('sanitizes non-finite afterTs to zero', async () => {
      fs.writeFileSync(path.join(sharedHome, 'state_5.sqlite'), '')
      mockExecFile('abc-123\n')

      await manager.readLatestSessionId('/cwd', NaN)

      const mock = execFile as unknown as ReturnType<typeof vi.fn>
      const sql = mock.mock.calls[0][1][2] as string
      expect(sql).toContain('created_at >= 0')
    })

    it('caches sqlite3 ENOENT and short-circuits subsequent calls', async () => {
      fs.writeFileSync(path.join(sharedHome, 'state_5.sqlite'), '')
      const mock = execFile as unknown as ReturnType<typeof vi.fn>
      const enoent = new Error('spawn sqlite3 ENOENT') as NodeJS.ErrnoException
      enoent.code = 'ENOENT'
      mock.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null, stdout: string, stderr: string) => void) => {
        cb(enoent, '', '')
      })

      expect(await manager.readLatestSessionId('/some/cwd')).toBeNull()
      expect(await manager.readLatestSessionId('/some/cwd')).toBeNull()
      // Only one actual call — second was short-circuited by cached flag
      expect(mock).toHaveBeenCalledTimes(1)
    })
  })

  describe('buildRemoteReadSessionScript', () => {
    it('generates a python3 script with cwd and afterTs', () => {
      const script = manager.buildRemoteReadSessionScript('/srv/app', 1710000000)

      expect(script).toContain('python3')
      expect(script).toContain('/srv/app')
      expect(script).toContain('1710000000')
      expect(script).toContain('state_')
      expect(script).toContain('sqlite3')
      expect(script).toContain('sessionId')
      expect(script).toContain('threads')
    })
  })
})
