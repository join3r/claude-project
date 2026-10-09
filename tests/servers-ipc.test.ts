import { describe, expect, it } from 'vitest'
import { ClientRegistry } from '../src/server/client-registry'
import { registerServerHandlers, type ServersControl } from '../src/main/ipc/servers'

/** The servers IPC surface 5b builds on, through a real registrar and its argument checks. */
describe('servers IPC', () => {
  function setup() {
    const calls: unknown[][] = []
    const status = { id: 'a'.repeat(32), name: 'box', state: 'online' as const, pairedAt: 1, lastSeen: 1, build: null, host: null }
    const control: ServersControl = {
      getState: () => ({ relay: { kind: 'online' }, servers: [status], invite: null }),
      createInvite: () => ({ oneLiner: 'curl ... | sh -s -- T', token: 'T', expiresAt: 5 }),
      cancelInvite: () => { calls.push(['cancel']) },
      pairWithCode: async (code) => { calls.push(['pair', code]); return status },
      rename: (id, name) => { calls.push(['rename', id, name]); return { ...status, name } },
      remove: async (id, options) => { calls.push(['remove', id, options]); return { uninstalled: !!options?.uninstall } },
      restartServer: async (id) => { calls.push(['restart', id]) },
      deviceCode: async (id) => { calls.push(['device-code', id]); return { code: 'C', expiresAt: 9 } },
      updateServer: async (id) => { calls.push(['update', id]); return { upload: false, reason: 'same' } }
    }
    const registry = new ClientRegistry({ onClientGone: () => {}, log: () => {} })
    registerServerHandlers(registry.createRegistrar(() => {}), { servers: () => control })
    registry.registerClient('win:1', () => {})
    return { calls, call: (ch: string, ...args: unknown[]) => registry.call('win:1', ch, args) }
  }

  it('creates and cancels invites, pairs with a code, and manages servers', async () => {
    const { calls, call } = setup()
    const id = 'a'.repeat(32)
    await expect(call('servers-create-invite')).resolves.toEqual({ oneLiner: 'curl ... | sh -s -- T', token: 'T', expiresAt: 5 })
    await expect(call('servers-cancel-invite')).resolves.toMatchObject({ invite: null })
    await expect(call('servers-pair-code', 'CODE')).resolves.toMatchObject({ id })
    await expect(call('servers-rename', id, 'new name')).resolves.toMatchObject({ name: 'new name' })
    await expect(call('servers-remove', id, { uninstall: true, extra: 1 })).resolves.toEqual({ uninstalled: true })
    await expect(call('servers-remove', id)).resolves.toEqual({ uninstalled: false })
    await call('servers-restart', id)
    await expect(call('servers-device-code', id)).resolves.toEqual({ code: 'C', expiresAt: 9 })
    await expect(call('servers-update', id)).resolves.toEqual({ upload: false, reason: 'same' })
    expect(calls).toEqual([
      ['cancel'], ['pair', 'CODE'], ['rename', id, 'new name'], ['remove', id, { uninstall: true }], ['remove', id, {}],
      ['restart', id], ['device-code', id], ['update', id]
    ])
  })

  it('refuses bad arguments before reaching the hub', async () => {
    const { calls, call } = setup()
    await expect(call('servers-rename', 'not-an-id', 'x')).rejects.toThrow(/server id/)
    await expect(call('servers-pair-code', '')).rejects.toThrow()
    await expect(call('servers-remove', 'a'.repeat(32), { uninstall: 'yes' })).rejects.toThrow(/boolean/)
    expect(calls).toEqual([])
  })
})
