/**
 * Link-level calls and events (protocol/SERVER.md §5.1): the server itself, not its
 * host channels. A desktop calls them as the client `hub`; the server answers them
 * before the registry, so they never reach a window's IPC handlers.
 */
export const LinkChannel = {
  /** → `{ code, expiresAt }`: a pairing code for another desktop. */
  PairCode: 'server-pair-code',
  /** → {@link ServerInfo}. */
  Info: 'server-info',
  /** `[]` → `{ restarting: true }`: switch to a staged bundle (if any) and restart now, working tabs or not. */
  Restart: 'server-restart',
  /** `[{ deleteData?: boolean }]` → `{ ok: true }`: stop and remove the service, then the files. */
  Uninstall: 'server-uninstall',
  /** Bootstrap only: `[{ uploaded: boolean }]` → `{ ok: true }`: the desktop is done; install the service. */
  BootstrapDone: 'server-bootstrap-done'
} as const

/** Link-level events, pushed to `*`. */
export const LinkEvent = {
  /** `[ServerInfo]` whenever its update state changes. */
  Status: 'server-status'
} as const

/** The update a server holds: `staged` waits for its tabs to go idle; `restarting` is switching now. */
export interface ServerUpdateState {
  state: 'staged' | 'restarting'
  version: string
  commit: string
  builtAt: string
}

/** `server-info`'s answer and `server-status`'s payload. */
export interface ServerInfo {
  update: ServerUpdateState | null
}

/** The client id a desktop's hub calls link-level channels as. */
export const HUB_CLIENT = 'hub'
