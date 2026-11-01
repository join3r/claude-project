import { protocol, session } from 'electron'
import {
  ARTIFACT_COPY_PARTITION,
  ARTIFACT_PARTITION,
  ARTIFACT_SCHEME,
  artifactContentType,
  artifactPreviewUrl,
  chromeUserAgent
} from '../shared/artifact-preview'
import type { IpcRegistrar } from './ipc/registrar'
import { v } from './ipc/validate'

interface StoredFile {
  data: Buffer
  contentType: string
}

/** Each artifact's local copy, by its host: published path ('' = the page) → file. */
const copies = new Map<string, Map<string, StoredFile>>()

/**
 * Before the app is ready: the scheme is a standard, secure origin, so pages on
 * it get localStorage, fetch and module scripts like any https page.
 */
export function registerArtifactScheme(): void {
  protocol.registerSchemesAsPrivileged([{
    scheme: ARTIFACT_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true }
  }])
}

/** A request for a local copy: the file at its published path, the page at `/`. */
function serve(request: Request): Response {
  const url = new URL(request.url)
  const files = copies.get(url.hostname)
  if (!files) return new Response('This artifact is not loaded. Reload the tab.', { status: 404 })
  let published: string
  try {
    published = decodeURIComponent(url.pathname).replace(/^\/+/, '')
  } catch {
    return new Response('Bad path', { status: 400 })
  }
  const file = files.get(published) ?? (published === 'index.html' ? files.get('') : undefined)
  if (!file) return new Response(`${published} is not part of this artifact`, { status: 404 })
  return new Response(new Uint8Array(file.data), {
    headers: { 'content-type': file.contentType, 'cache-control': 'no-store' }
  })
}

/**
 * Once ready: the published pages' session passes for plain Chrome (for the
 * claude.ai sign-in); local copies are served only in their own session.
 */
export function installArtifactSession(): void {
  const published = session.fromPartition(ARTIFACT_PARTITION)
  published.setUserAgent(chromeUserAgent(published.getUserAgent()))
  session.fromPartition(ARTIFACT_COPY_PARTITION).protocol.handle(ARTIFACT_SCHEME, serve)
}

const MAX_BASE64 = 4 * 1024 * 1024

/**
 * `artifact-preview-load`: a window hands over an artifact's local copy (read
 * from the chat's host) and gets the URL to show it at. Loading again replaces
 * it, so a reload picks up a republish.
 */
export function registerArtifactPreviewHandlers(ipc: IpcRegistrar): void {
  ipc.handle('artifact-preview-load', [
    v.string({ nonEmpty: true, max: 64, pattern: /^[a-z0-9-]+$/, patternName: 'an artifact key' }),
    v.array(v.object({
      path: v.string({ max: 1024 }),
      data: v.string({ max: MAX_BASE64 }),
      contentType: v.optional(v.string({ max: 200 }))
    }), { max: 255 })
  ], (_ctx, key, files) => {
    const page = files.find((file) => file.path === '')
    if (!page) throw new Error('The artifact has no page')
    copies.set(key, new Map(files.map((file) => [file.path, {
      data: Buffer.from(file.data, 'base64'),
      contentType: file.contentType ?? (file.path === '' ? 'text/html; charset=utf-8' : artifactContentType(file.path))
    }])))
    return artifactPreviewUrl(key)
  })
}
