import React, { useState, useRef, useEffect } from 'react'
import './BrowserTab.css'

interface Props {
  tabId: string
  visible: boolean
  initialUrl?: string
}

export default function BrowserTab({ tabId, visible, initialUrl }: Props): React.ReactElement {
  const [url, setUrl] = useState(initialUrl || 'https://www.google.com')
  const [inputUrl, setInputUrl] = useState(url)
  const [devToolsOpen, setDevToolsOpen] = useState(false)
  const webviewRef = useRef<Electron.WebviewTag>(null)

  useEffect(() => {
    const webview = webviewRef.current
    if (!webview) return

    const handleNavigation = () => {
      setUrl(webview.getURL())
      setInputUrl(webview.getURL())
    }

    webview.addEventListener('did-navigate', handleNavigation)
    webview.addEventListener('did-navigate-in-page', handleNavigation)

    return () => {
      webview.removeEventListener('did-navigate', handleNavigation)
      webview.removeEventListener('did-navigate-in-page', handleNavigation)
    }
  }, [])

  const navigate = (targetUrl: string) => {
    let normalized = targetUrl.trim()
    if (!normalized.startsWith('http://') && !normalized.startsWith('https://')) {
      normalized = 'https://' + normalized
    }
    setUrl(normalized)
    setInputUrl(normalized)
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      navigate(inputUrl)
    }
  }

  return (
    <div className="browser-tab" style={{ display: visible ? 'flex' : 'none' }}>
      <div className="browser-toolbar">
        <button className="browser-nav-btn" onClick={() => webviewRef.current?.goBack()}>&larr;</button>
        <button className="browser-nav-btn" onClick={() => webviewRef.current?.goForward()}>&rarr;</button>
        <button className="browser-nav-btn" onClick={() => webviewRef.current?.reload()}>&#8635;</button>
        <input
          className="browser-url"
          value={inputUrl}
          onChange={(e) => setInputUrl(e.target.value)}
          onKeyDown={handleKeyDown}
          spellCheck={false}
        />
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
          title="Toggle DevTools"
        >
          &#9874;
        </button>
      </div>
      <div className="browser-content">
        <webview
          ref={webviewRef}
          src={url}
          className="browser-webview"
        />
      </div>
    </div>
  )
}
