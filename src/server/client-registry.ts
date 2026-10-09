import type { ClientHub } from '../main/host/client-hub'
import { createIpcRegistrar, type IpcContext, type IpcMainEventLike, type IpcMainLike, type IpcRegistrar } from '../main/ipc/registrar'
import type { IpcEventLike, SenderPolicy } from '../main/ipc/sender'

/**
 * Where a client's pushes go: the channel and its arguments, as a window's
 * `ipcRenderer.on` would get them. Must not throw; a throw is logged and dropped.
 */
export type ClientSink = (channel: string, args: unknown[]) => void

export interface ClientOptions {
  /** Whether the client's window has focus: `pty-resize` from an unfocused one only applies while it controls the PTY. */
  isFocused?: () => boolean
  /**
   * A broadcast group (one per linked desktop): while the group has a sink
   * ({@link ClientRegistry.registerGroup}), broadcasts reach its clients once,
   * through that sink, instead of once per client.
   */
  group?: string
}

export interface ClientRegistryOptions {
  /** A client was unregistered: the host lets go of what it held for it (`HostServices.detachClient`). */
  onClientGone?: (clientId: string) => void
  log?: (message: string) => void
}

type Listener = (event: IpcMainEventLike, ...args: unknown[]) => unknown

interface Client {
  /** Stands in for a webContents id in the calls' events. */
  handle: number
  sink: ClientSink
  isFocused: () => boolean
  group?: string
}

/** The frame URL of every call made through {@link ClientRegistry.call}; the sender policy accepts only it. */
const CLIENT_FRAME_URL = 'devtool-server:client'

/**
 * The server's clients and the host's IPC handlers, without Electron: the seam a
 * transport (the host link, an in-process test) plugs into.
 *
 * - As {@link IpcMainLike} it stores the handlers `HostServices.registerIpcHandlers`
 *   registers through {@link createRegistrar}.
 * - {@link call} runs one of them as a client, the way a window's `invoke`/`send`
 *   reaches `ipcMain`.
 * - As {@link ClientHub} it delivers the host's `send`/`broadcast` to the sinks of
 *   the registered clients.
 *
 * Arguments, results and pushes are structured-cloned, as Electron's IPC does, so
 * an in-process caller never shares objects with the host.
 */
export class ClientRegistry implements ClientHub, IpcMainLike {
  private readonly handlers = new Map<string, Listener>()
  private readonly listeners = new Map<string, Listener>()
  private readonly clients = new Map<string, Client>()
  private readonly groups = new Map<string, ClientSink>()
  private readonly byHandle = new Map<number, string>()
  private nextHandle = 1
  private readonly onClientGone: (clientId: string) => void
  private readonly log: (message: string) => void

  constructor(options: ClientRegistryOptions = {}) {
    this.onClientGone = options.onClientGone ?? (() => {})
    this.log = options.log ?? (() => {})
  }

  // --- Clients -------------------------------------------------------------

  /** From now on `clientId` may call channels and gets the pushes meant for it, through `sink`. */
  registerClient(clientId: string, sink: ClientSink, options: ClientOptions = {}): void {
    if (this.clients.has(clientId)) throw new Error(`Client ${clientId} is already registered`)
    const handle = this.nextHandle++
    this.clients.set(clientId, { handle, sink, isFocused: options.isFocused ?? (() => false), ...(options.group ? { group: options.group } : {}) })
    this.byHandle.set(handle, clientId)
    this.log(`clientRegistered clientId=${clientId}`)
  }

  /** The client is gone: its calls are refused from now on, and the host detaches it from its tabs. */
  unregisterClient(clientId: string): void {
    const client = this.clients.get(clientId)
    if (!client) return
    this.clients.delete(clientId)
    this.byHandle.delete(client.handle)
    this.log(`clientUnregistered clientId=${clientId}`)
    this.onClientGone(clientId)
  }

  hasClient(clientId: string): boolean {
    return this.clients.has(clientId)
  }

  /**
   * Broadcasts for `group` go to `sink`, once, from now on, whether or not the
   * group has clients yet (a linked desktop hears them before its first call).
   */
  registerGroup(group: string, sink: ClientSink): void {
    if (this.groups.has(group)) throw new Error(`Group ${group} is already registered`)
    this.groups.set(group, sink)
  }

  /** Unregisters the group's sink and every client in it. */
  unregisterGroup(group: string): void {
    for (const [clientId, client] of [...this.clients]) {
      if (client.group === group) this.unregisterClient(clientId)
    }
    this.groups.delete(group)
  }

  /**
   * Run `channel` as `clientId`. An `invoke` channel resolves its handler's result
   * and rejects when the registrar refuses the call (an unregistered client, a bad
   * argument) or the handler throws. A `send` channel resolves `undefined` once it
   * ran (a refused one is logged and dropped, as with a window); a `sendSync` one
   * resolves its answer.
   */
  async call(clientId: string, channel: string, args: readonly unknown[] = []): Promise<unknown> {
    const handler = this.handlers.get(channel)
    const listener = handler ? undefined : this.listeners.get(channel)
    if (!handler && !listener) throw new Error(`No handler for ${channel}`)
    const event = this.eventFor(clientId)
    const copied = structuredClone([...args])
    if (handler) return structuredClone(await handler(event, ...copied))
    listener!(event, ...copied)
    return structuredClone(event.returnValue)
  }

  // --- ClientHub -----------------------------------------------------------

  send(clientId: string, channel: string, ...args: unknown[]): void {
    const client = this.clients.get(clientId)
    if (client) this.deliver(clientId, client, channel, structuredClone(args))
  }

  broadcast(channel: string, ...args: unknown[]): void {
    for (const [group, sink] of [...this.groups]) this.deliverTo(`group ${group}`, sink, channel, structuredClone(args))
    for (const [clientId, client] of [...this.clients]) {
      if (client.group && this.groups.has(client.group)) continue
      this.deliver(clientId, client, channel, structuredClone(args))
    }
  }

  clientIds(): string[] {
    return [...this.clients.keys()]
  }

  // --- IpcMainLike ---------------------------------------------------------

  handle(channel: string, listener: (event: IpcEventLike, ...args: unknown[]) => unknown): void {
    this.claim(channel)
    this.handlers.set(channel, listener)
  }

  on(channel: string, listener: (event: IpcMainEventLike, ...args: unknown[]) => void): void {
    this.claim(channel)
    this.listeners.set(channel, listener)
  }

  /** Every channel a handler is registered for. */
  channels(): string[] {
    return [...this.handlers.keys(), ...this.listeners.keys()]
  }

  /** The registrar `HostServices.registerIpcHandlers` takes: only registered clients get through. */
  createRegistrar(log: (message: string) => void = this.log): IpcRegistrar {
    return createIpcRegistrar<IpcContext>({
      ipcMain: this,
      senderPolicy: this.senderPolicy(),
      context: (event) => this.contextOf(event),
      log
    })
  }

  private senderPolicy(): SenderPolicy {
    return {
      isAppWebContents: (handle) => this.byHandle.has(handle),
      isAppUrl: (url) => url === CLIENT_FRAME_URL
    }
  }

  private contextOf(event: IpcEventLike): IpcContext {
    const clientId = this.byHandle.get(event.sender.id)
    const client = clientId ? this.clients.get(clientId) : undefined
    if (!clientId || !client) throw new Error('sender is not a registered client')
    return { clientId, isFocused: () => client.isFocused() }
  }

  /** The event a call arrives with; an unknown client gets handle 0, which the sender policy refuses. */
  private eventFor(clientId: string): IpcMainEventLike {
    const handle = this.clients.get(clientId)?.handle ?? 0
    const frame = { url: CLIENT_FRAME_URL, parent: null }
    return { sender: { id: handle, mainFrame: frame }, senderFrame: frame }
  }

  private claim(channel: string): void {
    if (this.handlers.has(channel) || this.listeners.has(channel)) {
      throw new Error(`A handler for ${channel} is already registered`)
    }
  }

  private deliver(clientId: string, client: Client, channel: string, args: unknown[]): void {
    this.deliverTo(`clientId=${clientId}`, client.sink, channel, args)
  }

  private deliverTo(who: string, sink: ClientSink, channel: string, args: unknown[]): void {
    try {
      sink(channel, args)
    } catch (err) {
      this.log(`clientSendFailed ${who} channel=${channel} error=${err instanceof Error ? err.message : String(err)}`)
    }
  }
}
