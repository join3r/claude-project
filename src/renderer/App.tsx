import React, { useCallback, useEffect, useLayoutEffect, useState } from 'react'
import { AppProvider, useApp } from './context/AppContext'
import { TabStatusProvider } from './context/TabStatusContext'
import Sidebar from './components/Sidebar'
import ContentArea from './components/ContentArea'
import FileBrowserPanel from './components/FileBrowserPanel'
import MobilePairingPrompt from './components/MobilePairingPrompt'
import ServerIdeConsentModal from './components/servers/ServerIdeConsentModal'
import Toasts from './components/Toasts'
import StreamRunHost from './components/StreamRunHost'
import EntityActionsHost from './components/EntityActionsHost'
import { paletteEvents } from './palette/paletteEvents'
import { useTaskPreviewSync } from './components/desk/useTaskPreviewSync'
import { toggleBench, toggleBenchView } from './components/desk/benchState'
import DeskStatusBar from './components/desk/DeskStatusBar'
import DeskCommandBar from './components/desk/DeskCommandBar'
import { TokenUsageModal } from './components/TokenUsage'
import FirstRunWorktreesPrompt from './components/FirstRunWorktreesPrompt'

function AppInner(): React.ReactElement {
  const {
    effectiveTheme, exportWindowViewState, toggleFileBrowser: toggleSidePanel, selectedTaskId, selectedProjectId
  } = useApp()
  // A task's Files are a Bench tab; the side panel serves a project's map.
  const toggleFileBrowser = useCallback(() => {
    if (selectedTaskId) toggleBenchView(selectedTaskId, 'files')
    else toggleSidePanel()
  }, [selectedTaskId, toggleSidePanel])
  useTaskPreviewSync()
  const [sidebarHidden, setSidebarHidden] = useState(false)

  useEffect(() => {
    return window.api.onMenuToggleSidebar(() => {
      setSidebarHidden(prev => !prev)
    })
  }, [])

  // ⌘P (the menu's Go to…) opens the bar, like ⌘K, even with the column hidden.
  useEffect(() => window.api.onMenuProjectSwitcher(() => paletteEvents.emit('palette-prefix-set', '')), [])

  useEffect(() => {
    return window.api.onMenuToggleFileBrowser(() => {
      toggleFileBrowser()
    })
  }, [toggleFileBrowser])

  useEffect(() => {
    return window.api.onMenuToggleBench(() => {
      if (selectedTaskId) toggleBench(selectedTaskId)
    })
  }, [selectedTaskId])

  useEffect(() => {
    return window.api.onMenuNewWindow(() => {
      void window.api.openWindow(exportWindowViewState())
    })
  }, [exportWindowViewState])

  // The compose box, Settings and the New stream / project / task dialogs live in the Sidebar.
  // With it hidden, the map's buttons, the tab bar's "New task in…", ⌘N, ⌘, and the status bar show it
  // and replay the request once its listeners are mounted (child effects run first).
  const [replay, setReplay] = useState<(() => void) | null>(null)
  useEffect(() => {
    if (!sidebarHidden) return
    const show = (fn: () => void): void => { setSidebarHidden(false); setReplay(() => fn) }
    const offs = [
      paletteEvents.on('open-new-task', () => show(() => paletteEvents.emit('open-new-task'))),
      paletteEvents.on('open-new-task-in', where => show(() => paletteEvents.emit('open-new-task-in', where))),
      paletteEvents.on('open-new-task-form', request => show(() => paletteEvents.emit('open-new-task-form', request))),
      paletteEvents.on('open-new-stream', projectId => show(() => paletteEvents.emit('open-new-stream', projectId))),
      paletteEvents.on('open-new-project', () => show(() => paletteEvents.emit('open-new-project'))),
      // Settings is the Sidebar's too: ⌘, , ⌘K's >Settings and the status bar's hosts and phone.
      paletteEvents.on('open-settings', () => show(() => paletteEvents.emit('open-settings'))),
      paletteEvents.on('open-settings-tab', tab => show(() => paletteEvents.emit('open-settings-tab', tab))),
      paletteEvents.on('open-add-server', () => show(() => paletteEvents.emit('open-add-server'))),
      window.api.onMenuOpenSettings(() => show(() => paletteEvents.emit('open-settings'))),
      window.api.onMenuNewTask(() => show(() => paletteEvents.emit('open-new-task'))),
      window.api.onMenuNewStream(() => {
        if (selectedProjectId) show(() => paletteEvents.emit('open-new-stream', selectedProjectId))
      })
    ]
    return () => offs.forEach(off => off())
  }, [sidebarHidden, selectedProjectId])
  useEffect(() => {
    if (!replay || sidebarHidden) return
    setReplay(null)
    replay()
  }, [replay, sidebarHidden])

  const [tokenUsageOpen, setTokenUsageOpen] = useState(false)
  useEffect(() => paletteEvents.on('open-token-usage', () => setTokenUsageOpen(true)), [])
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

  // The desk's graphite tokens (styles.css) hang off <html>, for the same CSS-var readers.
  useLayoutEffect(() => {
    document.documentElement.classList.add('layout-desk')
  }, [])

  return (
    <div className={`h-full w-full flex flex-col bg-bg text-text font-sans${effectiveTheme === 'light' ? ' theme-light' : ''}${sidebarHidden ? ' sidebar-hidden' : ''} layout-desk`}>
      <div className="flex-1 min-h-0 flex">
        {!sidebarHidden && <Sidebar />}
        <ContentArea />
        <FileBrowserPanel />
      </div>
      <DeskStatusBar />
      <DeskCommandBar />
      <MobilePairingPrompt />
      <FirstRunWorktreesPrompt />
      <ServerIdeConsentModal />
      <StreamRunHost />
      <EntityActionsHost />
      {tokenUsageOpen && <TokenUsageModal onClose={() => setTokenUsageOpen(false)} />}
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
