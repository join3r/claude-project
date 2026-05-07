import React, { useState, useRef, useEffect } from 'react'
import { useApp } from '../context/AppContext'
import type { SshConfig } from '../../shared/types'
import { normalizeBrowserUrl } from '../browserUrl'

interface Props {
  tabId: string
  visible: boolean
  initialUrl?: string
  projectId: string
  taskId: string
  pane: 'left' | 'right'
  sshConfig?: SshConfig
}

export default function BrowserTab({ tabId, visible, initialUrl, projectId, taskId, pane, sshConfig }: Props): React.ReactElement {
  const { updateTabUrl, browserZoomFactor } = useApp()
  const [url, setUrl] = useState(initialUrl || 'https://www.google.com')
  const [inputUrl, setInputUrl] = useState(url)
  const [devToolsOpen, setDevToolsOpen] = useState(false)
  const [proxyEnabled, setProxyEnabled] = useState(!!sshConfig)
  const [proxyLoading, setProxyLoading] = useState(false)
  const [proxyReady, setProxyReady] = useState(!sshConfig)
  const webviewRef = useRef<Electron.WebviewTag>(null)

  const isRemote = !!sshConfig
  const partition = isRemote ? `persist:browser-${projectId}` : undefined

  useEffect(() => {
    const webview = webviewRef.current
    if (!webview) return

    const handleNavigation = () => {
      const newUrl = webview.getURL()
      setUrl(newUrl)
      setInputUrl(newUrl)
      updateTabUrl(projectId, taskId, pane, tabId, newUrl)
    }

    webview.addEventListener('did-navigate', handleNavigation)
    webview.addEventListener('did-navigate-in-page', handleNavigation)

    return () => {
      webview.removeEventListener('did-navigate', handleNavigation)
      webview.removeEventListener('did-navigate-in-page', handleNavigation)
    }
  }, [projectId, taskId, pane, tabId, updateTabUrl])

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
    if (!webview) return
    const applyZoom = () => {
      try { webview.setZoomFactor(browserZoomFactor) } catch {}
    }
    applyZoom()
    webview.addEventListener('dom-ready', applyZoom)
    return () => webview.removeEventListener('dom-ready', applyZoom)
  }, [browserZoomFactor])

  // Initialize SOCKS proxy for remote projects
  useEffect(() => {
    if (!isRemote) return

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
  }, [isRemote, projectId])

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
    updateTabUrl(projectId, taskId, pane, tabId, normalized)
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
      <div className="flex items-center gap-1 px-2 py-1 bg-surface-2 border-b border-border">
        <button className="bg-transparent border-0 text-text-muted cursor-pointer px-2 py-1 rounded-md text-[14px] hover:bg-surface-3 hover:text-text" onClick={() => webviewRef.current?.goBack()} title="Back">&larr;</button>
        <button className="bg-transparent border-0 text-text-muted cursor-pointer px-2 py-1 rounded-md text-[14px] hover:bg-surface-3 hover:text-text" onClick={() => webviewRef.current?.goForward()} title="Forward">&rarr;</button>
        <button className="bg-transparent border-0 text-text-muted cursor-pointer px-2 py-1 rounded-md text-[14px] hover:bg-surface-3 hover:text-text" onClick={() => webviewRef.current?.reload()} title="Reload (⌘R)">&#8635;</button>
        <div className="flex-1 flex items-center relative">
          {isRemote && proxyEnabled && <span className="absolute right-2 bg-accent-500 text-accent-50 text-[9px] font-semibold px-1.5 py-px rounded-sm uppercase tracking-wider pointer-events-none z-[1]">Remote</span>}
          <input
            className="flex-1 bg-surface text-text border border-border px-2 py-1 rounded-md text-[12px] outline-none focus:border-border-focus"
            value={inputUrl}
            onChange={(e) => setInputUrl(e.target.value)}
            onKeyDown={handleKeyDown}
            spellCheck={false}
          />
        </div>
        {isRemote && (
          <button
            className={['bg-transparent border-0 text-text-muted cursor-pointer px-2 py-1 rounded-md text-[14px] hover:bg-surface-3 hover:text-text text-[13px] disabled:opacity-40 disabled:cursor-not-allowed', proxyEnabled ? 'text-accent-400' : ''].join(' ').trim()}
            onClick={() => void handleProxyToggle()}
            disabled={proxyLoading}
            title={proxyEnabled ? 'Routing through remote host (click to use direct)' : 'Direct connection (click to route through remote host)'}
          >
            &#127760;
          </button>
        )}
        <button
          className={['bg-transparent border-0 text-text-muted cursor-pointer px-2 py-1 rounded-md text-[14px] hover:bg-surface-3 hover:text-text', devToolsOpen ? 'text-accent-400' : ''].join(' ').trim()}
          onClick={() => {
            if (devToolsOpen) {
              webviewRef.current?.closeDevTools()
            } else {
              webviewRef.current?.openDevTools()
            }
            setDevToolsOpen(!devToolsOpen)
          }}
          title="Toggle DevTools (⌘⌥I)"
        >
          &#9874;
        </button>
      </div>
      <div className="flex-1 flex flex-col overflow-hidden">
        {proxyReady ? (
          <webview
            ref={webviewRef}
            src={url}
            className="flex-1 w-full h-full"
            {...(partition ? { partition } : {})}
          />
        ) : (
          <div className="flex-1 flex items-center justify-center text-text-muted text-[13px]">Connecting to remote host...</div>
        )}
      </div>
    </div>
  )
}
