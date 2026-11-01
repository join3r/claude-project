/**
 * Artifact pages in a browser tab. The local copy (the files the chat's Artifact
 * calls published) is served by main on a private scheme, one origin per
 * artifact, in a session of its own; the published page on claude.ai loads in
 * another, which keeps the claude.ai login for every project. Kept apart so a
 * page Claude wrote never runs next to that login.
 */

export const ARTIFACT_SCHEME = 'devtool-artifact'
/** The browser session of published artifact pages: the shared claude.ai login. */
export const ARTIFACT_PARTITION = 'persist:artifacts'
/** The browser session of local copies (persisted for their localStorage; no logins). */
export const ARTIFACT_COPY_PARTITION = 'persist:artifact-copies'
/**
 * The largest file the local copy carries. A server sends each file in one
 * message (4 MiB on the link), so the cap leaves room for base64.
 */
export const ARTIFACT_FILE_MAX_BYTES = 2.5 * 1024 * 1024

/** One file of the local copy; `path` '' is the page itself. */
export interface ArtifactPreviewFile {
  path: string
  /** base64 */
  data: string
  contentType?: string
}

/** The local copy's host for a published URL: its artifact id, lower-cased (hosts are case-insensitive). */
export function artifactPreviewKey(url: string): string {
  const id = url.replace(/[?#].*$/, '').replace(/\/+$/, '').split('/').pop() ?? ''
  const key = id.toLowerCase().replace(/[^a-z0-9-]/g, '')
  return key || 'artifact'
}

export function artifactPreviewUrl(key: string): string {
  return `${ARTIFACT_SCHEME}://${key}/`
}

export function isArtifactPreviewUrl(url: string | undefined): boolean {
  return !!url && url.startsWith(`${ARTIFACT_SCHEME}://`)
}

const CONTENT_TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
  xml: 'application/xml',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  ico: 'image/x-icon',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  pdf: 'application/pdf',
  wasm: 'application/wasm'
}

export function artifactContentType(path: string): string {
  const ext = /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase()
  return (ext && CONTENT_TYPES[ext]) || 'application/octet-stream'
}

/**
 * Electron's user agent as plain Chrome: without the app and Electron tokens,
 * so sign-in pages (Google's especially) don't turn the browser away.
 */
export function chromeUserAgent(userAgent: string): string {
  return userAgent.replace(/\s(?!(?:Mozilla|AppleWebKit|Chrome|Safari)\/)[A-Za-z][\w.-]*\/\S+/g, '')
}
