/** Catch Electron IPC errors without a native alert. */
export async function openWorkspaceInIde(editorId: string, folder: string, projectId?: string): Promise<string | null> {
  try {
    await window.api.openInIde(editorId, folder, projectId)
    return null
  } catch (error) {
    const raw = error instanceof Error ? error.message : String(error)
    return raw.replace(/^Error invoking remote method '[^']+': (?:Error: )?/u, '')
  }
}
