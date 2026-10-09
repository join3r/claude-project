import { app, BrowserWindow, clipboard, dialog, nativeTheme, shell } from 'electron'
import type { AppConfig, WindowViewState } from '../../shared/types'
import { detectExternalEditors, openFolderInEditor } from '../external-ide'
import { resolveSafeProjectPath } from '../project-fs-path'
import type { IpcContext, IpcRegistrar } from './registrar'
import { optSafeId, str, windowViewState } from './schemas'
import { v } from './validate'

/** A desktop call's context: the local window it came from. */
export interface WindowIpcContext extends IpcContext {
  window: BrowserWindow
}

export interface WindowDeps {
  /** The view state main holds for `windowId`, or a fresh one for an unknown window. */
  loadViewState: (windowId: number) => WindowViewState
  saveViewState: (window: BrowserWindow, viewState: WindowViewState) => void
  openWindow: (viewState: WindowViewState | null) => void
  getConfig: () => AppConfig
  /** Throws unless `folder` is a known local project/workspace directory. */
  assertAllowedDirectory: (folder: string) => Promise<string>
  /** A DevTool server's project: its folders are on that server, not here. */
  isServerProject?: (projectId: string) => boolean
}

const NOT_ON_THIS_COMPUTER = 'This project is on a DevTool server; its folders aren\'t on this computer.'

/** Only web URLs leave the app through the OS browser. */
export function parseExternalUrl(url: string): URL {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error('Invalid URL')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Only http and https URLs are allowed')
  }
  return parsed
}

/** Window state, native dialogs, clipboard, theme, external links and IDE launching. */
export function registerWindowHandlers(ipc: IpcRegistrar<WindowIpcContext>, deps: WindowDeps): void {
  ipc.handle('load-window-state', [], (ctx) => deps.loadViewState(ctx.window.id))

  ipc.handle('save-window-state', [windowViewState], (ctx, viewState) => {
    deps.saveViewState(ctx.window, viewState)
    return undefined
  })

  ipc.handle('open-window', [v.optional(windowViewState)], (_event, viewState) => {
    deps.openWindow(viewState ?? null)
  })

  ipc.handle('pick-directory', [], async (ctx) => {
    const options: Electron.OpenDialogOptions = { properties: ['openDirectory'] }
    const result = await dialog.showOpenDialog(ctx.window, options)
    return result.canceled ? null : result.filePaths[0]
  })

  ipc.handle('pick-file', [v.optional(v.string({ max: 500 }))], async (ctx, title) => {
    const options: Electron.OpenDialogOptions = {
      title: title || 'Select file',
      properties: ['openFile', 'showHiddenFiles']
    }
    const result = await dialog.showOpenDialog(ctx.window, options)
    return result.canceled ? null : result.filePaths[0]
  })

  ipc.handle('get-native-theme', [], () => nativeTheme.shouldUseDarkColors ? 'dark' : 'light')
  ipc.handle('clipboard-write-text', [str], (_event, text) => {
    clipboard.writeText(text)
    return undefined
  })
  ipc.handle('clipboard-read-text', [], () => clipboard.readText())
  ipc.handle('open-external', [str], async (_event, url) => {
    await shell.openExternal(parseExternalUrl(url).toString())
  })

  ipc.handle('app:open-devtools', [], (ctx) => {
    ctx.window.webContents.openDevTools()
  })
  ipc.handle('app:quit', [], () => app.quit())

  // "Reveal in Finder": a project/workspace directory opens; a file or folder under one is selected in its parent.
  ipc.handle('reveal-in-folder', [v.string({ nonEmpty: true }), v.optional(v.string()), optSafeId], async (_event, folder, relativePath, projectId) => {
    if (projectId && deps.isServerProject?.(projectId)) throw new Error(NOT_ON_THIS_COMPUTER)
    const root = await deps.assertAllowedDirectory(folder)
    if (relativePath) {
      shell.showItemInFolder(resolveSafeProjectPath(root, relativePath))
      return undefined
    }
    const error = await shell.openPath(root)
    if (error) throw new Error(error)
    return undefined
  })

  ipc.handle('external-ide-detect', [], () => detectExternalEditors())
  ipc.handle('open-in-ide', [v.string({ nonEmpty: true }), v.string({ nonEmpty: true }), optSafeId], async (_event, editorId, folder, projectId) => {
    if (projectId && deps.isServerProject?.(projectId)) throw new Error(NOT_ON_THIS_COMPUTER)
    const editors = deps.getConfig().externalEditors?.editors ?? []
    const editor = editors.find((item) => item.id === editorId)
    if (!editor) throw new Error('That editor is not in Settings.')
    await deps.assertAllowedDirectory(folder)
    await openFolderInEditor(editor, folder)
    return undefined
  })
}
