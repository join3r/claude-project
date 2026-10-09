import { askServerIdeConsent } from './serverIdeConsent'

function readable(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  return raw.replace(/^Error invoking remote method '[^']+': (?:Error: )?/u, '')
}

/**
 * Opens a project folder in an editor, catching IPC errors without a native
 * alert (the message comes back for the caller to show). A DevTool server's
 * project (`serverId`) opens over SSH; its first use asks the user first.
 */
export async function openWorkspaceInIde(editorId: string, folder: string, projectId?: string, serverId?: string): Promise<string | null> {
  try {
    if (projectId && serverId) {
      const state = await window.api.serverIdeState(projectId)
      if (state && (state.needsInclude || state.needsKey)) {
        if (!await askServerIdeConsent(state)) return null
        await window.api.serverIdeSetup(projectId, { include: state.needsInclude, key: state.needsKey })
      }
    }
    await window.api.openInIde(editorId, folder, projectId)
    return null
  } catch (error) {
    return readable(error)
  }
}
