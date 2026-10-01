import { app, BrowserWindow, dialog, Menu, shell, systemPreferences } from 'electron'
import { join } from 'path'
import { installBrokenPipeUncaughtHandler } from './broken-pipe'
import { pathToFileURL } from 'url'
import { resolveShellEnv } from './shell-env'
import { listCondaEnvs } from './conda-env'
import { AppRuntime } from './app-runtime'
import { CONFIG_DIR } from './config-dir'
import { acquireInstanceLock } from './instance-lock'
import type { WindowGeometry, WindowViewState } from '../shared/types'
import { isMenuZoomInKey } from '../shared/shortcut-label'

// Closed-pipe EIO/EPIPE after helper teardown must not show Electron's
// "Uncaught Exception" modal. Other errors still go to Electron's handler
// (do not rethrow — that aborts instead of the recoverable dialog).
installBrokenPipeUncaughtHandler()

// Name the app DevTool, not the package's lowercase `devtool` (menu bar, About,
// notifications). Renaming also moves Electron's default userData, which would
// put dev runs (`<appData>/devtool`) on the packaged app's `<appData>/DevTool` —
// the same folder on case-insensitive macOS/Windows disks. Pin the old path so
// dev and prod Chromium storage stay apart, like the config dirs do.
const userDataPath = app.getPath('userData')
app.setName('DevTool')
app.setPath('userData', userDataPath)
if (process.platform === 'win32') {
  // Matches build.appId, which NSIS stamps on the Start Menu shortcut, so the
  // taskbar groups installed windows under that shortcut. Dev runs get their own id.
  app.setAppUserModelId(app.isPackaged ? 'com.devtool.app' : 'com.devtool.app.dev')
}
/** Packaged via build.files; the project root in dev. */
const APP_ICON_PATH = join(app.getAppPath(), 'build', 'icon.png')

if (process.env.DEVTOOL_CDP_PORT) {
  app.commandLine.appendSwitch('remote-debugging-port', process.env.DEVTOOL_CDP_PORT)
}

/**
 * Browser tabs stay — they are how the agent (and the user) open web pages.
 * Visited pages must not get Node or a preload into DevTool's IPC.
 * Register before any BrowserWindow / <webview> is created.
 */
app.on('web-contents-created', (_event, contents) => {
  contents.on('will-attach-webview', (_attachEvent, webPreferences) => {
    webPreferences.nodeIntegration = false
    webPreferences.nodeIntegrationInSubFrames = false
    webPreferences.contextIsolation = true
    webPreferences.sandbox = true
    webPreferences.webSecurity = true
    delete webPreferences.preload
    delete (webPreferences as { preloadURL?: string }).preloadURL
  })
})

let appRuntime: AppRuntime | null = null
let releaseInstanceLock: (() => void) | null = null

const RENDERER_INDEX_PATH = join(__dirname, '../renderer/index.html')

/** The only document a main window may show: the dev server in dev, the bundled index in prod. */
function isAppUrl(url: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (process.env.ELECTRON_RENDERER_URL) {
    try {
      return parsed.origin === new URL(process.env.ELECTRON_RENDERER_URL).origin
    } catch {
      return false
    }
  }
  return parsed.protocol === 'file:' && parsed.pathname === pathToFileURL(RENDERER_INDEX_PATH).pathname
}

/** Same rule as the `open-external` IPC handler: only http(s) leaves the app. */
function openExternalIfWeb(url: string): void {
  try {
    const parsed = new URL(url)
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      void shell.openExternal(parsed.toString()).catch(() => {})
    }
  } catch {
    // not a URL: drop it
  }
}

/**
 * The main renderer holds the full `window.api`; a stray link click or window.open
 * must never swap it for remote content. <webview> guests are separate webContents
 * and are not affected by these handlers.
 */
function guardMainWindowNavigation(win: BrowserWindow): void {
  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternalIfWeb(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event, url) => {
    if (isAppUrl(url)) return
    event.preventDefault()
    openExternalIfWeb(url)
  })
  win.webContents.on('will-redirect', (event, url, _isInPlace, isMainFrame) => {
    if (isMainFrame && !isAppUrl(url)) event.preventDefault()
  })
}

function focusExistingWindow(): void {
  const windows = BrowserWindow.getAllWindows()
  const win = BrowserWindow.getFocusedWindow() ?? windows[0]
  if (!win) {
    // macOS keeps the app alive with no windows; a relaunch should bring one back.
    if (appRuntime) createWindow()
    return
  }
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
  if (process.platform === 'darwin') app.focus({ steal: true })
}

/** App menu → Check for Updates…: check now, answer in a dialog. */
async function checkForUpdatesFromMenu(): Promise<void> {
  const updates = appRuntime?.getUpdates()
  if (!updates) return
  const owner = BrowserWindow.getFocusedWindow()
  const show = (options: Electron.MessageBoxOptions) =>
    owner ? dialog.showMessageBox(owner, options) : dialog.showMessageBox(options)
  if (updates.status().mode === 'none') {
    await show({ type: 'info', message: 'Updates are off in development runs', detail: `DevTool ${app.getVersion()}` })
    return
  }
  const status = await updates.check()
  if (status.state === 'error') {
    await show({ type: 'warning', message: 'Could not check for updates', detail: status.error ?? '' })
    return
  }
  if (!status.available) {
    await show({ type: 'info', message: 'DevTool is up to date', detail: `Version ${status.appVersion}` })
    return
  }
  if (status.mode === 'auto') {
    await show({
      type: 'info',
      message: `DevTool ${status.available} is downloading`,
      detail: 'It installs when you quit DevTool, or restart from Settings → Updates once it is ready.'
    })
    return
  }
  const { response } = await show({
    type: 'info',
    message: `DevTool ${status.available} is available`,
    detail: `You have ${status.appVersion}. Download it from the release page.`,
    buttons: ['Open Release Page', 'Later'],
    defaultId: 0,
    cancelId: 1
  })
  if (response === 0) await updates.install()
}

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
              { label: 'Check for Updates…', click: () => void checkForUpdatesFromMenu() },
              { type: 'separator' as const },
              {
                label: 'Settings...',
                accelerator: 'Cmd+,',
                click: () => sendToRenderer('menu-open-settings')
              },
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
          label: 'New Task',
          accelerator: 'CmdOrCtrl+N',
          click: () => sendToRenderer('menu-new-task')
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
        // Mac keyboards type + as Shift+=. Cmd+= is registered above; this
        // hidden duplicate catches Cmd+Plus so Zoom In fires without Shift
        // *or* with it. Windows/Linux register the accelerator even when hidden.
        {
          label: 'Zoom In',
          accelerator: 'CmdOrCtrl+Plus',
          visible: false,
          acceleratorWorksWhenHidden: true,
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
    },
    ...(isMac
      ? []
      : [{
          label: 'Help',
          submenu: [{ label: 'Check for Updates…', click: () => void checkForUpdatesFromMenu() }]
        }])
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
    // macOS takes the bundle icon; Windows/Linux need it per window in dev (and Linux always).
    ...(process.platform === 'darwin' ? {} : { icon: APP_ICON_PATH }),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webviewTag: true
    }
  })

  guardMainWindowNavigation(mainWindow)
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

      // Zoom In: Ctrl+=, Ctrl++, and Ctrl+Shift+= (key is often '+' or '=').
      // Check before the Shift split so Shift+= is not swallowed unused.
      if (!input.alt && isMenuZoomInKey(key)) {
        send('menu-zoom-in')
        return
      }

      if (input.shift) {
        if (key === 'n') send('menu-new-window')
        else if (key === 't') send('menu-reopen-closed-tab')
        else if (key === 'e') send('menu-toggle-file-browser')
        else if (key === 'v') { mainWindow.webContents.paste(); event.preventDefault() }
        else if (key === 'c') { mainWindow.webContents.copy(); event.preventDefault() }
      } else if (input.alt) {
        if (key === 'i') { mainWindow.webContents.toggleDevTools(); event.preventDefault() }
      } else {
        if (key === 'n') send('menu-new-task')
        else if (key === 't') send('menu-new-terminal')
        else if (key === 'w') send('menu-close-tab')
        else if (key === 'p') send('menu-project-switcher')
        else if (key === 'b') send('menu-toggle-sidebar')
        else if (key === 'r') send('menu-reload-tab')
        else if (key === '-') send('menu-zoom-out')
        else if (key === '0') send('menu-zoom-reset')
        else if (key === 'q') { app.quit() }
      }
    })
  }

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void mainWindow.loadFile(RENDERER_INDEX_PATH)
  }

  return mainWindow
}

app.whenReady().then(async () => {
  // Before anything reads or writes the config dir: a second instance on the same
  // dir would clobber the first one's saves.
  const lock = await acquireInstanceLock(CONFIG_DIR, () => {
    if (app.isReady()) focusExistingWindow()
  })
  if (!lock.acquired) {
    console.error(
      `[instance-lock] DevTool is already running on ${CONFIG_DIR}` +
      (lock.ownerPid ? ` (pid ${lock.ownerPid})` : '') + '; handing over and exiting'
    )
    app.exit(0)
    return
  }
  releaseInstanceLock = lock.release
  if (process.platform === 'darwin' && !app.isPackaged) {
    // Dev runs Electron.app, whose bundle icon is Electron's.
    app.dock?.setIcon(APP_ICON_PATH)
  }
  await resolveShellEnv()
  // Warm the conda env list so the first local PTY can resolve a saved name without waiting.
  void listCondaEnvs().catch(() => {})
  if (process.platform === 'darwin') {
    // Trigger the macOS mic-access prompt so terminal subprocesses (e.g. Claude Code voice mode)
    // can inherit the grant. Without this, pty children hit TCC with no Info.plist in their
    // responsibility chain and get denied silently, with no dialog.
    void systemPreferences.askForMediaAccess('microphone').catch(() => {})
  }
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

// Released at process exit, not will-quit: shutdown still writes to the config dir,
// and a crashed owner is detected as stale by the next launch anyway.
process.on('exit', () => {
  releaseInstanceLock?.()
})
