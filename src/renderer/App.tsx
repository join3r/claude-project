import React, { useState, useEffect } from 'react'
import { AppProvider, useApp } from './context/AppContext'
import { TabStatusProvider } from './context/TabStatusContext'
import Sidebar from './components/Sidebar'
import ContentArea from './components/ContentArea'
import FileBrowserPanel from './components/FileBrowserPanel'

function AppInner(): React.ReactElement {
  const { effectiveTheme, exportWindowViewState, toggleFileBrowser } = useApp()
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

  // Mirror theme-light onto documentElement so getComputedStyle(documentElement)
  // resolves CSS custom properties via the .theme-light cascade. Used by xterm
  // theme construction in TerminalTab/AiToolTab and any other CSS-var reader.
  useEffect(() => {
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
