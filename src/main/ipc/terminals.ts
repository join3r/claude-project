import type { PtyAttachResult, PtySessions } from '../pty-sessions'
import type { IpcRegistrar } from './registrar'
import { dimension, envRecord, optSafeId, optSshConfig, safeId, str, stringList } from './schemas'
import { v } from './validate'

export interface TerminalDeps {
  ptySessions: PtySessions
  log: (message: string) => void
}

/**
 * PTY tabs and their scrollback.
 *
 * `pty-spawn` deliberately takes any `shell`, `args` and `cwd`: the renderer
 * legitimately runs arbitrary commands (`/bin/sh -c <shell command>` projects
 * started in `/`, terminals opened on any sub-directory, agent CLIs with
 * user-supplied flags), so an allow-list on `cwd` alone would restrict nothing.
 * Arguments are type-checked; the trust boundary is the sender check.
 */
export function registerTerminalHandlers(ipc: IpcRegistrar, deps: TerminalDeps): void {
  const { ptySessions, log } = deps

  ipc.handle('scrollback-save', [safeId, str], (_event, tabId, data) => {
    ptySessions.saveScrollback(tabId, data)
    return undefined
  })
  ipc.handle('scrollback-load', [safeId], (_event, tabId) => ptySessions.loadScrollback(tabId))
  ipc.handle('scrollback-delete', [safeId], (_event, tabId) => {
    ptySessions.discardScrollback(tabId)
    return undefined
  })
  // Answers a window's `sendSync` while it unloads, so it stays a local window's call.
  ipc.onSync('scrollback-save-sync', [safeId, str], (_event, tabId, data) => {
    ptySessions.saveScrollback(tabId, data)
    return true
  }, false)

  ipc.handle(
    'pty-spawn',
    [safeId, str, str, dimension, dimension, v.optional(stringList), envRecord, optSafeId, optSshConfig],
    async (ctx, id, shell, cwd, cols, rows, args, extraEnv, projectId, sshConfig): Promise<PtyAttachResult> => {
      const resolvedShell = shell || '(local default)'
      log(`ptySpawnRequest clientId=${ctx.clientId} id=${id} shell=${resolvedShell} cwd=${cwd} cols=${cols} rows=${rows}`)
      return ptySessions.attachOrCreate(ctx.clientId, {
        id, shell: resolvedShell, cwd, cols, rows, args, extraEnv, projectId, sshConfig
      })
    }
  )

  ipc.on('pty-write', [safeId, str], (ctx, id, data) => {
    ptySessions.write(ctx.clientId, id, data)
  })

  ipc.on('pty-resize', [safeId, dimension, dimension], (ctx, id, cols, rows) => {
    ptySessions.resize(ctx.clientId, ctx.isFocused(), id, cols, rows)
  })

  ipc.on('pty-kill', [safeId], (_event, id) => {
    ptySessions.kill(id)
  })
}
