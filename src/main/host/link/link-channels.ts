/**
 * Link-level calls and events (protocol/SERVER.md §5.1): the server itself, not its
 * host channels. A desktop calls them as the client `hub`; the server answers them
 * before the registry, so they never reach a window's IPC handlers.
 */
export const LinkChannel = {
  /** → `{ code, expiresAt }`: a pairing code for another desktop. */
  PairCode: 'server-pair-code'
} as const

/** The client id a desktop's hub calls link-level channels as. */
export const HUB_CLIENT = 'hub'
