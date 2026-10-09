/** Why a link call, stream or session failed (protocol/SERVER.md §5). */
export const LinkErrorCode = {
  /** The server isn't connected (offline, still handshaking, or the link dropped). */
  ServerOffline: 'server-offline',
  /** A message would pass the 4 MiB limit; large payloads go through a stream. */
  TooLarge: 'too-large',
  /** The server's handler threw or refused the call; `message` is its error. */
  Remote: 'remote-error',
  /** The peer doesn't serve this channel or stream kind. */
  Unsupported: 'unsupported',
  /** The peer refused to open a stream. */
  Refused: 'refused',
  /** The peer aborted a stream. */
  Aborted: 'aborted',
  /** The peer broke the protocol (a stream overran its credit, a bad message). */
  Protocol: 'protocol-error'
} as const

export type LinkErrorCodeValue = (typeof LinkErrorCode)[keyof typeof LinkErrorCode] | (string & {})

export class LinkError extends Error {
  constructor(readonly code: LinkErrorCodeValue, message: string) {
    super(message)
    this.name = 'LinkError'
  }
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
