import { app, BrowserWindow, Menu } from 'electron'
import { join } from 'path'
import { registerIpcHandlers } from './ipc-handlers'
import { resolveShellEnv } from './shell-env'

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
          label: 'New Terminal Tab',
          accelerator: 'CmdOrCtrl+T',
          click: () => sendToRenderer('menu-new-terminal')
        },
        {
          label: 'Close Tab',
          accelerator: 'CmdOrCtrl+W',
          click: () => sendToRenderer('menu-close-tab')
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
          label: 'Reload Tab',
          accelerator: 'CmdOrCtrl+R',
          click: () => sendToRenderer('menu-reload-tab')
        },
        { type: 'separator' },
        { role: 'togglefullscreen' }
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

function createWindow(): void {
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

  registerIpcHandlers(mainWindow).then(() => {
    if (process.env.ELECTRON_RENDERER_URL) {
      mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
    } else {
      mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
    }
  })
}

app.whenReady().then(async () => {
  await resolveShellEnv()
  buildAppMenu()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
