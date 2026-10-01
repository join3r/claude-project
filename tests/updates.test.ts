import { createRequire } from 'node:module'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  compareVersions,
  decideUpdateMode,
  describeUpdateStatus,
  parseLatestRelease,
  RELEASES_URL,
  type UpdateStatus
} from '../src/shared/updates'
import { createUpdates, FIRST_CHECK_DELAY_MS, type UpdatesDeps } from '../src/main/updates'
import { DEFAULT_CONFIG } from '../src/shared/types'
import { sanitizeConfigUpdate } from '../src/main/ipc/config-sanitize'

const require = createRequire(import.meta.url)
const { signCommand } = require('../scripts/sign-win.cjs') as {
  signCommand: (file: string, template?: string) => string | null
}

describe('compareVersions', () => {
  it('compares numerically, not as strings', () => {
    expect(compareVersions('0.10.0', '0.9.9')).toBeGreaterThan(0)
    expect(compareVersions('0.6.0', '0.6.0')).toBe(0)
    expect(compareVersions('v0.6.1', '0.6.0')).toBeGreaterThan(0)
    expect(compareVersions('0.6', '0.6.0')).toBe(0)
  })

  it('sorts a pre-release before its release', () => {
    expect(compareVersions('0.6.0-beta.1', '0.6.0')).toBeLessThan(0)
    expect(compareVersions('0.6.0', '0.6.0-beta.1')).toBeGreaterThan(0)
    expect(compareVersions('0.6.0-beta.2', '0.6.0-beta.1')).toBeGreaterThan(0)
  })
})

describe('parseLatestRelease', () => {
  it('takes the tag and rebuilds the URL on the repo', () => {
    expect(parseLatestRelease('https://github.com/join3r/claude-project/releases/tag/v0.6.1')).toEqual({
      version: '0.6.1',
      url: `${RELEASES_URL}/tag/v0.6.1`
    })
    expect(parseLatestRelease('https://evil.example/x/releases/tag/v9.0.0')?.url).toBe(`${RELEASES_URL}/tag/v9.0.0`)
  })

  it('rejects anything that is not a version tag', () => {
    expect(parseLatestRelease(null)).toBeNull()
    expect(parseLatestRelease('https://github.com/join3r/claude-project/releases')).toBeNull()
    expect(parseLatestRelease('https://github.com/join3r/claude-project/releases/tag/nightly')).toBeNull()
  })
})

describe('decideUpdateMode', () => {
  const base = { isPackaged: true, platform: 'win32', hasUpdateConfig: true, signed: true }

  it('self-updates only a signed Windows NSIS install', () => {
    expect(decideUpdateMode(base)).toBe('auto')
    expect(decideUpdateMode({ ...base, signed: false })).toBe('manual')
    // Portable folder: no app-update.yml.
    expect(decideUpdateMode({ ...base, hasUpdateConfig: false })).toBe('manual')
    expect(decideUpdateMode({ ...base, platform: 'darwin' })).toBe('manual')
  })

  it('does nothing in dev', () => {
    expect(decideUpdateMode({ ...base, isPackaged: false })).toBe('none')
  })
})

describe('describeUpdateStatus', () => {
  const status: UpdateStatus = {
    appVersion: '0.6.0', mode: 'manual', state: 'idle', available: null, releaseUrl: null, checkedAt: null, error: null
  }
  it('reads each state', () => {
    expect(describeUpdateStatus(status)).toBe('Not checked yet.')
    expect(describeUpdateStatus({ ...status, checkedAt: 1 })).toBe('DevTool is up to date.')
    expect(describeUpdateStatus({ ...status, available: '0.6.1' })).toBe('0.6.1 is available.')
    expect(describeUpdateStatus({ ...status, state: 'error', error: 'offline' })).toContain('offline')
    expect(describeUpdateStatus({ ...status, mode: 'none' })).toContain('development')
  })
})

describe('createUpdates (manual mode)', () => {
  afterEach(() => { vi.useRealTimers() })

  function setup(location: string | null, overrides: Partial<UpdatesDeps> = {}) {
    const probeMock = vi.fn(async () => ({ status: 302, location }))
    const broadcast = vi.fn()
    const openExternal = vi.fn()
    const updates = createUpdates({
      mode: 'manual',
      appVersion: '0.6.0',
      autoCheck: () => true,
      broadcast,
      openExternal,
      probeRedirect: probeMock,
      now: () => 1234,
      log: () => {},
      loadAutoUpdater: () => { throw new Error('not in manual mode') },
      ...overrides
    })
    return { updates, probeMock, broadcast, openExternal }
  }

  it('reports a newer release and opens its page', async () => {
    const { updates, openExternal } = setup('https://github.com/join3r/claude-project/releases/tag/v0.6.1')
    const status = await updates.check()
    expect(status).toMatchObject({ state: 'idle', available: '0.6.1', checkedAt: 1234 })
    await updates.install()
    expect(openExternal).toHaveBeenCalledWith(`${RELEASES_URL}/tag/v0.6.1`)
  })

  it('stays quiet when the latest release is this one', async () => {
    const { updates } = setup('https://github.com/join3r/claude-project/releases/tag/v0.6.0')
    expect(await updates.check()).toMatchObject({ state: 'idle', available: null })
  })

  it('treats a repo with no releases yet as up to date', async () => {
    const { updates } = setup('https://github.com/join3r/claude-project/releases')
    expect(await updates.check()).toMatchObject({ state: 'idle', available: null, checkedAt: 1234 })
  })

  it('turns a failed lookup into an error state', async () => {
    const { updates } = setup(null)
    expect((await updates.check()).state).toBe('error')
  })

  it('joins a check already in flight', async () => {
    const { updates, probeMock } = setup('https://github.com/join3r/claude-project/releases/tag/v0.6.1')
    await Promise.all([updates.check(), updates.check()])
    expect(probeMock).toHaveBeenCalledTimes(1)
  })

  it('skips scheduled checks while the toggle is off', async () => {
    vi.useFakeTimers()
    const { updates, probeMock } = setup('https://github.com/join3r/claude-project/releases/tag/v0.6.1', {
      autoCheck: () => false
    })
    updates.start()
    await vi.advanceTimersByTimeAsync(FIRST_CHECK_DELAY_MS + 1)
    expect(probeMock).not.toHaveBeenCalled()
    updates.close()
  })

  it('never checks in dev', async () => {
    const { updates, probeMock } = setup('https://github.com/join3r/claude-project/releases/tag/v0.6.1', { mode: 'none' })
    await updates.check()
    expect(probeMock).not.toHaveBeenCalled()
  })
})

describe('autoCheckUpdates config', () => {
  it('defaults on and is accepted from the renderer', () => {
    expect(DEFAULT_CONFIG.autoCheckUpdates).toBe(true)
    expect(sanitizeConfigUpdate({ autoCheckUpdates: false }).config).toEqual({ autoCheckUpdates: false })
  })
})

describe('sign-win hook', () => {
  it('is a no-op without DEVTOOL_SIGN_CMD', () => {
    expect(signCommand('C:\\dist\\DevTool.exe', '')).toBeNull()
    expect(signCommand('C:\\dist\\DevTool.exe', undefined)).toBeNull()
  })

  it('substitutes the file path', () => {
    expect(signCommand('C:\\dist\\DevTool.exe', 'signtool sign /fd sha256 "{file}"'))
      .toBe('signtool sign /fd sha256 "C:\\dist\\DevTool.exe"')
  })

  it('refuses a command without {file}', () => {
    expect(() => signCommand('x.exe', 'signtool sign')).toThrow(/\{file\}/)
  })
})
