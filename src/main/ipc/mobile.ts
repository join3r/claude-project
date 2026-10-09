import type { MobilePairingInvite, MobileState } from '../../shared/mobile'
import type { IpcRegistrar } from './registrar'
import { relayUrl } from './config-sanitize'
import { safeId } from './schemas'
import { v } from './validate'

/** The part of MobileService the IPC surface drives. */
export interface MobileControl {
  getState(): MobileState
  setEnabled(enabled: boolean): void
  setRelayUrl(url: string): void
  startPairing(): Promise<MobilePairingInvite>
  cancelPairing(): void
  accept(phoneId: string): void
  reject(phoneId: string): void
  revoke(phoneId: string): void
}

/** Device IDs are 32 lowercase hex characters (SPEC.md §1). */
const deviceId = v.string({ pattern: /^[0-9a-f]{32}$/, patternName: 'a device id' })

/**
 * Settings → Mobile. Every change answers with the new state as well as
 * broadcasting it (`mobile-state-changed`), so the window that clicked does
 * not have to wait for the broadcast.
 */
export function registerMobileHandlers(ipc: IpcRegistrar, deps: { mobile: () => MobileControl }): void {
  ipc.handle('mobile-get-state', [], () => deps.mobile().getState())
  ipc.handle('mobile-set-enabled', [v.boolean()], (_event, enabled) => {
    deps.mobile().setEnabled(enabled)
    return deps.mobile().getState()
  })
  ipc.handle('mobile-set-relay-url', [relayUrl], (_event, url) => {
    deps.mobile().setRelayUrl(url)
    return deps.mobile().getState()
  })
  ipc.handle('mobile-start-pairing', [], () => deps.mobile().startPairing())
  ipc.handle('mobile-cancel-pairing', [], () => {
    deps.mobile().cancelPairing()
    return deps.mobile().getState()
  })
  ipc.handle('mobile-accept', [deviceId], (_event, phoneId) => {
    deps.mobile().accept(phoneId)
    return deps.mobile().getState()
  })
  ipc.handle('mobile-reject', [deviceId], (_event, phoneId) => {
    deps.mobile().reject(phoneId)
    return deps.mobile().getState()
  })
  ipc.handle('mobile-revoke', [deviceId], (_event, phoneId) => {
    deps.mobile().revoke(phoneId)
    return deps.mobile().getState()
  })
}

/**
 * A host's phones, named by host (plan step 10): a desktop's Settings › Servers ›
 * Pair a phone drives a server's phones through these, routed by the first
 * argument (`local` or a server id), which is ignored here as for
 * `server-list-dirs`. Each change answers with the new state, which the host
 * also pushes (`server-mobile-state-changed` on a server).
 */
export function registerHostMobileHandlers(ipc: IpcRegistrar, deps: { mobile: () => MobileControl }): void {
  ipc.handle('server-mobile-get-state', [safeId], () => deps.mobile().getState())
  ipc.handle('server-mobile-start-pairing', [safeId], () => deps.mobile().startPairing())
  ipc.handle('server-mobile-cancel-pairing', [safeId], () => {
    deps.mobile().cancelPairing()
    return deps.mobile().getState()
  })
  ipc.handle('server-mobile-accept', [safeId, deviceId], (_event, _host, phoneId) => {
    deps.mobile().accept(phoneId)
    return deps.mobile().getState()
  })
  ipc.handle('server-mobile-reject', [safeId, deviceId], (_event, _host, phoneId) => {
    deps.mobile().reject(phoneId)
    return deps.mobile().getState()
  })
  ipc.handle('server-mobile-revoke', [safeId, deviceId], (_event, _host, phoneId) => {
    deps.mobile().revoke(phoneId)
    return deps.mobile().getState()
  })
}
