import { isAgentTabType } from './types'
import type { Tab } from './types'

/**
 * Agent context links: a compact reference to a file, a line range or
 * a notebook cell that is typed into an agent's input instead of the text itself.
 *
 * The `@path` token is kept clean — Claude Code and Pi treat `@path` as a file
 * mention, and a suffix glued onto it (`:10-24`, `#L10`) can stop that from
 * resolving. The range follows in plain words:
 *
 *   @src/foo.ts                              whole file (Ctrl+Shift+L)
 *   @src/foo.ts (lines 10-24)                selection
 *   @analysis.ipynb (cell 4, id 3c8d9b5c, lines 3-5)
 */
export interface AgentLinkTarget {
  /** Path as the agent should see it (workspace-relative, `/` separators). */
  path: string
  startLine?: number
  endLine?: number
  /** 1-based position of the notebook cell — always valid, even without stored ids. */
  cellNumber?: number
  /** nbformat cell id, only when the file on disk stores it. */
  cellId?: string
  isDirectory?: boolean
}

export function formatAgentLink({ path, startLine, endLine, cellNumber, cellId, isDirectory }: AgentLinkTarget): string {
  let p = path.replace(/\\/g, '/')
  if (isDirectory && !p.endsWith('/')) p += '/'
  const quoted = /\s/.test(p) ? `"${p}"` : p

  const parts: string[] = []
  if (cellNumber !== undefined && cellId) parts.push(`cell ${cellNumber}, id ${cellId}`)
  else if (cellNumber !== undefined) parts.push(`cell ${cellNumber}`)
  else if (cellId) parts.push(`cell id ${cellId}`)
  if (startLine !== undefined) {
    const end = endLine ?? startLine
    parts.push(end > startLine ? `lines ${startLine}-${end}` : `line ${startLine}`)
  }
  return parts.length > 0 ? `@${quoted} (${parts.join(', ')}) ` : `@${quoted} `
}

/** A Monaco-style selection: 1-based lines and columns. */
export interface LineSelection {
  startLineNumber: number
  startColumn: number
  endLineNumber: number
  endColumn: number
}

/**
 * Lines a selection covers. An empty selection means the cursor line. A selection
 * that ends at column 1 of a later line (triple-click, or dragging to the start of
 * the next line) does not include that last line.
 */
export function selectionLines(sel: LineSelection): { startLine: number; endLine: number } {
  const startLine = Math.min(sel.startLineNumber, sel.endLineNumber)
  let endLine = Math.max(sel.startLineNumber, sel.endLineNumber)
  const endColumn = sel.endLineNumber >= sel.startLineNumber ? sel.endColumn : sel.startColumn
  if (endLine > startLine && endColumn === 1) endLine -= 1
  return { startLine, endLine }
}

function normalizeDir(dir: string): string {
  return dir.replace(/\\/g, '/').replace(/\/+$/, '')
}

function samePathPrefix(a: string, b: string, windows: boolean): boolean {
  return windows ? a.toLowerCase() === b.toLowerCase() : a === b
}

/**
 * The path an agent running in `agentCwd` should see for a workspace-relative
 * `fileRelPath`. Agent tabs normally run in the task workspace, so the relative
 * path is returned as is; an agent in a subfolder gets the prefix stripped, and
 * one outside the file's folder gets an absolute path.
 */
export function agentLinkPath(workspaceDir: string, fileRelPath: string, agentCwd?: string): string {
  const rel = fileRelPath.replace(/\\/g, '/').replace(/^\.?\/+/, '')
  if (!agentCwd) return rel
  const ws = normalizeDir(workspaceDir)
  const cwd = normalizeDir(agentCwd)
  const windows = /^[a-zA-Z]:\//.test(ws)
  if (samePathPrefix(cwd, ws, windows)) return rel

  const absolute = rel ? `${ws}/${rel}` : ws
  const prefix = `${cwd}/`
  if (absolute.length > prefix.length && samePathPrefix(absolute.slice(0, prefix.length), prefix, windows)) {
    return absolute.slice(prefix.length)
  }
  return absolute
}

export interface AgentTargetTask {
  panes: readonly { tabs: readonly Tab[]; activeTabId?: string | null }[]
}

/**
 * Which agent tab of a task receives a link: the most recently focused one
 * (`recency`, newest first), else an agent tab that is active in some pane
 * (left to right), else the first agent tab of the row.
 */
export function pickAgentTarget(task: AgentTargetTask, recency: readonly string[] = []): Tab | null {
  const agentTabs = task.panes.flatMap(pane => pane.tabs).filter(t => isAgentTabType(t.type))
  if (agentTabs.length === 0) return null
  for (const id of recency) {
    const hit = agentTabs.find(t => t.id === id)
    if (hit) return hit
  }
  for (const id of task.panes.map(pane => pane.activeTabId)) {
    const hit = id ? agentTabs.find(t => t.id === id) : undefined
    if (hit) return hit
  }
  return agentTabs[0]
}

/**
 * Which link a key event asks for: Ctrl+L / Ctrl+Shift+L, or ⌘L / ⌘⇧L on macOS —
 * the same keys Monaco's CtrlCmd binds, so the notebook's own handler and the
 * cell editors agree (Control+L on a Mac does nothing in either). AltGr (Ctrl+Alt
 * on Windows) never matches.
 */
export function agentLinkShortcut(
  event: { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean },
  platform: string
): 'selection' | 'file' | null {
  if (event.altKey || event.key.toLowerCase() !== 'l') return null
  const primary = platform === 'darwin'
    ? event.metaKey && !event.ctrlKey
    : event.ctrlKey && !event.metaKey
  if (!primary) return null
  return event.shiftKey ? 'file' : 'selection'
}
