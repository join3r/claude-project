import type { ClientHub } from './host/client-hub'
import { safeWebContentsSend, type SendableWindow } from './safe-ipc-send'

/** A local window's client id. */
export function windowClientId(windowId: number): string {
  return `win:${windowId}`
}

/** The part of a BrowserWindow the hub uses — a fake in tests. */
export interface ClientWindow extends SendableWindow {
  id: number
  webContents: {
    id: number
    isDestroyed: () => boolean
    send: (channel: string, ...args: unknown[]) => void
  }
}

/** {@link ClientHub} over this desktop's own windows, by `win:<BrowserWindow id>`. */
export class WindowClientHub<W extends ClientWindow> implements ClientHub {
  private readonly windows = new Map<string, W>()

  /** Starts delivering to `window`; returns its client id. */
  add(window: W): string {
    const clientId = windowClientId(window.id)
    this.windows.set(clientId, window)
    return clientId
  }

  remove(clientId: string): void {
    this.windows.delete(clientId)
  }

  get(clientId: string): W | undefined {
    return this.windows.get(clientId)
  }

  /** The live window whose webContents is `webContentsId`, when it is one of ours. */
  forWebContents(webContentsId: number): W | null {
    for (const window of this.windows.values()) {
      if (!window.isDestroyed() && window.webContents.id === webContentsId) return window
    }
    return null
  }

  send(clientId: string, channel: string, ...args: unknown[]): void {
    const window = this.windows.get(clientId)
    if (window) safeWebContentsSend(window, channel, ...args)
  }

  broadcast(channel: string, ...args: unknown[]): void {
    for (const window of this.windows.values()) {
      safeWebContentsSend(window, channel, ...args)
    }
  }

  clientIds(): string[] {
    return [...this.windows.keys()]
  }
}
