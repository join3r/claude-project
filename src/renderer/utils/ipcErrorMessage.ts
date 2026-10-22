/** A main-process error as the user should read it, without Electron's "Error invoking remote method" prefix. */
export function ipcErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  return raw.replace(/^Error invoking remote method '[^']+': (?:Error: )?/u, '')
}
