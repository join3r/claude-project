import type { NotebookKernelCondaOverride } from '../../shared/notebook'
import type { CondaListResult } from '../../shared/conda'
import { parseNotebookExecuteIpc } from '../../shared/notebook-execute'
import type { IpcRegistrar } from './registrar'
import { optSafeId, safeId, str } from './schemas'
import { v } from './validate'

export interface NotebookDeps {
  /** Resolve project, cwd and conda env, then start the tab's kernel. */
  startKernel: (
    tabId: string,
    projectId: string,
    cwd: string,
    condaOverride?: NotebookKernelCondaOverride | null
  ) => Promise<{ error?: string; code?: string }>
  execute: (tabId: string, requestId: string, code: string, cellId?: string) => { error?: string }
  interrupt: (tabId: string) => void
  shutdown: (tabId: string) => void
  listCondaEnvs: () => Promise<CondaListResult>
}

const condaOverride = v.optional(v.object({
  name: v.optional(v.string()),
  prefix: v.optional(v.string())
}))

/**
 * Native notebook tabs: one Jupyter kernel per tab, run in the
 * project's conda env. `cwd` is re-checked against the project's allowed roots in
 * `startKernel`, and execute payloads keep their own parser (`parseNotebookExecuteIpc`)
 * so its error messages stay the ones the tab shows.
 */
export function registerNotebookHandlers(ipc: IpcRegistrar, deps: NotebookDeps): void {
  ipc.handle('conda-list-envs', [optSafeId], () => deps.listCondaEnvs())

  ipc.handle('notebook-kernel-start', [safeId, safeId, str, condaOverride], (_event, tabId, projectId, cwd, override) =>
    deps.startKernel(tabId, projectId, cwd, override)
  )

  ipc.handle('notebook-kernel-execute', [v.unknown, v.unknown, v.unknown, v.unknown], (_event, tabId, requestId, code, cellId) => {
    const parsed = parseNotebookExecuteIpc(tabId, requestId, code, cellId)
    if (!parsed.ok) return { error: parsed.error }
    return deps.execute(parsed.value.tabId, parsed.value.requestId, parsed.value.code, parsed.value.cellId)
  })

  ipc.handle('notebook-kernel-interrupt', [safeId], (_event, tabId) => {
    deps.interrupt(tabId)
    return undefined
  })

  ipc.handle('notebook-kernel-restart', [safeId, safeId, str, condaOverride], (_event, tabId, projectId, cwd, override) => {
    deps.shutdown(tabId)
    return deps.startKernel(tabId, projectId, cwd, override)
  })

  ipc.handle('notebook-kernel-shutdown', [safeId], (_event, tabId) => {
    deps.shutdown(tabId)
    return undefined
  })
}
