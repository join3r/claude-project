export const FILE_BROWSER_REFRESH_MS = 2000

/**
 * Calls `fn` every FILE_BROWSER_REFRESH_MS while the window is visible, and
 * once when it comes back into view. Each tick spawns git/fs work in main, so
 * a minimized or covered window must not keep paying for it. Returns the cleanup.
 */
export function pollWhileVisible(fn: () => void): () => void {
  const runIfVisible = (): void => {
    if (document.visibilityState === 'visible') fn()
  }
  const intervalId = window.setInterval(runIfVisible, FILE_BROWSER_REFRESH_MS)
  document.addEventListener('visibilitychange', runIfVisible)
  return () => {
    window.clearInterval(intervalId)
    document.removeEventListener('visibilitychange', runIfVisible)
  }
}
