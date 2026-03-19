import { app, BrowserWindow, Menu } from 'electron'
import { join } from 'path'
import { resolveShellEnv } from './shell-env'
import { AppRuntime } from './app-runtime'
import type { WindowViewState } from '../shared/types'

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

function createWindow(initialViewState?: WindowViewState | null): BrowserWindow {
  const mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
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

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return mainWindow
}

app.whenReady().then(async () => {
  await resolveShellEnv()
  appRuntime = new AppRuntime((initialViewState) => createWindow(initialViewState))
  await appRuntime.start()
  buildAppMenu()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  void appRuntime?.shutdown()
})
