import React, { useState, useRef, useEffect, useCallback } from 'react'
import { useApp } from '../context/AppContext'
import type { SshConfig } from '../../shared/types'
import { BLANK_BROWSER_URL, normalizeBrowserUrl } from '../browserUrl'
import { formatShortcutForApp } from '../../shared/shortcut-label'
import LinkContextMenu, { type LinkMenuState } from './LinkContextMenu'
import { useServerStatus } from '../serversState'
import { ARTIFACT_COPY_PARTITION, ARTIFACT_PARTITION, artifactPreviewKey, artifactPreviewUrl, isArtifactPreviewUrl, type ArtifactPreviewFile } from '../../shared/artifact-preview'
import type { Tab } from '../../shared/types'

interface Props {
  tabId: string
  visible: boolean
  initialUrl?: string
  projectId: string
  taskId: string
  sshConfig?: SshConfig
  /** A DevTool server's project: pages load through that server, so `localhost` is the server. */
  serverId?: string
  /** A chat's Artifact page: shown from its local files, or published on claude.ai. */
  artifact?: Tab['artifact']
}

const toolbarBtn = 'bg-transparent border-0 text-text-muted cursor-pointer px-2 py-1 rounded-md text-sm whitespace-nowrap hover:bg-surface-3 hover:text-text transition-colors duration-(--motion-fast)'

/** An artifact tab opens on its local copy unless it was left on a web page (the published one). */
function artifactStartUrl(artifact: NonNullable<Tab['artifact']>, initialUrl: string | undefined): string {
  return initialUrl && /^https?:\/\//.test(initialUrl) ? initialUrl : artifactPreviewUrl(artifactPreviewKey(artifact.url))
}

/** Read the artifact's local copy from the chat's host and hand it to this desktop to serve. */
async function loadArtifactCopy(artifact: NonNullable<Tab['artifact']>): Promise<string> {
  const paths = await window.api.chatArtifactManifest(artifact.chatTabId, artifact.url)
  const files: ArtifactPreviewFile[] = await Promise.all(paths.map((path) => window.api.chatArtifactFile(artifact.chatTabId, artifact.url, path)))
  return window.api.artifactPreviewLoad(artifactPreviewKey(artifact.url), files)
}

function ipcMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  return raw.replace(/^Error invoking remote method '[^']+': (?:Error: )?/u, '')
}

export default function BrowserTab({ tabId, visible, initialUrl, projectId, taskId, sshConfig, serverId, artifact: artifactProp }: Props): React.ReactElement {
  const { updateTabUrl, browserZoomFactor, markTaskInteracted, addTab } = useApp()
  // Its URL comes from saved tabs (a server's too): only a claude.ai page is one.
  const artifact = artifactProp && artifactProp.url.startsWith('https://claude.ai/') ? artifactProp : undefined
  const [url, setUrl] = useState(artifact ? artifactStartUrl(artifact, initialUrl) : (initialUrl || BLANK_BROWSER_URL))
  const [inputUrl, setInputUrl] = useState(url)
  const [devToolsOpen, setDevToolsOpen] = useState(false)
  const [proxyEnabled, setProxyEnabled] = useState(!!sshConfig)
  const [proxyLoading, setProxyLoading] = useState(false)
  // A server project's tab never loads before its session goes through the server.
  const [proxyReady, setProxyReady] = useState(!!artifact || (!sshConfig && !serverId))
  /** The local copy: being read, served, or why it can't be shown. */
  const [copy, setCopy] = useState<{ state: 'idle' | 'loading' | 'ready' } | { state: 'error'; error: string }>({ state: 'idle' })
  const [serverProxyError, setServerProxyError] = useState<string | null>(null)
  const [serverProxyAttempt, setServerProxyAttempt] = useState(0)
  const server = useServerStatus(serverId)
  const serverName = server?.name ?? 'the server'
  const [linkMenu, setLinkMenu] = useState<LinkMenuState | null>(null)
  const webviewRef = useRef<Electron.WebviewTag>(null)
  // Lazy like terminals: hidden tabs (e.g. restored at startup) don't load their page
  // until first shown, then stay mounted so the page keeps its state.
  const [activated, setActivated] = useState(visible)
  if (visible && !activated) setActivated(true)

  const handleOpenLinkInApp = useCallback((targetUrl: string) => {
    addTab(projectId, taskId, { withTab: tabId }, 'browser', { url: targetUrl })
  }, [addTab, projectId, taskId, tabId])

  // Artifact tabs load claude.ai or a local copy, never the project's network.
  const isRemote = !!sshConfig && !artifact
  const isServer = !!serverId && !artifact
  const showingCopy = !!artifact && isArtifactPreviewUrl(url)
  // A webview keeps its first session, so switching copy ↔ published remounts it (keyed below).
  const partition = artifact
    ? (showingCopy ? ARTIFACT_COPY_PARTITION : ARTIFACT_PARTITION)
    : isRemote || isServer ? `persist:browser-${projectId}` : undefined

  /** (Re)read the local copy, then show it; a reload picks up what Claude published since. */
  const showCopy = useCallback(async () => {
    if (!artifact) return
    setCopy({ state: 'loading' })
    try {
      const previewUrl = await loadArtifactCopy(artifact)
      setCopy({ state: 'ready' })
      setUrl(previewUrl)
      setInputUrl(previewUrl)
      updateTabUrl(projectId, taskId, tabId, previewUrl)
      const webview = webviewRef.current
      if (webview && webview.getURL() === previewUrl) webview.reload()
    } catch (err) {
      setCopy({ state: 'error', error: ipcMessage(err) })
      // Shown in place of the page, with the way back to the published one.
      const previewUrl = artifactPreviewUrl(artifactPreviewKey(artifact.url))
      setUrl(previewUrl)
      setInputUrl(previewUrl)
    }
  }, [artifact, projectId, taskId, tabId, updateTabUrl])

  // A tab restored on its local copy reads it again on first view: main forgets copies on quit.
  useEffect(() => {
    if (activated && showingCopy && copy.state === 'idle') void showCopy()
  }, [activated, showingCopy, copy.state, showCopy])

  // The webview mounts late (first view, or once a remote proxy is ready) and
  // again when its session changes, so effects that bind to it re-run on
  // `webviewMounted` and `partition`.
  const copyPending = showingCopy && copy.state !== 'ready'
  const webviewMounted = activated && proxyReady && !copyPending

  useEffect(() => {
    const webview = webviewRef.current
    if (!webviewMounted || !webview) return

    const handleNavigation = () => {
      markTaskInteracted(projectId, taskId)
      const newUrl = webview.getURL()
      setUrl(newUrl)
      setInputUrl(newUrl)
      updateTabUrl(projectId, taskId, tabId, newUrl)
    }

    webview.addEventListener('did-navigate', handleNavigation)
    webview.addEventListener('did-navigate-in-page', handleNavigation)

    const handleContextMenu = (e: Event) => {
      const { linkURL, x, y } = (e as Electron.ContextMenuEvent).params
      if (!linkURL) return
      e.preventDefault()
      const rect = webview.getBoundingClientRect()
      setLinkMenu({ url: linkURL, x: rect.left + x, y: rect.top + y })
    }
    webview.addEventListener('context-menu', handleContextMenu)

    return () => {
      webview.removeEventListener('did-navigate', handleNavigation)
      webview.removeEventListener('did-navigate-in-page', handleNavigation)
      webview.removeEventListener('context-menu', handleContextMenu)
    }
  }, [webviewMounted, partition, projectId, taskId, tabId, updateTabUrl, markTaskInteracted])

  useEffect(() => {
    const handleReload = (e: Event) => {
      const detail = (e as CustomEvent).detail
      if (detail?.tabId === tabId) {
        webviewRef.current?.reload()
      }
    }
    window.addEventListener('reload-browser-tab', handleReload)
    return () => window.removeEventListener('reload-browser-tab', handleReload)
  }, [tabId])

  // Apply browser zoom factor
  useEffect(() => {
    const webview = webviewRef.current
    if (!webviewMounted || !webview) return
    const applyZoom = () => {
      try { webview.setZoomFactor(browserZoomFactor) } catch {}
    }
    applyZoom()
    webview.addEventListener('dom-ready', applyZoom)
    return () => { webview.removeEventListener('dom-ready', applyZoom) }
  }, [webviewMounted, partition, browserZoomFactor])

  // Initialize SOCKS proxy for remote projects, on first view only
  useEffect(() => {
    if (!isRemote || !activated) return

    let cancelled = false

    const waitForSsh = async (): Promise<boolean> => {
      // Poll SSH status — on app restore SSH may be 'disconnected' briefly before
      // the connection starts, so don't give up on the first 'disconnected'.
      for (let i = 0; i < 50; i++) {
        if (cancelled) return false
        const sshStatus = await window.api.sshStatus(projectId)
        if (sshStatus === 'connected') return true
        await new Promise(r => setTimeout(r, 200))
      }
      return false
    }

    const initProxy = async () => {
      try {
        // Wait for SSH to connect before setting up proxy
        const sshReady = await waitForSsh()
        if (cancelled || !sshReady) {
          setProxyEnabled(false)
          setProxyReady(true)
          return
        }

        const status = await window.api.socksProxyStatus(projectId)
        if (cancelled) return

        if (status.enabled && status.port) {
          // Proxy already running — use it
          setProxyEnabled(true)
          setProxyReady(true)
        } else if (status.enabled === false) {
          // User explicitly disabled — respect that choice
          setProxyEnabled(false)
          setProxyReady(true)
        } else {
          // First browser tab for this project — enable proxy by default
          setProxyLoading(true)
          await window.api.socksProxyEnable(projectId, sshConfig!)
          if (cancelled) return
          setProxyEnabled(true)
          setProxyReady(true)
          setProxyLoading(false)
          // Kick the webview after it mounts — the initial src load can get stuck
          // when the partition session was just configured.
          setTimeout(() => { if (!cancelled) webviewRef.current?.reload() }, 100)
        }
      } catch {
        if (cancelled) return
        // Proxy failed — fall back to direct
        setProxyEnabled(false)
        setProxyReady(true)
        setProxyLoading(false)
      }
    }

    void initProxy()
    return () => { cancelled = true }
  }, [isRemote, activated, projectId])

  // A server project's tab: main points the project's session at that server's
  // authenticated proxy (each connection dialled from the server) and holds it for
  // this tab. No direct fallback: `localhost` here must never be this computer.
  useEffect(() => {
    if (!serverId || !activated) return
    let cancelled = false
    setServerProxyError(null)
    window.api.serverBrowserProxy(projectId, tabId).then(
      () => { if (!cancelled) setProxyReady(true) },
      (err: unknown) => {
        if (cancelled) return
        const raw = err instanceof Error ? err.message : String(err)
        setServerProxyError(raw.replace(/^Error invoking remote method '[^']+': (?:Error: )?/u, ''))
      }
    )
    return () => {
      cancelled = true
      void window.api.serverBrowserProxyRelease(projectId, tabId).catch(() => {})
    }
  }, [serverId, activated, projectId, tabId, serverProxyAttempt])

  // Listen for proxy status changes (cross-tab sync)
  useEffect(() => {
    if (!isRemote) return

    const cleanup = window.api.onSocksProxyStatusChanged((changedProjectId, enabled) => {
      if (changedProjectId === projectId) {
        setProxyEnabled(enabled)
      }
    })

    return cleanup
  }, [isRemote, projectId])

  const navigate = (targetUrl: string) => {
    const normalized = normalizeBrowserUrl(targetUrl)
    setUrl(normalized)
    setInputUrl(normalized)
    updateTabUrl(projectId, taskId, tabId, normalized)
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      navigate(inputUrl)
    }
  }

  const handleProxyToggle = async () => {
    if (proxyLoading || !sshConfig) return
    setProxyLoading(true)
    try {
      if (proxyEnabled) {
        await window.api.socksProxyDisable(projectId)
      } else {
        await window.api.socksProxyEnable(projectId, sshConfig)
      }
      webviewRef.current?.reload()
    } catch {
      // Toggle failed — state will be updated by the status listener
    } finally {
      setProxyLoading(false)
    }
  }

  return (
    <div className="w-full h-full flex flex-col" style={{ display: visible ? 'flex' : 'none' }}>
      <div className="flex items-center gap-1 px-2 py-1 bg-surface-2 border-b-[0.5px] border-border">
        <button className="bg-transparent border-0 text-text-muted cursor-pointer px-2 py-1 rounded-md text-md hover:bg-surface-3 hover:text-text transition-colors duration-(--motion-fast)" onClick={() => webviewRef.current?.goBack()} title="Back">&larr;</button>
        <button className="bg-transparent border-0 text-text-muted cursor-pointer px-2 py-1 rounded-md text-md hover:bg-surface-3 hover:text-text transition-colors duration-(--motion-fast)" onClick={() => webviewRef.current?.goForward()} title="Forward">&rarr;</button>
        <button className="bg-transparent border-0 text-text-muted cursor-pointer px-2 py-1 rounded-md text-md hover:bg-surface-3 hover:text-text transition-colors duration-(--motion-fast)" onClick={() => { if (showingCopy) void showCopy(); else webviewRef.current?.reload() }} title={`Reload (${formatShortcutForApp('CmdOrCtrl+R')})`}>&#8635;</button>
        <div className="flex-1 flex items-center relative">
          {isRemote && proxyEnabled && <span className="absolute right-2 bg-accent text-accent-ink text-2xs font-semibold px-1.5 py-px rounded-sm uppercase tracking-wider pointer-events-none z-(--z-sticky)">Remote</span>}
          {isServer && proxyReady && (
            <span
              className="absolute right-2 bg-accent text-accent-ink text-2xs font-semibold px-1.5 py-px rounded-sm tracking-wider pointer-events-none z-(--z-sticky) max-w-[40%] truncate"
              title={`Pages load through ${serverName}: localhost is ${serverName}`}
            >
              via {serverName}
            </span>
          )}
          <input
            className="flex-1 bg-field text-text border border-border px-2 h-(--ctl-h-sm) rounded-md text-sm outline-none focus:border-border-focus focus:shadow-focus"
            value={inputUrl}
            onChange={(e) => setInputUrl(e.target.value)}
            onKeyDown={handleKeyDown}
            spellCheck={false}
          />
        </div>
        {artifact && (showingCopy ? (
          <button
            className={toolbarBtn}
            onClick={() => navigate(artifact.url)}
            title="Open the published page on claude.ai, with its shared data and comments (needs a claude.ai sign-in once)"
          >
            Published
          </button>
        ) : (
          <button
            className={toolbarBtn}
            onClick={() => void showCopy()}
            title="Show the page from the files Claude published, without claude.ai"
          >
            Local copy
          </button>
        ))}
        {isRemote && (
          <button
            className={['bg-transparent border-0 text-text-muted cursor-pointer px-2 py-1 rounded-md text-md hover:bg-surface-3 hover:text-text disabled:opacity-40 disabled:cursor-not-allowed', proxyEnabled ? 'text-accent' : ''].join(' ').trim()}
            onClick={() => void handleProxyToggle()}
            disabled={proxyLoading}
            title={proxyEnabled ? 'Routing through remote host (click to use direct)' : 'Direct connection (click to route through remote host)'}
          >
            &#127760;
          </button>
        )}
        <button
          className={['bg-transparent border-0 text-text-muted cursor-pointer px-2 py-1 rounded-md text-md hover:bg-surface-3 hover:text-text transition-colors duration-(--motion-fast)', devToolsOpen ? 'text-accent' : ''].join(' ').trim()}
          onClick={() => {
            if (devToolsOpen) {
              webviewRef.current?.closeDevTools()
            } else {
              webviewRef.current?.openDevTools()
            }
            setDevToolsOpen(!devToolsOpen)
          }}
          title={`Toggle DevTools (${formatShortcutForApp('CmdOrCtrl+Alt+I')})`}
        >
          &#9874;
        </button>
      </div>
      <div className="flex-1 flex flex-col overflow-hidden">
        {!activated ? null : copyPending ? (
          copy.state === 'error' ? (
            <div className="flex-1 flex flex-col items-center justify-center gap-2 px-4 text-center text-text-muted text-base" role="alert">
              <div>Can&apos;t show the local copy: {copy.error}</div>
              <div className="flex gap-2">
                <button
                  className="bg-transparent border border-border text-text cursor-pointer px-2 py-1 rounded-md text-sm hover:bg-surface-3"
                  onClick={() => void showCopy()}
                >
                  Try again
                </button>
                <button
                  className="bg-transparent border border-border text-text cursor-pointer px-2 py-1 rounded-md text-sm hover:bg-surface-3"
                  onClick={() => { setCopy({ state: 'idle' }); navigate(artifact!.url) }}
                >
                  Open published version
                </button>
              </div>
            </div>
          ) : (
            <div className="flex-1 flex items-center justify-center text-text-muted text-base">Loading the local copy…</div>
          )
        ) : proxyReady ? (
          <webview
            key={partition ?? 'default'}
            ref={webviewRef}
            src={url}
            className="flex-1 w-full h-full"
            // Guest pages are a real browser for the agent — not a Node process.
            webpreferences="contextIsolation=yes, nodeIntegration=no, sandbox=yes, webSecurity=yes"
            {...(partition ? { partition } : {})}
          />
        ) : serverProxyError ? (
          <div className="flex-1 flex flex-col items-center justify-center gap-2 text-text-muted text-base" role="alert">
            <div>Can&apos;t route this tab through {serverName}: {serverProxyError}</div>
            <button
              className="bg-transparent border border-border text-text cursor-pointer px-2 py-1 rounded-md text-sm hover:bg-surface-3"
              onClick={() => setServerProxyAttempt((n) => n + 1)}
            >
              Try again
            </button>
          </div>
        ) : (
          <div className="flex-1 flex items-center justify-center text-text-muted text-base">{isServer ? `Connecting through ${serverName}...` : 'Connecting to remote host...'}</div>
        )}
      </div>
      <LinkContextMenu
        menu={linkMenu}
        onClose={() => setLinkMenu(null)}
        onOpenInApp={handleOpenLinkInApp}
      />
    </div>
  )
}
