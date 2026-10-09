import { describe, expect, it, vi } from 'vitest'
import { createAppUrlMatcher, senderRejection, type FrameLike, type IpcEventLike } from '../src/main/ipc/sender'
import { createIpcRegistrar, type IpcMainLike } from '../src/main/ipc/registrar'
import { v } from '../src/main/ipc/validate'

const APP_URL = 'file:///Applications/DevTool.app/Contents/Resources/app.asar/out/renderer/index.html'

function mainFrame(url = APP_URL): FrameLike {
  return { url, parent: null, processId: 4, routingId: 1 }
}

/** An event from the top frame of window webContents #1 unless overridden. */
function event(overrides: { senderId?: number; frame?: FrameLike | null } = {}): IpcEventLike {
  const top = mainFrame()
  return {
    sender: { id: overrides.senderId ?? 1, mainFrame: top },
    senderFrame: overrides.frame === undefined ? top : overrides.frame
  }
}

const policy = {
  isAppWebContents: (id: number) => id === 1,
  isAppUrl: createAppUrlMatcher(undefined)
}

describe('senderRejection', () => {
  it('trusts the main frame of a DevTool window', () => {
    expect(senderRejection(event(), policy)).toBeNull()
  })

  it('refuses a <webview> guest or any other webContents', () => {
    expect(senderRejection(event({ senderId: 7 }), policy)).toMatch(/not a DevTool window/)
  })

  it('refuses subframes', () => {
    const top = mainFrame()
    const iframe: FrameLike = { url: 'https://evil.example/', parent: top, processId: 9, routingId: 3 }
    expect(senderRejection(event({ frame: iframe }), policy)).toMatch(/subframe/)
  })

  it('refuses a top-level frame that is not the window main frame', () => {
    const other: FrameLike = { url: APP_URL, parent: null, processId: 4, routingId: 99 }
    expect(senderRejection(event({ frame: other }), policy)).toMatch(/not the main frame/)
  })

  it('refuses a sender whose frame is gone', () => {
    expect(senderRejection(event({ frame: null }), policy)).toMatch(/gone/)
  })

  it('refuses a window that navigated away from the app', () => {
    const navigated = mainFrame('https://evil.example/')
    const e: IpcEventLike = { sender: { id: 1, mainFrame: navigated }, senderFrame: navigated }
    expect(senderRejection(e, policy)).toMatch(/URL is not the app/)
  })
})

describe('createAppUrlMatcher', () => {
  it('only accepts file: URLs for a packaged build', () => {
    const match = createAppUrlMatcher(undefined)
    expect(match(APP_URL)).toBe(true)
    expect(match('https://example.com/')).toBe(false)
    expect(match('not a url')).toBe(false)
  })

  it('only accepts the dev server origin in dev', () => {
    const match = createAppUrlMatcher('http://localhost:5197')
    expect(match('http://localhost:5197/')).toBe(true)
    expect(match('http://localhost:5197/index.html?x=1')).toBe(true)
    expect(match('http://localhost:5198/')).toBe(false)
    expect(match(APP_URL)).toBe(false)
  })
})

function fakeIpcMain() {
  const handles = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
  const ons = new Map<string, (event: { returnValue?: unknown } & IpcEventLike, ...args: unknown[]) => void>()
  const ipcMain = {
    handle: (channel: string, listener: (event: unknown, ...args: unknown[]) => unknown) => { handles.set(channel, listener) },
    on: (channel: string, listener: (event: { returnValue?: unknown } & IpcEventLike, ...args: unknown[]) => void) => { ons.set(channel, listener) }
  } as unknown as IpcMainLike
  return { ipcMain, handles, ons }
}

describe('createIpcRegistrar', () => {
  function setup() {
    const fake = fakeIpcMain()
    const log = vi.fn()
    const ipc = createIpcRegistrar({
      ipcMain: fake.ipcMain,
      senderPolicy: policy,
      context: (e) => ({ clientId: `win:${e.sender.id}`, isFocused: () => true }),
      log
    })
    return { ...fake, ipc, log }
  }

  it('hands the handler the caller\'s context', async () => {
    const { ipc, handles, ons } = setup()
    const handler = vi.fn((ctx: { clientId: string }) => ctx.clientId)
    ipc.handle('ch', [], handler)
    expect(await handles.get('ch')!(event())).toBe('win:1')
    const onHandler = vi.fn()
    ipc.on('pty-write', [v.string()], onHandler)
    ons.get('pty-write')!(event(), 'id')
    expect(onHandler).toHaveBeenCalledWith(expect.objectContaining({ clientId: 'win:1' }), 'id')
  })

  it('runs a handler with validated arguments for a trusted sender', async () => {
    const { ipc, handles } = setup()
    const handler = vi.fn((_e: unknown, a: string, b?: number) => `${a}:${b}`)
    const schema = [v.string(), v.optional(v.number())] as const
    ipc.handle<typeof schema>('ch', schema, handler)
    expect(await handles.get('ch')!(event(), 'x', 2)).toBe('x:2')
    expect(await handles.get('ch')!(event(), 'x')).toBe('x:undefined')
  })

  it('refuses an untrusted sender before the handler runs', () => {
    const { ipc, handles, log } = setup()
    const handler = vi.fn()
    ipc.handle('ch', [], handler)
    expect(() => handles.get('ch')!(event({ senderId: 7 }))).toThrow(/IPC ch refused/)
    expect(handler).not.toHaveBeenCalled()
    expect(log).toHaveBeenCalledWith(expect.stringContaining('ipcRefused channel=ch'))
  })

  it('refuses bad arguments before the handler runs', () => {
    const { ipc, handles } = setup()
    const handler = vi.fn()
    ipc.handle('ch', [v.string()], handler)
    expect(() => handles.get('ch')!(event(), 5)).toThrow(/ch#0/)
    expect(() => handles.get('ch')!(event(), 'a', 'b')).toThrow(/at most 1/)
    expect(handler).not.toHaveBeenCalled()
  })

  it('drops refused fire-and-forget messages without throwing', () => {
    const { ipc, ons, log } = setup()
    const handler = vi.fn()
    ipc.on('pty-write', [v.string(), v.string()], handler)
    expect(() => ons.get('pty-write')!(event({ senderId: 7 }), 'id', 'ls\n')).not.toThrow()
    expect(() => ons.get('pty-write')!(event(), 'id', 5)).not.toThrow()
    expect(handler).not.toHaveBeenCalled()
    ons.get('pty-write')!(event(), 'id', 'ls\n')
    expect(handler).toHaveBeenCalledTimes(1)
    expect(log).toHaveBeenCalledTimes(2)
  })

  it('always answers a sync message so the renderer is never left blocked', () => {
    const { ipc, ons } = setup()
    ipc.onSync('save-sync', [v.string()], () => true, false)
    const ok = event() as IpcEventLike & { returnValue?: unknown }
    ons.get('save-sync')!(ok, 'a')
    expect(ok.returnValue).toBe(true)

    const refused = event({ senderId: 7 }) as IpcEventLike & { returnValue?: unknown }
    ons.get('save-sync')!(refused, 'a')
    expect(refused.returnValue).toBe(false)

    const invalid = event() as IpcEventLike & { returnValue?: unknown }
    ons.get('save-sync')!(invalid, 1)
    expect(invalid.returnValue).toBe(false)
  })
})
