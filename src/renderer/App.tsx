import React, { useEffect, useRef, useState } from 'react'
import { AppProvider, useApp } from './context/AppContext'
import { TabStatusProvider } from './context/TabStatusContext'
import Sidebar from './components/Sidebar'
import ContentArea from './components/ContentArea'
import FileBrowserPanel from './components/FileBrowserPanel'
import { Palette } from './palette/Palette'
import { paletteEvents } from './palette/paletteEvents'

function AppInner(): React.ReactElement {
  const {
    effectiveTheme, exportWindowViewState, toggleFileBrowser, selectedProjectId, toggleWatchStripForProject,
    selectedTask, getTaskViewState,
    setFileBrowserOpen, setFileBrowserActiveTab
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

  useEffect(() => paletteEvents.on('toggle-sidebar', () => setSidebarHidden(p => !p)), [])
  useEffect(() => paletteEvents.on('toggle-file-browser', () => toggleFileBrowser()), [toggleFileBrowser])
  useEffect(() => paletteEvents.on('reload-window', () => window.location.reload()), [])
  useEffect(() => paletteEvents.on('open-devtools', () => {
    void window.api.openDevTools()
  }), [])
  useEffect(() => paletteEvents.on('quit-app', () => {
    void window.api.quitApp()
  }), [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'w') {
        if (selectedProjectId) {
          e.preventDefault()
          e.stopPropagation()
          toggleWatchStripForProject(selectedProjectId)
        }
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [selectedProjectId, toggleWatchStripForProject])

  const prevActiveTabIdRef = useRef<string | null>(null)
  useEffect(() => {
    if (!selectedTask) {
      prevActiveTabIdRef.current = null
      return
    }
    const view = getTaskViewState(selectedTask)
    const activeTabId = view.activeTab.left
    const activeTab = activeTabId
      ? selectedTask.tabs.left.find(t => t.id === activeTabId) ?? null
      : null
    const isOnHome = activeTab?.system === 'home'
    const wasOnHome = prevActiveTabIdRef.current
      ? selectedTask.tabs.left.some(t => t.id === prevActiveTabIdRef.current && t.system === 'home')
      : false
    if (isOnHome && !wasOnHome) {
      setFileBrowserOpen(true)
      setFileBrowserActiveTab('notes')
    }
    prevActiveTabIdRef.current = activeTabId
  }, [selectedTask, getTaskViewState, setFileBrowserOpen, setFileBrowserActiveTab])

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
      <Palette />
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
