import React from 'react'
import { AppProvider, useApp } from './context/AppContext'
import Sidebar from './components/Sidebar'

function AppInner(): React.ReactElement {
  const { effectiveTheme } = useApp()
  return (
    <div className={`app ${effectiveTheme === 'light' ? 'theme-light' : ''}`}>
      <Sidebar />
      <div className="content">
        <div className="content-empty">Select or create a task to get started</div>
      </div>
    </div>
  )
}

export default function App(): React.ReactElement {
  return (
    <AppProvider>
      <AppInner />
    </AppProvider>
  )
}
