// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import type { ServersState, ServerStatus } from '../src/shared/servers'
import { resetServersStateForTests } from '../src/renderer/serversState'
import { hostPlatform } from '../src/renderer/hostPlatform'
import { pastesFirstPrompt } from '../src/renderer/components/aiToolTabUtils'

function server(patch: Partial<ServerStatus> = {}): ServerStatus {
  return { id: 'srvA', name: 'box', state: 'online', pairedAt: 1, lastSeen: 2, build: null, host: null, ...patch }
}

function state(servers: ServerStatus[]): ServersState {
  return { relay: { kind: 'online' }, servers, invite: null }
}

beforeEach(() => {
  ;(window as unknown as { api: Record<string, unknown> }).api = { platform: 'win32' }
  resetServersStateForTests(state([server({ host: { os: 'darwin', arch: 'arm64', hostname: 'box', node: '24.21.0' } }), server({ id: 'srvB', host: null })]))
})

describe('the platform a project\'s processes run on', () => {
  it('is its server\'s, else this desktop\'s', () => {
    expect(hostPlatform(undefined)).toBe('win32')
    expect(hostPlatform('srvA')).toBe('darwin')
    // A server that never said is Unix all the same: none runs on Windows.
    expect(hostPlatform('srvB')).toBe('linux')
    expect(hostPlatform('unknown')).toBe('linux')
  })

  it('pastes an empty task\'s first prompt only where the agent runs on Windows', () => {
    // A Windows desktop's own agent: a .cmd shim would reinterpret the argument.
    expect(pastesFirstPrompt(hostPlatform(undefined), undefined)).toBe(true)
    // The same desktop's server project: the server's platform decides.
    expect(pastesFirstPrompt(hostPlatform('srvA'), undefined)).toBe(false)
    expect(pastesFirstPrompt('win32', { host: 'h', port: 22, username: 'u', remoteDir: '/x' })).toBe(false)
  })
})
