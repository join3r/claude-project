import React, { useState, useRef, useEffect } from 'react'
import { useApp } from '../context/AppContext'
import type { SshConfig } from '../../shared/types'
import { normalizeBrowserUrl } from '../browserUrl'
import './BrowserTab.css'

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
    <div className="browser-tab" style={{ display: visible ? 'flex' : 'none' }}>
      <div className="browser-toolbar">
        <button className="browser-nav-btn" onClick={() => webviewRef.current?.goBack()} title="Back">&larr;</button>
        <button className="browser-nav-btn" onClick={() => webviewRef.current?.goForward()} title="Forward">&rarr;</button>
        <button className="browser-nav-btn" onClick={() => webviewRef.current?.reload()} title="Reload (⌘R)">&#8635;</button>
        <div className="browser-url-wrapper">
          {isRemote && proxyEnabled && <span className="browser-remote-badge">Remote</span>}
          <input
            className="browser-url"
            value={inputUrl}
            onChange={(e) => setInputUrl(e.target.value)}
            onKeyDown={handleKeyDown}
            spellCheck={false}
          />
        </div>
        {isRemote && (
          <button
            className={`browser-nav-btn proxy-toggle-btn ${proxyEnabled ? 'active' : ''}`}
            onClick={() => void handleProxyToggle()}
            disabled={proxyLoading}
            title={proxyEnabled ? 'Routing through remote host (click to use direct)' : 'Direct connection (click to route through remote host)'}
          >
            &#127760;
          </button>
        )}
        <button
          className={`browser-nav-btn devtools-btn ${devToolsOpen ? 'active' : ''}`}
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
      <div className="browser-content">
        {proxyReady ? (
          <webview
            ref={webviewRef}
            src={url}
            className="browser-webview"
            {...(partition ? { partition } : {})}
          />
        ) : (
          <div className="browser-proxy-loading">Connecting to remote host...</div>
        )}
      </div>
    </div>
  )
}
