import { useEffect, useSyncExternalStore } from 'react'
import type { AiTabType } from '../shared/types'
import type { AgentClisReport, AgentCliStatus } from '../shared/agent-clis'
import { getServersState, subscribeServersState } from './serversState'

/**
 * Which agent CLIs each DevTool server has (`host-agent-clis`), shared by every
 * component of a window: the agent and chat tabs (an inline "isn't installed ·
 * Install" instead of a broken tab), and Settings → Servers. Asked once per
 * server while it is online, again each time it comes back, and on demand
 * ("Check again", the end of an install).
 *
 * Also the installs this window started: the terminal tab each runs in and how
 * it ended.
 */

export interface AgentInstallRun {
  /** The terminal tab running the installer. */
  tabId: string
  projectId: string
  taskId: string
  state: 'running' | 'exited'
  exitCode?: number
}

export interface ServerAgentClis {
  report: AgentClisReport | null
  /** A check is in flight. */
  checking: boolean
  /** The last check failed (an older server without the channel, the link dropped). */
  error: string | null
  installs: Partial<Record<AiTabType, AgentInstallRun>>
}

const EMPTY: ServerAgentClis = { report: null, checking: false, error: null, installs: {} }

let entries = new Map<string, ServerAgentClis>()
const inFlight = new Map<string, Promise<void>>()
const listeners = new Set<() => void>()
let watchingServers = false
let online = new Set<string>()
let exitListening = false

function emit(): void {
  for (const listener of [...listeners]) listener()
}

function entryOf(serverId: string): ServerAgentClis {
  return entries.get(serverId) ?? EMPTY
}

function update(serverId: string, patch: Partial<ServerAgentClis>): void {
  const next = new Map(entries)
  next.set(serverId, { ...entryOf(serverId), ...patch })
  entries = next
  emit()
}

function errorText(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  return raw.replace(/^Error invoking remote method '[^']+': (?:Error: )?/u, '')
}

/** A server that comes back (a restart, an update) may have new CLIs: check again then. */
function ensureWatchingServers(): void {
  if (watchingServers || typeof window === 'undefined') return
  watchingServers = true
  const sync = (): void => {
    const now = new Set(getServersState().servers.filter(s => s.state === 'online').map(s => s.id))
    const came = [...now].filter(id => !online.has(id))
    online = now
    for (const serverId of came) {
      if (entries.has(serverId)) void refreshServerAgentClis(serverId)
    }
  }
  online = new Set(getServersState().servers.filter(s => s.state === 'online').map(s => s.id))
  subscribeServersState(sync)
}

/**
 * Ask `serverId` which agent CLIs it has. `refreshEnv` first runs its login
 * shell again (after an installer added to its PATH). Calls for one server
 * share one check.
 */
export function refreshServerAgentClis(serverId: string, options: { refreshEnv?: boolean } = {}): Promise<void> {
  const running = inFlight.get(serverId)
  if (running && !options.refreshEnv) return running
  const check = async (): Promise<void> => {
    update(serverId, { checking: true })
    try {
      if (options.refreshEnv) await window.api.hostRefreshEnv(serverId)
      const report = await window.api.hostAgentClis(serverId)
      update(serverId, { report, checking: false, error: null })
    } catch (err) {
      update(serverId, { checking: false, error: errorText(err) })
    }
  }
  const run: Promise<void> = check().finally(() => {
    if (inFlight.get(serverId) === run) inFlight.delete(serverId)
  })
  inFlight.set(serverId, run)
  return run
}

export function getServerAgentClis(serverId: string): ServerAgentClis {
  return entryOf(serverId)
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/**
 * A server's agent CLIs, asked for the first time it is online while something
 * shows them. Null for no server (a project on this desktop).
 */
export function useServerAgentClis(serverId: string | undefined): ServerAgentClis | null {
  const all = useSyncExternalStore(subscribe, () => entries)
  const serversOnline = useSyncExternalStore(subscribeServersState, () => getServersState())
  const isOnline = !!serverId && serversOnline.servers.some(s => s.id === serverId && s.state === 'online')
  useEffect(() => {
    ensureWatchingServers()
    if (!serverId || !isOnline) return
    const entry = entries.get(serverId)
    if (!entry || (!entry.report && !entry.checking && !entry.error)) void refreshServerAgentClis(serverId)
  }, [serverId, isOnline])
  return serverId ? all.get(serverId) ?? EMPTY : null
}

/**
 * What an agent tab of a project on `serverId` should do about its CLI:
 * - `ready`: start it (a local project, a server that has it, or a server that
 *   couldn't say: an older one, which then fails the way it always did);
 * - `checking`: wait, the first check is out;
 * - `missing`: say it isn't installed, and offer to install it.
 */
export type AgentCliGate = { state: 'ready' | 'checking' } | { state: 'missing'; status: AgentCliStatus }

export function agentCliGate(entry: ServerAgentClis | null, agent: AiTabType): AgentCliGate {
  if (!entry) return { state: 'ready' }
  const status = entry.report?.clis[agent]
  if (status) return status.found ? { state: 'ready' } : { state: 'missing', status }
  if (entry.error) return { state: 'ready' }
  return { state: 'checking' }
}

export function useAgentCliGate(serverId: string | undefined, agent: AiTabType): { gate: AgentCliGate; entry: ServerAgentClis | null } {
  const entry = useServerAgentClis(serverId)
  return { gate: agentCliGate(entry, agent), entry }
}

/** The installer's terminal ended: note how, then check the server again with a fresh login env. */
function ensureExitListener(): void {
  if (exitListening || typeof window === 'undefined') return
  exitListening = true
  window.api.onPtyExit((tabId, exitCode) => {
    for (const [serverId, entry] of entries) {
      for (const [agent, run] of Object.entries(entry.installs) as [AiTabType, AgentInstallRun][]) {
        if (run.tabId !== tabId || run.state !== 'running') continue
        update(serverId, { installs: { ...entryOf(serverId).installs, [agent]: { ...run, state: 'exited', exitCode } } })
        void refreshServerAgentClis(serverId, { refreshEnv: true })
      }
    }
  })
}

/** An install of `agent` on `serverId` started in terminal tab `run.tabId`. */
export function noteAgentInstall(serverId: string, agent: AiTabType, run: Omit<AgentInstallRun, 'state' | 'exitCode'>): void {
  ensureExitListener()
  update(serverId, { installs: { ...entryOf(serverId).installs, [agent]: { ...run, state: 'running' } } })
}

/** Tests: start over. */
export function resetAgentClisForTests(): void {
  entries = new Map()
  inFlight.clear()
  online = new Set()
  watchingServers = false
  exitListening = false
  emit()
}
