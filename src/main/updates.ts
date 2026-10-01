import type { AppUpdater } from 'electron-updater'
import type { RedirectProbe } from './release-redirect'
import {
  compareVersions,
  parseLatestRelease,
  RELEASES_URL,
  type UpdateMode,
  type UpdateStatus
} from '../shared/updates'

// Whether a newer DevTool exists, and what this install can do about it. The
// mode (see UpdateMode) is decided once at startup from facts of the artifact.
//
// `manual` is one HTTPS request for where github.com/…/releases/latest redirects:
// it names the newest tag without the GitHub API (no token, no rate limit), and
// "install" opens that release page. `auto` hands the same question to
// electron-updater, which downloads the signed Setup.exe and runs it on restart
// or quit. Unsigned releases carry no latest.yml, so `auto` never sees them.
//
// First check shortly after launch, then every few hours; each tick re-reads the
// Settings toggle so it applies without a restart. "Check now" ignores the toggle.

/** Off the cold-start path. */
export const FIRST_CHECK_DELAY_MS = 30_000
export const CHECK_EVERY_MS = 6 * 60 * 60_000

export interface UpdatesDeps {
  mode: UpdateMode
  appVersion: string
  /** Settings → Updates → Check automatically. */
  autoCheck: () => boolean
  /** Push a status change to every window. */
  broadcast: (status: UpdateStatus) => void
  openExternal: (url: string) => void
  /** Where a URL redirects (src/main/release-redirect.ts). */
  probeRedirect: (url: string) => Promise<RedirectProbe>
  now: () => number
  log: (message: string) => void
  /** electron-updater, loaded on first use in `auto` mode only. */
  loadAutoUpdater: () => Promise<AppUpdater>
}

export interface Updates {
  start(): void
  status(): UpdateStatus
  /** Look now, regardless of the automatic-check toggle. */
  check(): Promise<UpdateStatus>
  /** Restart into the downloaded build (`auto`), or open the release page. */
  install(): Promise<void>
  close(): void
}

/**
 * The newest released version, from where `/releases/latest` redirects. Null when
 * nothing is published yet: GitHub then redirects to the releases list instead.
 */
export async function fetchLatestRelease(
  probe: (url: string) => Promise<RedirectProbe>
): Promise<{ version: string; url: string } | null> {
  const { status, location } = await probe(`${RELEASES_URL}/latest`)
  if (location?.replace(/\/$/, '').endsWith('/releases')) return null
  const latest = parseLatestRelease(location)
  if (!latest) throw new Error(`GitHub did not name a latest release (HTTP ${status})`)
  return latest
}

export function createUpdates(deps: UpdatesDeps): Updates {
  const current: UpdateStatus = {
    appVersion: deps.appVersion,
    mode: deps.mode,
    state: 'idle',
    available: null,
    releaseUrl: null,
    checkedAt: null,
    error: null
  }
  deps.log(`updates mode=${deps.mode} version=${deps.appVersion}`)

  let firstTimer: NodeJS.Timeout | null = null
  let interval: NodeJS.Timeout | null = null
  let inFlight: Promise<UpdateStatus> | null = null
  let updater: Promise<AppUpdater> | null = null

  function set(patch: Partial<UpdateStatus>): void {
    Object.assign(current, patch)
    deps.broadcast({ ...current })
  }

  function getUpdater(): Promise<AppUpdater> {
    updater ??= deps.loadAutoUpdater().then((autoUpdater) => {
      const line = (message: unknown) => deps.log(`updates ${String(message)}`)
      autoUpdater.logger = { info: line, warn: line, error: line, debug: () => undefined }
      autoUpdater.autoDownload = true
      autoUpdater.autoInstallOnAppQuit = true
      autoUpdater.on('update-available', (info) => {
        set({ state: 'downloading', available: info.version, releaseUrl: `${RELEASES_URL}/tag/v${info.version}` })
      })
      autoUpdater.on('update-downloaded', () => set({ state: 'ready' }))
      // A download can fail long after the check resolved; an unlistened 'error'
      // on an emitter would take main down.
      autoUpdater.on('error', (error) => {
        deps.log(`updates auto-update failed: ${error.message}`)
        if (current.state === 'downloading' || current.state === 'checking') {
          set({ state: 'error', error: error.message })
        }
      })
      return autoUpdater
    })
    return updater
  }

  async function runCheck(): Promise<void> {
    if (deps.mode === 'auto') {
      const autoUpdater = await getUpdater()
      // A downloaded build stays ready until a restart consumes it.
      if (current.state === 'ready') return
      set({ state: 'checking', error: null })
      await autoUpdater.checkForUpdates()
      if (current.state === 'checking') set({ state: 'idle', available: null, releaseUrl: null })
      set({ checkedAt: deps.now() })
      return
    }
    set({ state: 'checking', error: null })
    const latest = await fetchLatestRelease(deps.probeRedirect)
    const newer = latest !== null && compareVersions(latest.version, deps.appVersion) > 0
    set({
      state: 'idle',
      available: newer ? latest.version : null,
      releaseUrl: newer ? latest.url : null,
      checkedAt: deps.now()
    })
  }

  function check(): Promise<UpdateStatus> {
    if (deps.mode === 'none') return Promise.resolve({ ...current })
    inFlight ??= runCheck()
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        deps.log(`updates check failed: ${message}`)
        set({ state: 'error', error: message, checkedAt: deps.now() })
      })
      .then(() => ({ ...current }))
      .finally(() => { inFlight = null })
    return inFlight
  }

  function tick(): void {
    if (deps.autoCheck()) void check()
  }

  return {
    start() {
      if (deps.mode === 'none' || firstTimer || interval) return
      firstTimer = setTimeout(() => { firstTimer = null; tick() }, FIRST_CHECK_DELAY_MS)
      interval = setInterval(tick, CHECK_EVERY_MS)
    },
    status: () => ({ ...current }),
    check,
    async install() {
      if (deps.mode === 'auto' && current.state === 'ready') {
        const autoUpdater = await getUpdater()
        autoUpdater.quitAndInstall()
        return
      }
      deps.openExternal(current.releaseUrl ?? `${RELEASES_URL}/latest`)
    },
    close() {
      if (firstTimer) clearTimeout(firstTimer)
      if (interval) clearInterval(interval)
      firstTimer = null
      interval = null
    }
  }
}
