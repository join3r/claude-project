// Update checks (Settings → Updates, "Check for Updates…"). Pure helpers shared
// by main and the renderer; the machinery lives in src/main/updates.ts.

export const RELEASES_URL = 'https://github.com/join3r/claude-project/releases'

/**
 * How a release reaches this install — a fact of the artifact, decided once:
 * - `auto`: a signed NSIS install. electron-updater downloads and swaps it.
 * - `manual`: every other packaged build (portable folder, unsigned Setup.exe,
 *   macOS/Linux dirs). DevTool says a newer version exists and opens its page.
 * - `none`: dev runs. Nothing on disk a release could replace.
 */
export type UpdateMode = 'auto' | 'manual' | 'none'

export type UpdateState = 'idle' | 'checking' | 'downloading' | 'ready' | 'error'

export interface UpdateStatus {
  appVersion: string
  mode: UpdateMode
  state: UpdateState
  /** Newer version that exists, or null when up to date / not checked yet. */
  available: string | null
  /** Release page for `available`. */
  releaseUrl: string | null
  /** Epoch ms of the last finished check. */
  checkedAt: number | null
  error: string | null
}

export interface UpdateModeFacts {
  isPackaged: boolean
  platform: string
  /** resources/app-update.yml exists — electron-builder writes it for NSIS installs only. */
  hasUpdateConfig: boolean
  /** package.json `devtoolSigned`, stamped by `release-win --signed`. */
  signed: boolean
}

export function decideUpdateMode(facts: UpdateModeFacts): UpdateMode {
  if (!facts.isPackaged) return 'none'
  // Unsigned auto-update is not worth it: an unsigned build only ever says so.
  if (facts.platform === 'win32' && facts.hasUpdateConfig && facts.signed) return 'auto'
  return 'manual'
}

/**
 * Numeric compare of dotted versions (`0.6.0` vs `0.10.1`). A pre-release
 * suffix (`-beta.1`) sorts before the same release. >0 when `a` is newer.
 */
export function compareVersions(a: string, b: string): number {
  const split = (version: string) => {
    const [core, pre] = version.replace(/^v/, '').split('-', 2)
    return { parts: core.split('.').map((part) => parseInt(part, 10) || 0), pre: pre ?? null }
  }
  const left = split(a)
  const right = split(b)
  const length = Math.max(left.parts.length, right.parts.length)
  for (let i = 0; i < length; i++) {
    const diff = (left.parts[i] ?? 0) - (right.parts[i] ?? 0)
    if (diff !== 0) return diff
  }
  if (left.pre === right.pre) return 0
  if (left.pre === null) return 1
  if (right.pre === null) return -1
  return left.pre < right.pre ? -1 : 1
}

/**
 * The version a `/releases/latest` redirect names. Only the tag is taken from
 * the `Location` header; the page URL is rebuilt on RELEASES_URL. Null for
 * anything that is not a version tag (no releases yet, an error page).
 */
export function parseLatestRelease(location: string | null): { version: string; url: string } | null {
  const tag = /\/releases\/tag\/(v?\d+(?:\.\d+)*(?:-[0-9A-Za-z.]+)?)$/.exec(location ?? '')?.[1]
  if (!tag) return null
  return { version: tag.replace(/^v/, ''), url: `${RELEASES_URL}/tag/${tag}` }
}

/** The one-line status Settings → Updates shows. */
export function describeUpdateStatus(status: UpdateStatus): string {
  if (status.mode === 'none') return 'Update checks are off in development runs.'
  switch (status.state) {
    case 'checking': return 'Checking for updates…'
    case 'downloading': return `Downloading ${status.available ?? 'update'}…`
    case 'ready': return `${status.available ?? 'An update'} is ready — restart to install.`
    case 'error': return `Could not check for updates: ${status.error ?? 'unknown error'}`
    case 'idle':
      if (status.available) return `${status.available} is available.`
      return status.checkedAt ? 'DevTool is up to date.' : 'Not checked yet.'
  }
}
