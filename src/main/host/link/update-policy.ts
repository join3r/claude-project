import type { LinkBuild } from './handshake'
import type { BundleManifest } from './bundle-archive'

/**
 * Whether a desktop uploads its server bundle to a server it just connected to
 * (protocol/SERVER.md §10). The server follows the desktop, but never backwards:
 *
 * - `server-empty`: the server has no bundle yet (the bootstrap): upload.
 * - `same`: the server runs this very bundle (same sha): nothing to do.
 * - `desktop-newer`: the shas differ and this bundle was built later: upload.
 * - `server-newer`: the server's bundle was built later (another desktop updated
 *   it): never downgrade.
 * - `no-bundle`: this desktop carries no bundle (a dev run before build:server).
 * - `source`: the server runs from a source checkout (`sha256: dev`): leave it.
 * - `unknown-age`: a build time is missing or unreadable: leave it.
 */
export type UpdateReason = 'server-empty' | 'same' | 'desktop-newer' | 'server-newer' | 'no-bundle' | 'source' | 'unknown-age'

export interface UpdateDecision {
  upload: boolean
  reason: UpdateReason
}

export function decideUpdate(desktop: BundleManifest | null, server: LinkBuild): UpdateDecision {
  if (!desktop) return { upload: false, reason: 'no-bundle' }
  if (server.bundleSha === '') return { upload: true, reason: 'server-empty' }
  if (server.bundleSha === desktop.sha256) return { upload: false, reason: 'same' }
  if (server.bundleSha === 'dev') return { upload: false, reason: 'source' }
  const ours = Date.parse(desktop.builtAt)
  const theirs = Date.parse(server.builtAt)
  if (Number.isNaN(ours) || Number.isNaN(theirs)) return { upload: false, reason: 'unknown-age' }
  return ours > theirs ? { upload: true, reason: 'desktop-newer' } : { upload: false, reason: 'server-newer' }
}

/**
 * The server's side of the same rule, for a bundle that arrives: refuse one built
 * before the bundle it runs, so two desktops of different ages can't make it flip
 * back and forth. A server from a source checkout or a fresh bootstrap takes any.
 */
export function acceptsBundle(running: { sha256: string; builtAt: string } | null, incoming: { sha256: string; builtAt: string }): { ok: true } | { ok: false; why: string } {
  if (!running || running.sha256 === '' || running.sha256 === 'dev') return { ok: true }
  const ours = Date.parse(running.builtAt)
  const theirs = Date.parse(incoming.builtAt)
  if (!Number.isNaN(ours) && !Number.isNaN(theirs) && theirs < ours) {
    return { ok: false, why: `the server runs a newer build (${running.builtAt}) than this one (${incoming.builtAt})` }
  }
  return { ok: true }
}
