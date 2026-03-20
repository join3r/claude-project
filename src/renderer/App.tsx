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

  return (
    <div className={`app ${effectiveTheme === 'light' ? 'theme-light' : ''}${sidebarHidden ? ' sidebar-hidden' : ''}`}>
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
