/**
 * The windows a host pushes to, whichever process they live in. A client id is
 * `win:<BrowserWindow id>` for a window of this desktop. Which clients mount a
 * tab is the host's own knowledge (PtySessions, ClaudeChatManager), so the hub
 * only delivers.
 */
export interface ClientHub {
  /** Send to one client; one that has gone away is skipped. */
  send(clientId: string, channel: string, ...args: unknown[]): void
  /** Send to every client. */
  broadcast(channel: string, ...args: unknown[]): void
  /** Every client there is right now. */
  clientIds(): string[]
}
