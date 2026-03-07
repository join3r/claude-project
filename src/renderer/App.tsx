import React from 'react'
import { AppProvider, useApp } from './context/AppContext'
import { TabStatusProvider } from './context/TabStatusContext'
import Sidebar from './components/Sidebar'
import ContentArea from './components/ContentArea'

function AppInner(): React.ReactElement {
  const { effectiveTheme } = useApp()
  return (
    <div className={`app ${effectiveTheme === 'light' ? 'theme-light' : ''}`}>
      <Sidebar />
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
