import { app, BrowserWindow, Menu } from 'electron'
import { join } from 'path'
import { resolveShellEnv } from './shell-env'
import { AppRuntime } from './app-runtime'
import type { WindowGeometry, WindowViewState } from '../shared/types'

let appRuntime: AppRuntime | null = null

function buildAppMenu(): void {
  const isMac = process.platform === 'darwin'

  const sendToRenderer = (channel: string) => {
    const win = BrowserWindow.getFocusedWindow()
    if (win) win.webContents.send(channel)
  }

  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about' as const },
              { type: 'separator' as const },
              { role: 'services' as const },
              { type: 'separator' as const },
              { role: 'hide' as const },
              { role: 'hideOthers' as const },
              { role: 'unhide' as const },
              { type: 'separator' as const },
              { role: 'quit' as const }
            ]
          }
        ]
      : []),
    {
      label: 'File',
      submenu: [
        {
          label: 'New Window',
          accelerator: 'CmdOrCtrl+Shift+N',
          click: () => sendToRenderer('menu-new-window')
        },
        {
          label: 'New Terminal Tab',
          accelerator: 'CmdOrCtrl+T',
          click: () => sendToRenderer('menu-new-terminal')
        },
        {
          label: 'Close Tab',
          accelerator: 'CmdOrCtrl+W',
          click: () => sendToRenderer('menu-close-tab')
        },
        {
          label: 'Reopen Closed Tab',
          accelerator: 'CmdOrCtrl+Shift+T',
          click: () => sendToRenderer('menu-reopen-closed-tab')
        },
        {
          label: 'Project Switcher',
          accelerator: 'CmdOrCtrl+P',
          click: () => sendToRenderer('menu-project-switcher')
        },
        { type: 'separator' },
        isMac ? { role: 'close' as const, accelerator: '' } : { role: 'quit' as const }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' }
      ]
    },
    {
      label: 'View',
      submenu: [
        {
          label: 'Toggle Sidebar',
          accelerator: 'CmdOrCtrl+B',
          click: () => sendToRenderer('menu-toggle-sidebar')
        },
        {
          label: 'Toggle File Browser',
          accelerator: 'CmdOrCtrl+Shift+E',
          click: () => sendToRenderer('menu-toggle-file-browser')
        },
        { type: 'separator' },
        {
          label: 'Reload Tab',
          accelerator: 'CmdOrCtrl+R',
          click: () => sendToRenderer('menu-reload-tab')
        },
        { type: 'separator' },
        {
          label: 'Zoom In',
          accelerator: 'CmdOrCtrl+=',
          click: () => sendToRenderer('menu-zoom-in')
        },
        {
          label: 'Zoom Out',
          accelerator: 'CmdOrCtrl+-',
          click: () => sendToRenderer('menu-zoom-out')
        },
        {
          label: 'Reset Zoom',
          accelerator: 'CmdOrCtrl+0',
          click: () => sendToRenderer('menu-zoom-reset')
        },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { type: 'separator' },
        { role: 'toggleDevTools', accelerator: 'CmdOrCtrl+Alt+I' }
      ]
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        ...(isMac ? [{ type: 'separator' as const }, { role: 'front' as const }] : [])
      ]
    }
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function createWindow(initialViewState?: WindowViewState | null, geometry?: WindowGeometry | null): BrowserWindow {
  const mainWindow = new BrowserWindow({
    x: geometry?.x,
    y: geometry?.y,
    width: geometry?.width ?? 1200,
    height: geometry?.height ?? 800,
    minWidth: 800,
    minHeight: 600,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 12, y: 12 },
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      webviewTag: true
    }
  })

  appRuntime?.registerWindow(mainWindow, initialViewState ?? null)
  if (geometry?.isMaximized) {
    mainWindow.maximize()
  }

  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    console.error(`[renderer-load-failed] code=${errorCode} mainFrame=${isMainFrame} url=${validatedURL} error=${errorDescription}`)
  })
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    console.error(`[renderer-process-gone] reason=${details.reason} exitCode=${details.exitCode}`)
  })
  mainWindow.webContents.on('preload-error', (_event, preloadPath, error) => {
    console.error(`[preload-error] path=${preloadPath}`, error)
  })

  // On Linux, menu accelerators may not fire when titleBarStyle hides the menu bar.
  // Manually dispatch shortcuts via before-input-event as a reliable fallback.
  if (process.platform === 'linux') {
    mainWindow.webContents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown' || !input.control) return

      const send = (channel: string) => {
        mainWindow.webContents.send(channel)
        event.preventDefault()
      }

      const key = input.key.toLowerCase()

      if (input.shift) {
        if (key === 'n') send('menu-new-window')
        else if (key === 't') send('menu-reopen-closed-tab')
        else if (key === 'e') send('menu-toggle-file-browser')
        else if (key === 'v') { mainWindow.webContents.paste(); event.preventDefault() }
        else if (key === 'c') { mainWindow.webContents.copy(); event.preventDefault() }
      } else if (input.alt) {
        if (key === 'i') { mainWindow.webContents.toggleDevTools(); event.preventDefault() }
      } else {
        if (key === 't') send('menu-new-terminal')
        else if (key === 'w') send('menu-close-tab')
        else if (key === 'p') send('menu-project-switcher')
        else if (key === 'b') send('menu-toggle-sidebar')
        else if (key === 'r') send('menu-reload-tab')
        else if (key === '=') send('menu-zoom-in')
        else if (key === '-') send('menu-zoom-out')
        else if (key === '0') send('menu-zoom-reset')
        else if (key === 'q') { app.quit() }
      }
    })
  }

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return mainWindow
}

app.whenReady().then(async () => {
  await resolveShellEnv()
  appRuntime = new AppRuntime((initialViewState, geometry) => createWindow(initialViewState, geometry))
  await appRuntime.start()
  buildAppMenu()
  const startupWindows = appRuntime.getStartupWindowStates()
  if (startupWindows.length > 0) {
    for (const state of startupWindows) {
      createWindow(state.viewState, state.geometry)
    }
  } else {
    createWindow()
  }
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  appRuntime?.prepareForQuit()
  void appRuntime?.shutdown()
})
