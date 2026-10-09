import { describe, expect, it } from 'vitest'
import type { ServerStatus, ServersState } from '../src/shared/servers'
import { canStall, installProgress, pairedServerId, phaseText } from '../src/renderer/components/servers/addServerFlow'

const ID = 'a'.repeat(32)
const NOW = 1_000_000
const invite = (over: Partial<NonNullable<ServersState['invite']>> = {}): NonNullable<ServersState['invite']> =>
  ({ oneLiner: 'curl … | DEVTOOL_TOKEN=T sh', token: 'T', expiresAt: NOW + 900_000, status: 'waiting', ...over })
const server = (over: Partial<ServerStatus> = {}): ServerStatus =>
  ({ id: ID, name: 'box', state: 'connecting', pairedAt: NOW, lastSeen: NOW, build: null, host: null, ...over })
const state = (over: Partial<ServersState> = {}): ServersState => ({ relay: { kind: 'online' }, servers: [], invite: invite(), ...over })

describe('Add server progress', () => {
  it('walks waiting, connecting, installing with the upload, starting the service, connected', () => {
    const at = (s: ServersState, serverId: string | null = null) => installProgress({ state: s, serverId, inviteExpiresAt: NOW + 900_000, now: NOW })
    expect(at(state())).toMatchObject({ phase: 'waiting', step: 0 })

    // The installer paired: the invite names the server, which the dialog then follows.
    const paired = state({ invite: invite({ status: 'paired', serverId: ID }), servers: [server()] })
    const followed = pairedServerId(null, paired)
    expect(followed).toBe(ID)
    expect(at(paired, followed)).toMatchObject({ phase: 'connecting', step: 1 })

    const uploading = state({ servers: [server({ state: 'online', installing: true, upload: { sent: 1024, total: 4096 } })] })
    expect(at(uploading, ID)).toMatchObject({ phase: 'installing', step: 2, fraction: 0.25 })
    expect(phaseText(at(uploading, ID)).title).toBe('Installing DevTool on box… 25%')
    expect(at(state({ servers: [server({ state: 'online', installing: true })] }), ID)).toMatchObject({ phase: 'installing', step: 2 })

    // The installer leaves to set up the service: offline, but still installing. Not connected yet.
    expect(at(state({ servers: [server({ state: 'offline', installing: true })] }), ID)).toMatchObject({ phase: 'starting', step: 2 })
    expect(at(state({ servers: [server({ state: 'connecting', installing: true })] }), ID)).toMatchObject({ phase: 'starting' })

    const done = at(state({ invite: null, servers: [server({ state: 'online', host: { os: 'linux', arch: 'arm64', hostname: 'devbox', node: '24.21.0' } })] }), ID)
    expect(done).toMatchObject({ phase: 'connected', step: 3 })
    expect(phaseText(done).title).toBe('Connected to devbox')
  })

  it('keeps following the server once the invite lapses', () => {
    expect(pairedServerId(ID, state({ invite: null }))).toBe(ID)
    expect(pairedServerId(null, state())).toBeNull()
    // Paired but not listed yet: still connecting, never back to "waiting".
    expect(installProgress({ state: state({ invite: null }), serverId: ID, inviteExpiresAt: NOW + 1, now: NOW })).toMatchObject({ phase: 'connecting' })
  })

  it('tells an expired command from one a phone QR replaced', () => {
    // The invite timed out (main drops it at expiry).
    expect(installProgress({ state: state({ invite: null }), serverId: null, inviteExpiresAt: NOW - 1, now: NOW })).toMatchObject({ phase: 'expired' })
    // Still in state but past its time.
    expect(installProgress({ state: state({ invite: invite({ expiresAt: NOW }) }), serverId: null, inviteExpiresAt: NOW, now: NOW })).toMatchObject({ phase: 'expired' })
    // Gone before its time: a phone pairing code took the relay's one offer slot.
    const lost = installProgress({ state: state({ invite: null }), serverId: null, inviteExpiresAt: NOW + 60_000, now: NOW })
    expect(lost).toMatchObject({ phase: 'lost' })
    expect(phaseText(lost).detail).toMatch(/phone pairing code/)
  })

  it('reports the relay first while nothing paired', () => {
    const at = (relay: ServersState['relay']) => installProgress({ state: state({ relay }), serverId: null, inviteExpiresAt: NOW + 1000, now: NOW }).phase
    expect(at({ kind: 'connecting' })).toBe('relay-connecting')
    expect(at({ kind: 'offline', error: 'ECONNREFUSED' })).toBe('relay-offline')
    expect(at({ kind: 'too-old', error: 'This relay is too old for servers' })).toBe('relay-too-old')
    const offline = installProgress({ state: state({ relay: { kind: 'offline', error: 'ECONNREFUSED' } }), serverId: null, inviteExpiresAt: NOW + 1000, now: NOW })
    expect(phaseText(offline, { url: 'ws://10.0.0.2:8787', error: 'ECONNREFUSED' }).detail).toBe("DevTool can't connect to ws://10.0.0.2:8787 (ECONNREFUSED). Check the address in Settings, Relay.")
  })

  it('says what is wrong with a server that refuses or can not talk to this version', () => {
    const at = (s: ServerStatus) => installProgress({ state: state({ servers: [s] }), serverId: ID, inviteExpiresAt: null, now: NOW })
    expect(at(server({ state: 'incompatible', update: 'desktop' }))).toMatchObject({ phase: 'incompatible' })
    expect(phaseText(at(server({ state: 'incompatible', update: 'desktop' }))).detail).toMatch(/Update DevTool on this computer/)
    expect(at(server({ state: 'offline', problem: 'revoked', error: 'The server removed this desktop' }))).toMatchObject({ phase: 'refused' })
    expect(at(server({ state: 'updating' }))).toMatchObject({ phase: 'starting' })
  })

  it('only the quiet phases can stall', () => {
    expect(['waiting', 'connecting', 'starting'].every(p => canStall(p as never))).toBe(true)
    expect(['installing', 'connected', 'expired', 'relay-offline'].some(p => canStall(p as never))).toBe(false)
  })
})
