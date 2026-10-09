import React, { useEffect, useLayoutEffect, useState } from 'react'
import { AppProvider, useApp } from './context/AppContext'
import { TabStatusProvider } from './context/TabStatusContext'
import Sidebar from './components/Sidebar'
import ContentArea from './components/ContentArea'
import FileBrowserPanel from './components/FileBrowserPanel'
import { Palette } from './palette/Palette'
import MobilePairingPrompt from './components/MobilePairingPrompt'
import ServerIdeConsentModal from './components/servers/ServerIdeConsentModal'
import Toasts from './components/Toasts'
import { paletteEvents } from './palette/paletteEvents'

function AppInner(): React.ReactElement {
  const {
    effectiveTheme, exportWindowViewState, toggleFileBrowser
  } = useApp()
  const [sidebarHidden, setSidebarHidden] = useState(false)
  const [switcherRequested, setSwitcherRequested] = useState(false)

  useEffect(() => {
    return window.api.onMenuToggleSidebar(() => {
      setSidebarHidden(prev => !prev)
    })
  }, [])

  useEffect(() => {
    return window.api.onMenuProjectSwitcher(() => {
      if (sidebarHidden) {
        setSidebarHidden(false)
        setSwitcherRequested(true)
      }
      // When sidebar is visible, the Sidebar's own listener handles it
    })
  }, [sidebarHidden])

  useEffect(() => {
    return window.api.onMenuToggleFileBrowser(() => {
      toggleFileBrowser()
    })
  }, [toggleFileBrowser])

  useEffect(() => {
    return window.api.onMenuNewWindow(() => {
      void window.api.openWindow(exportWindowViewState())
    })
  }, [exportWindowViewState])

  // The New task composer and New stream dialog live in the Sidebar. With it hidden,
  // Project Home's buttons, the tab bar's "New task in…" and ⌘N show it and replay
  // the request once its listeners are mounted (child effects run first).
  const [replay, setReplay] = useState<(() => void) | null>(null)
  useEffect(() => {
    if (!sidebarHidden) return
    const show = (fn: () => void): void => { setSidebarHidden(false); setReplay(() => fn) }
    const offs = [
      paletteEvents.on('open-new-task', () => show(() => paletteEvents.emit('open-new-task'))),
      paletteEvents.on('open-new-task-in', where => show(() => paletteEvents.emit('open-new-task-in', where))),
      paletteEvents.on('open-new-stream', projectId => show(() => paletteEvents.emit('open-new-stream', projectId))),
      window.api.onMenuNewTask(() => show(() => paletteEvents.emit('open-new-task')))
    ]
    return () => offs.forEach(off => off())
  }, [sidebarHidden])
  useEffect(() => {
    if (!replay || sidebarHidden) return
    setReplay(null)
    replay()
  }, [replay, sidebarHidden])

  useEffect(() => paletteEvents.on('toggle-sidebar', () => setSidebarHidden(p => !p)), [])
  useEffect(() => paletteEvents.on('toggle-file-browser', () => toggleFileBrowser()), [toggleFileBrowser])
  useEffect(() => paletteEvents.on('reload-window', () => window.location.reload()), [])
  useEffect(() => paletteEvents.on('open-devtools', () => {
    void window.api.openDevTools()
  }), [])
  useEffect(() => paletteEvents.on('quit-app', () => {
    void window.api.quitApp()
  }), [])

  // Mirror theme-light onto documentElement so getComputedStyle(documentElement)
  // resolves CSS custom properties via the .theme-light cascade. Used by xterm
  // theme construction in TerminalTab/AiToolTab and any other CSS-var reader.
  // Must be a layout effect — child useEffects fire before parent useEffects,
  // so a regular effect here would leave terminals reading stale CSS vars on
  // the first commit after a theme flip.
  useLayoutEffect(() => {
    document.documentElement.classList.toggle('theme-light', effectiveTheme === 'light')
  }, [effectiveTheme])

  return (
    <div className={`h-full w-full flex bg-bg text-text font-sans${effectiveTheme === 'light' ? ' theme-light' : ''}${sidebarHidden ? ' sidebar-hidden' : ''}`}>
      {!sidebarHidden && (
        <Sidebar
          switcherRequested={switcherRequested}
          onSwitcherConsumed={() => setSwitcherRequested(false)}
        />
      )}
      <ContentArea />
      <FileBrowserPanel />
      <Palette />
      <MobilePairingPrompt />
      <ServerIdeConsentModal />
      <Toasts />
    </div>
  )
}

export default function App(): React.ReactElement {
  return (
    <AppProvider>
      <TabStatusProvider>
        <AppInner />
      </TabStatusProvider>
    </AppProvider>
  )
}
