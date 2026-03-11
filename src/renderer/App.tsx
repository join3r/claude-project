import React, { useState, useEffect } from 'react'
import { AppProvider, useApp } from './context/AppContext'
import { TabStatusProvider } from './context/TabStatusContext'
import Sidebar from './components/Sidebar'
import ContentArea from './components/ContentArea'

function AppInner(): React.ReactElement {
  const { effectiveTheme } = useApp()
  const [sidebarHidden, setSidebarHidden] = useState(false)

  useEffect(() => {
    return window.api.onMenuToggleSidebar(() => {
      setSidebarHidden(prev => !prev)
    })
  }, [])

  return (
    <div className={`app ${effectiveTheme === 'light' ? 'theme-light' : ''}${sidebarHidden ? ' sidebar-hidden' : ''}`}>
      {!sidebarHidden && <Sidebar />}
      <ContentArea />
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
