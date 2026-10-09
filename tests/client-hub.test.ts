import { describe, expect, it, vi } from 'vitest'
import { WindowClientHub, windowClientId, type ClientWindow } from '../src/main/window-client-hub'
import { PtySessions } from '../src/main/pty-sessions'
import { TabActivityRegistry } from '../src/main/tab-activity-registry'
import type { PtyManager } from '../src/main/pty-manager'
import type { ScrollbackStorage } from '../src/main/scrollback-storage'
import type { AppConfig } from '../src/shared/types'

function fakeWindow(id: number, webContentsId = id + 100) {
  const sent: unknown[][] = []
  let destroyed = false
  const window: ClientWindow & { sent: unknown[][]; destroy(): void } = {
    id,
    sent,
    isDestroyed: () => destroyed,
    destroy: () => { destroyed = true },
    webContents: {
      id: webContentsId,
      isDestroyed: () => destroyed,
      send: (channel, ...args) => { sent.push([channel, ...args]) }
    }
  }
  return window
}

describe('WindowClientHub', () => {
  it('names local windows win:<id> and sends to one, or to all', () => {
    const hub = new WindowClientHub<ReturnType<typeof fakeWindow>>()
    const a = fakeWindow(1)
    const b = fakeWindow(2)
    expect(hub.add(a)).toBe('win:1')
    expect(hub.add(b)).toBe(windowClientId(2))
    expect(hub.clientIds()).toEqual(['win:1', 'win:2'])

    hub.send('win:2', 'pty-data', 't1', 'hi')
    expect(a.sent).toEqual([])
    expect(b.sent).toEqual([['pty-data', 't1', 'hi']])

    hub.broadcast('config-updated', { x: 1 })
    expect(a.sent).toEqual([['config-updated', { x: 1 }]])
    expect(b.sent).toHaveLength(2)
  })

  it('skips gone and destroyed windows', () => {
    const hub = new WindowClientHub<ReturnType<typeof fakeWindow>>()
    const a = fakeWindow(1)
    const b = fakeWindow(2)
    hub.add(a)
    hub.add(b)
    hub.remove('win:1')
    b.destroy()
    hub.send('win:1', 'x')
    hub.broadcast('y')
    hub.send('win:9', 'z')
    expect(a.sent).toEqual([])
    expect(b.sent).toEqual([])
  })

  it('finds a live window by its webContents id', () => {
    const hub = new WindowClientHub<ReturnType<typeof fakeWindow>>()
    const a = fakeWindow(1, 41)
    const b = fakeWindow(2, 42)
    hub.add(a)
    hub.add(b)
    expect(hub.forWebContents(42)).toBe(b)
    expect(hub.forWebContents(7)).toBeNull()
    b.destroy()
    expect(hub.forWebContents(42)).toBeNull()
  })
})

describe('PtySessions client routing', () => {
  function setup() {
    const callbacks = new Map<string, { onData?: (data: string) => void; onExit?: (code: number) => void }>()
    const ptyManager = {
      spawn: vi.fn((id: string, _shell: string, _cwd: string, _cols: number, _rows: number, _args?: string[], _env?: unknown,
        cbs?: { onData?: (data: string) => void; onExit?: (code: number) => void }) => { callbacks.set(id, cbs ?? {}) }),
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
      killAll: vi.fn(),
      pause: vi.fn(),
      resume: vi.fn()
    }
    const scrollback = { save: vi.fn(), load: () => null, delete: vi.fn() }
    const sent: [string, string, ...unknown[]][] = []
    const sessions = new PtySessions({
      ptyManager: ptyManager as unknown as PtyManager,
      scrollbackStorage: scrollback as unknown as ScrollbackStorage,
      activityRegistry: new TabActivityRegistry(),
      sshManager: () => { throw new Error('no ssh in this test') },
      hookInjector: () => { throw new Error('no hooks in this test') },
      hookPort: () => 0,
      hookToken: () => '',
      getConfig: () => ({}) as AppConfig,
      broadcastAgentActivity: () => {},
      sendToClient: (clientId, channel, ...args) => { sent.push([clientId, channel, ...args]) },
      log: () => {},
      piExtensionPath: () => '/app/pi-status-extension.mjs'
    })
    const spawn = (clientId: string) => sessions.attachOrCreate(clientId, {
      id: 't1', shell: '/bin/sh', cwd: '/tmp', cols: 80, rows: 24, args: ['-c', 'true']
    })
    return { sessions, ptyManager, callbacks, sent, spawn }
  }

  it('sends output to every attached client and only takes input from them', () => {
    const { sessions, ptyManager, callbacks, sent, spawn } = setup()
    spawn('win:1')
    spawn('win:2')
    expect(ptyManager.spawn).toHaveBeenCalledTimes(1)
    expect([...sessions.attachedClients('t1')!]).toEqual(['win:1', 'win:2'])

    callbacks.get('t1')!.onData!('hello')
    expect(sent).toEqual([['win:1', 'pty-data', 't1', 'hello'], ['win:2', 'pty-data', 't1', 'hello']])

    sessions.write('win:3', 't1', 'ignored')
    sessions.write('win:2', 't1', 'ls\n')
    expect(ptyManager.write).toHaveBeenCalledTimes(1)
    expect(ptyManager.write).toHaveBeenCalledWith('t1', 'ls\n')
  })

  it('hands control on when the controlling client goes away', () => {
    const { sessions, ptyManager, callbacks, sent, spawn } = setup()
    spawn('win:1')
    spawn('win:2')
    sessions.write('win:2', 't1', 'x')

    // win:2 controls the size now: an unfocused win:1 can't resize.
    sessions.resize('win:1', false, 't1', 100, 30)
    expect(ptyManager.resize).not.toHaveBeenCalled()

    sessions.detachClient('win:2')
    expect([...sessions.attachedClients('t1')!]).toEqual(['win:1'])
    sessions.resize('win:1', false, 't1', 100, 30)
    expect(ptyManager.resize).toHaveBeenCalledWith('t1', 100, 30)

    sent.length = 0
    callbacks.get('t1')!.onData!('more')
    expect(sent).toEqual([['win:1', 'pty-data', 't1', 'more']])
  })

  it('pauses a PTY while any link holds its output back, and resumes when the last lets go', () => {
    const { sessions, ptyManager, callbacks, spawn } = setup()
    spawn('link:d1:win:1')
    expect(sessions.holdOutput('t1', 'link:d1')).toBe(true)
    expect(sessions.holdOutput('t1', 'link:d1')).toBe(true)
    expect(sessions.holdOutput('t1', 'link:d2')).toBe(true)
    expect(ptyManager.pause).toHaveBeenCalledTimes(1)
    expect(sessions.heldBy('link:d1')).toEqual(['t1'])
    sessions.releaseOutput('t1', 'link:d1')
    expect(ptyManager.resume).not.toHaveBeenCalled()
    sessions.releaseOutput('t1', 'link:d2')
    expect(ptyManager.resume).toHaveBeenCalledWith('t1')
    expect(sessions.heldBy('link:d2')).toEqual([])
    // Nothing to hold: no tab, or one whose process exited.
    expect(sessions.holdOutput('nope', 'link:d1')).toBe(false)
    callbacks.get('t1')!.onExit!(0)
    expect(sessions.holdOutput('t1', 'link:d1')).toBe(false)
  })
})
