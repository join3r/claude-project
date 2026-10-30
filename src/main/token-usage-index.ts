import fs from 'fs'
import os from 'os'
import path from 'path'
import { atomicWriteFileSync } from './atomic-write'
import { localPiSessionsRoot } from './agent-session-move'
import { isPathInside } from './ipc/path-allowlist'
import { localDay, type TokenAgent, type TokenUsageRow } from '../shared/token-usage'

/**
 * Token usage on this host, read from the session files the agents write
 * anyway: Claude Code (`~/.claude/projects/<slug>/**.jsonl`, the chat tab's SDK
 * sessions too), Codex (`~/.codex/sessions/YYYY/MM/DD/*.jsonl`) and Pi
 * (`~/.pi/agent/sessions/--<slug>--/*.jsonl`). Each file is tallied per day,
 * agent and model under the directory it ran in.
 *
 * The files are append-only and can be gigabytes, so each is read once and
 * then only from where the last read stopped; the tallies and offsets persist
 * in `<config dir>/token-usage.json` between runs.
 */

const CACHE_VERSION = 1
const CHUNK_BYTES = 4 * 1024 * 1024
/** A refresh this soon after the last one answers from the tallies. */
const FRESH_MS = 30_000

/** A file's tally: `"<day>|<model>"` → [input, output, cacheRead, cacheWrite]. */
type Buckets = Record<string, [number, number, number, number]>

export interface FileTally {
  agent: TokenAgent
  size: number
  mtimeMs: number
  /** Bytes read so far, up to the end of the last whole line. */
  offset: number
  cwd: string | null
  buckets: Buckets
  /** Codex: the model of the turn in progress. */
  model?: string
  /** Codex: the session's running total at the last count, to take the difference from. */
  totals?: [number, number, number, number]
  /** Claude: the message the last line belonged to (one message spans several lines). */
  lastMessage?: { id: string; key: string; counts: [number, number, number, number] }
}

interface CacheFile {
  version: number
  files: Record<string, FileTally>
}

export interface TokenUsageRoots {
  claude: string
  codex: string[]
  pi: string
}

export function defaultTokenUsageRoots(env: NodeJS.ProcessEnv = process.env, homeDir: string = os.homedir()): TokenUsageRoots {
  const codexHome = env.CODEX_HOME || path.join(homeDir, '.codex')
  return {
    claude: path.join(env.CLAUDE_CONFIG_DIR || path.join(homeDir, '.claude'), 'projects'),
    codex: [path.join(codexHome, 'sessions'), path.join(codexHome, 'archived_sessions')],
    pi: localPiSessionsRoot(env, homeDir)
  }
}

const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0)

function dayOf(timestamp: unknown): string | null {
  const date = typeof timestamp === 'number' ? new Date(timestamp) : typeof timestamp === 'string' ? new Date(timestamp) : null
  return date && !Number.isNaN(date.getTime()) ? localDay(date) : null
}

function add(buckets: Buckets, key: string, counts: readonly number[], sign = 1): void {
  const bucket = buckets[key] ?? (buckets[key] = [0, 0, 0, 0])
  for (let i = 0; i < 4; i++) bucket[i] += sign * counts[i]
  if (bucket.every(n => n === 0)) delete buckets[key]
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

/** One Claude Code transcript line. A message's content blocks each get a line carrying the message's usage; the last one counts. */
export function tallyClaudeLine(tally: FileTally, line: string): void {
  if (!line.includes('"usage"') || !line.includes('"assistant"')) return
  let entry: Record<string, unknown> | null
  try {
    entry = asRecord(JSON.parse(line))
  } catch {
    return
  }
  if (!entry) return
  if (!tally.cwd && typeof entry.cwd === 'string') tally.cwd = entry.cwd
  const message = asRecord(entry.message)
  const usage = asRecord(message?.usage)
  if (entry.type !== 'assistant' || !message || !usage) return
  const day = dayOf(entry.timestamp)
  if (!day) return
  const model = typeof message.model === 'string' ? message.model : 'unknown'
  // Claude Code's own placeholder for turns that never reached the API.
  if (model === '<synthetic>') return
  const counts: [number, number, number, number] = [
    num(usage.input_tokens), num(usage.output_tokens), num(usage.cache_read_input_tokens), num(usage.cache_creation_input_tokens)
  ]
  const key = `${day}|${model}`
  const id = typeof message.id === 'string' ? message.id : null
  if (id && tally.lastMessage?.id === id) add(tally.buckets, tally.lastMessage.key, tally.lastMessage.counts, -1)
  add(tally.buckets, key, counts)
  tally.lastMessage = id ? { id, key, counts } : undefined
}

/** One Codex rollout line: the cwd and model from the session and turn headers, tokens as the difference of each running total. */
export function tallyCodexLine(tally: FileTally, line: string): void {
  if (!line.includes('"session_meta"') && !line.includes('"turn_context"') && !line.includes('"token_count"')) return
  let entry: Record<string, unknown> | null
  try {
    entry = asRecord(JSON.parse(line))
  } catch {
    return
  }
  const payload = asRecord(entry?.payload)
  if (!entry || !payload) return
  if (entry.type === 'session_meta' || entry.type === 'turn_context') {
    if (!tally.cwd && typeof payload.cwd === 'string') tally.cwd = payload.cwd
    if (typeof payload.model === 'string') tally.model = payload.model
    return
  }
  if (entry.type !== 'event_msg' || payload.type !== 'token_count') return
  const total = asRecord(asRecord(payload.info)?.total_token_usage)
  const day = dayOf(entry.timestamp)
  if (!total || !day) return
  const cached = num(total.cached_input_tokens)
  // Codex counts cached input inside input_tokens.
  const now: [number, number, number, number] = [
    Math.max(0, num(total.input_tokens) - cached), num(total.output_tokens), cached, num(total.cache_write_input_tokens)
  ]
  const before = tally.totals ?? [0, 0, 0, 0]
  const delta = now.map((n, i) => Math.max(0, n - before[i]))
  tally.totals = now
  if (delta.some(n => n > 0)) add(tally.buckets, `${day}|${tally.model ?? 'unknown'}`, delta)
}

/** One Pi session line: the header's cwd, then each assistant message's usage. */
export function tallyPiLine(tally: FileTally, line: string): void {
  const header = line.includes('"type":"session"')
  if (!header && !line.includes('"usage"')) return
  let entry: Record<string, unknown> | null
  try {
    entry = asRecord(JSON.parse(line))
  } catch {
    return
  }
  if (!entry) return
  if (entry.type === 'session') {
    if (!tally.cwd && typeof entry.cwd === 'string') tally.cwd = entry.cwd
    return
  }
  const message = asRecord(entry.message)
  const usage = asRecord(message?.usage)
  if (entry.type !== 'message' || message?.role !== 'assistant' || !usage) return
  const day = dayOf(entry.timestamp ?? message.timestamp)
  if (!day) return
  const model = typeof message.model === 'string' ? message.model : 'unknown'
  add(tally.buckets, `${day}|${model}`, [num(usage.input), num(usage.output), num(usage.cacheRead), num(usage.cacheWrite)])
}

const TALLY_LINE: Record<TokenAgent, (tally: FileTally, line: string) => void> = {
  claude: tallyClaudeLine,
  codex: tallyCodexLine,
  pi: tallyPiLine
}

/** Every `.jsonl` under `root`, however deep (Claude keeps subagents' sessions in a folder per session). */
async function listJsonl(root: string, out: string[]): Promise<void> {
  let entries: fs.Dirent[]
  try {
    entries = await fs.promises.readdir(root, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const full = path.join(root, entry.name)
    if (entry.isDirectory()) await listJsonl(full, out)
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) out.push(full)
  }
}

/** Read `file` from `tally.offset` to its last whole line, tallying each line. */
async function readNewLines(file: string, tally: FileTally, size: number): Promise<void> {
  const handle = await fs.promises.open(file, 'r')
  try {
    const buffer = Buffer.alloc(CHUNK_BYTES)
    let carry: Buffer = Buffer.alloc(0)
    let position = tally.offset
    while (position < size) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(CHUNK_BYTES, size - position), position)
      if (bytesRead === 0) break
      position += bytesRead
      const data = carry.length ? Buffer.concat([carry, buffer.subarray(0, bytesRead)]) : buffer.subarray(0, bytesRead)
      const lastNewline = data.lastIndexOf(0x0a)
      if (lastNewline < 0) {
        carry = Buffer.from(data)
        continue
      }
      const tallyLine = TALLY_LINE[tally.agent]
      for (const line of data.subarray(0, lastNewline).toString('utf8').split('\n')) {
        if (line) tallyLine(tally, line)
      }
      tally.offset = position - (data.length - lastNewline - 1)
      carry = Buffer.from(data.subarray(lastNewline + 1))
    }
  } finally {
    await handle.close()
  }
}

function freshTally(agent: TokenAgent): FileTally {
  return { agent, size: 0, mtimeMs: 0, offset: 0, cwd: null, buckets: {} }
}

export class TokenUsageIndex {
  private files: Record<string, FileTally> = {}
  private loaded = false
  private refreshing: Promise<void> | null = null
  private lastRefresh = 0

  constructor(
    private readonly cachePath: string,
    private readonly roots: TokenUsageRoots = defaultTokenUsageRoots(),
    private readonly log: (message: string) => void = () => {}
  ) {}

  /** When the files were last read (ms), 0 before the first read. */
  get scannedAt(): number {
    return this.lastRefresh
  }

  /** Read whatever the agents wrote since the last read; concurrent calls share one read. */
  refresh(force = false): Promise<void> {
    if (this.refreshing) return this.refreshing
    if (!force && this.lastRefresh && Date.now() - this.lastRefresh < FRESH_MS) return Promise.resolve()
    this.refreshing = this.scan().finally(() => {
      this.refreshing = null
    })
    return this.refreshing
  }

  /**
   * Rows for the sessions that ran in one of `roots` (or below), except below
   * one of `exclude` (a project nested inside this one counts its own).
   */
  rowsFor(roots: readonly string[], exclude: readonly string[] = []): TokenUsageRow[] {
    const sums = new Map<string, TokenUsageRow>()
    const owned = (cwd: string): boolean => {
      const root = longest(roots.filter(r => isPathInside(r, cwd)))
      if (!root) return false
      return !exclude.some(other => other.length > root.length && isPathInside(other, cwd))
    }
    for (const tally of Object.values(this.files)) {
      if (!tally.cwd || !owned(tally.cwd)) continue
      for (const [key, counts] of Object.entries(tally.buckets)) {
        const split = key.indexOf('|')
        const day = key.slice(0, split)
        const model = key.slice(split + 1)
        const id = `${day}|${tally.agent}|${model}`
        const row = sums.get(id) ?? sums.set(id, { day, agent: tally.agent, model, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }).get(id)!
        row.input += counts[0]
        row.output += counts[1]
        row.cacheRead += counts[2]
        row.cacheWrite += counts[3]
      }
    }
    return [...sums.values()].sort((a, b) => a.day.localeCompare(b.day) || a.agent.localeCompare(b.agent) || a.model.localeCompare(b.model))
  }

  private load(): void {
    if (this.loaded) return
    this.loaded = true
    try {
      const cache = JSON.parse(fs.readFileSync(this.cachePath, 'utf8')) as CacheFile
      if (cache?.version === CACHE_VERSION && cache.files && typeof cache.files === 'object') this.files = cache.files
    } catch {
      // No cache yet, or an unreadable one: everything is read again.
    }
  }

  private async scan(): Promise<void> {
    this.load()
    const started = Date.now()
    const listed: Array<[string, TokenAgent]> = []
    const add = async (root: string, agent: TokenAgent): Promise<void> => {
      const found: string[] = []
      await listJsonl(root, found)
      for (const file of found) listed.push([file, agent])
    }
    await add(this.roots.claude, 'claude')
    for (const root of this.roots.codex) await add(root, 'codex')
    await add(this.roots.pi, 'pi')

    const next: Record<string, FileTally> = {}
    let read = 0
    for (const [file, agent] of listed) {
      let stat: fs.Stats
      try {
        stat = await fs.promises.stat(file)
      } catch {
        continue
      }
      let tally = this.files[file]
      // A file that shrank was rewritten: start over.
      if (!tally || tally.agent !== agent || stat.size < tally.offset) tally = freshTally(agent)
      if (stat.size !== tally.size || stat.mtimeMs !== tally.mtimeMs) {
        try {
          await readNewLines(file, tally, stat.size)
          read++
        } catch (error) {
          this.log(`tokenUsage read failed ${file}: ${String(error)}`)
        }
        tally.size = stat.size
        tally.mtimeMs = stat.mtimeMs
      }
      next[file] = tally
    }
    // A session file that was deleted keeps counting: its tokens were spent all the same.
    // One that moved (a project folder renamed takes its history along) counts once, where it is now.
    const names = new Set(listed.map(([file]) => path.basename(file)))
    for (const [file, tally] of Object.entries(this.files)) {
      if (!next[file] && !names.has(path.basename(file))) next[file] = tally
    }
    this.files = next
    this.lastRefresh = Date.now()
    if (read > 0) {
      try {
        fs.mkdirSync(path.dirname(this.cachePath), { recursive: true })
        atomicWriteFileSync(this.cachePath, JSON.stringify({ version: CACHE_VERSION, files: this.files } satisfies CacheFile))
      } catch (error) {
        this.log(`tokenUsage cache write failed: ${String(error)}`)
      }
      this.log(`tokenUsage scanned files=${listed.length} read=${read} ms=${Date.now() - started}`)
    }
  }
}

function longest(paths: readonly string[]): string | null {
  return paths.reduce<string | null>((best, p) => (!best || p.length > best.length ? p : best), null)
}
