/**
 * DevTool status extension for the pi coding agent.
 *
 * Injected into pi via `-e <path>` when DevTool spawns a pi tab. It mirrors the
 * Claude Code hook integration: it POSTs lifecycle events to DevTool's local
 * hook-server so the tab's status dot reflects whether pi is working or waiting
 * for the user.
 *
 * Reused, unchanged pipeline (see src/main/hook-server.ts):
 *   agent_start -> POST /hook/working      -> tab status "working"
 *   agent_end   -> POST /hook/notification -> tab status "attention"
 *
 * The tab id and hook-server port are passed in via env by the spawn wiring in
 * src/main/app-runtime.ts (local: the direct port; remote/SSH: the reverse-tunnel
 * port, reached over the existing `ssh -R` forward).
 *
 * This is a plain ESM module (no build step) so it runs directly in pi's runtime.
 */
export default function devtoolStatus(pi) {
  const tabId = process.env.DEVTOOL_TAB_ID
  const port = process.env.DEVTOOL_HOOK_PORT
  if (!tabId || !port) return

  const post = (endpoint) => {
    try {
      // Fire-and-forget; never block or crash pi if the server is unreachable.
      fetch(`http://localhost:${port}/hook/${endpoint}`, {
        method: 'POST',
        headers: { 'X-Tab-Id': tabId, 'Content-Type': 'application/json' },
        body: '{}'
      }).catch(() => {})
    } catch {
      // ignore
    }
  }

  pi.on('agent_start', () => post('working'))
  pi.on('agent_end', () => post('notification'))
}
