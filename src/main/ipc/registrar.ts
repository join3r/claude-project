import { senderRejection, type IpcEventLike, type SenderPolicy } from './sender'
import { validateArgs, type ArgsOf, type Validator } from './validate'

/** An IPC event as the registrar reads it, plus the `returnValue` a `sendSync` answer is set on. */
export type IpcMainEventLike = IpcEventLike & { returnValue?: unknown }

/** The part of `ipcMain` the registrar uses — a fake in tests. */
export interface IpcMainLike {
  handle(channel: string, listener: (event: IpcEventLike, ...args: unknown[]) => unknown): void
  on(channel: string, listener: (event: IpcMainEventLike, ...args: unknown[]) => void): void
}

/**
 * Who made a call, as a handler sees it. The registrar's owner works it out
 * from the transport (an Electron window's webContents on the desktop), so the
 * handlers themselves never touch Electron.
 */
export interface IpcContext {
  /** The calling client: `win:<BrowserWindow id>` for a local window. */
  clientId: string
  /** Whether the caller's window has focus right now. */
  isFocused(): boolean
}

type Schema = readonly Validator<unknown>[]

/**
 * Every IPC handler goes through here: the sender is checked first, then each
 * positional argument against its validator, and only then does the handler run
 * — with the caller's context and arguments typed from the schema rather than
 * trusted from the preload.
 */
export interface IpcRegistrar<C extends IpcContext = IpcContext> {
  /** `ipcMain.handle`: a refused sender or bad argument rejects the renderer's promise. */
  handle<const A extends Schema>(
    channel: string,
    schema: A,
    handler: (ctx: C, ...args: ArgsOf<A>) => unknown
  ): void
  /** `ipcMain.on` (fire-and-forget): a refused call is logged and dropped. */
  on<const A extends Schema>(
    channel: string,
    schema: A,
    handler: (ctx: C, ...args: ArgsOf<A>) => void
  ): void
  /**
   * `ipcMain.on` answering `sendSync`: the handler's return value becomes
   * `event.returnValue`; a refused call answers `fallback` so the renderer is
   * never left blocked. Local windows only: nothing else can block on an answer.
   */
  onSync<const A extends Schema>(
    channel: string,
    schema: A,
    handler: (ctx: C, ...args: ArgsOf<A>) => unknown,
    fallback: unknown
  ): void
}

export interface RegistrarOptions<C extends IpcContext> {
  ipcMain: IpcMainLike
  senderPolicy: SenderPolicy
  /** The context of a call whose sender passed the policy; throws when it has none. */
  context: (event: IpcEventLike) => C
  log: (message: string) => void
}

export class IpcSenderError extends Error {
  constructor(channel: string, reason: string) {
    super(`IPC ${channel} refused: ${reason}`)
    this.name = 'IpcSenderError'
  }
}

export function createIpcRegistrar<C extends IpcContext>({ ipcMain, senderPolicy, context, log }: RegistrarOptions<C>): IpcRegistrar<C> {
  const check = (channel: string, event: IpcEventLike): C => {
    const reason = senderRejection(event, senderPolicy)
    if (reason) throw new IpcSenderError(channel, reason)
    return context(event)
  }

  const describe = (err: unknown): string => (err instanceof Error ? err.message : String(err))

  return {
    handle(channel, schema, handler) {
      ipcMain.handle(channel, (event, ...raw) => {
        try {
          const ctx = check(channel, event)
          const args = validateArgs(channel, schema, raw)
          return handler(ctx, ...args)
        } catch (err) {
          log(`ipcRefused channel=${channel} error=${describe(err)}`)
          throw err
        }
      })
    },

    on(channel, schema, handler) {
      ipcMain.on(channel, (event, ...raw) => {
        let ctx: C
        let args: ArgsOf<typeof schema>
        try {
          ctx = check(channel, event)
          args = validateArgs(channel, schema, raw)
        } catch (err) {
          log(`ipcRefused channel=${channel} error=${describe(err)}`)
          return
        }
        handler(ctx, ...args)
      })
    },

    onSync(channel, schema, handler, fallback) {
      ipcMain.on(channel, (event, ...raw) => {
        let ctx: C
        let args: ArgsOf<typeof schema>
        try {
          ctx = check(channel, event)
          args = validateArgs(channel, schema, raw)
        } catch (err) {
          log(`ipcRefused channel=${channel} error=${describe(err)}`)
          event.returnValue = fallback
          return
        }
        try {
          event.returnValue = handler(ctx, ...args)
        } catch (err) {
          log(`ipcFailed channel=${channel} error=${describe(err)}`)
          event.returnValue = fallback
        }
      })
    }
  }
}
