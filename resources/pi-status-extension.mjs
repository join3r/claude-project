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
 * Before each turn it also asks POST /hook/context for DevTool's note on where
 * pi runs (task, stream, branch, that DevTool lands the work; see
 * src/main/agent-context.ts) and appends it to the system prompt.
 *
 * The tab id, hook-server port, and shared secret are passed in via env by the
 * spawn wiring in src/main/app-runtime.ts (local: the direct port; remote/SSH:
 * the reverse-tunnel port, reached over the existing `ssh -R` forward).
 *
 * Header / env names must stay in sync with src/shared/hook-protocol.ts.
 *
 * This is a plain ESM module (no build step) so it runs directly in pi's runtime.
 */
export default function devtoolStatus(pi) {
  const tabId = process.env.DEVTOOL_TAB_ID
  const port = process.env.DEVTOOL_HOOK_PORT
  const token = process.env.DEVTOOL_HOOK_TOKEN
  if (!tabId || !port || !token) return

  const post = (endpoint) => {
    try {
      // Fire-and-forget; never block or crash pi if the server is unreachable.
      fetch(`http://localhost:${port}/hook/${endpoint}`, {
        method: 'POST',
        headers: {
          'X-Tab-Id': tabId,
          'X-Devtool-Token': token,
          'Content-Type': 'application/json'
        },
        body: '{}'
      }).catch(() => {})
    } catch {
      // ignore
    }
  }

  // The last note DevTool gave, for a turn where it can't be reached.
  let context = ''
  const fetchContext = async () => {
    try {
      const res = await fetch(`http://localhost:${port}/hook/context`, {
        method: 'POST',
        headers: { 'X-Tab-Id': tabId, 'X-Devtool-Token': token, 'Content-Type': 'application/json' },
        body: '{}',
        signal: AbortSignal.timeout(2000)
      })
      if (res.ok) context = (await res.text()).trim()
    } catch {
      // keep the last one
    }
    return context
  }

  pi.on('before_agent_start', async (event) => {
    const note = await fetchContext()
    if (!note || typeof event?.systemPrompt !== 'string') return undefined
    return { systemPrompt: `${event.systemPrompt}\n\n${note}` }
  })
  pi.on('agent_start', () => post('working'))
  pi.on('agent_end', () => post('notification'))
}
