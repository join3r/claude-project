/**
 * Moving a task to another worktree restarts its agents there. Claude and Pi keep
 * their sessions per working directory (Claude in `~/.claude/projects/<slug>/`,
 * Pi in `~/.pi/agent/sessions/--<slug>--/`), so `--resume <id>` / `--session-id
 * <id>` in the new directory would not find the conversation. Copying the session
 * file into the new directory's folder first keeps the history. Codex keeps every
 * session in one dated tree (`~/.codex/sessions/YYYY/MM/DD/`) and `codex resume
 * <id>` looks it up from any directory, so it needs nothing.
 *
 * The copy never overwrites: a session already in the target folder (moved there
 * before, or created there) is left alone.
 */
import fs from 'fs'
import os from 'os'
import path from 'path'
import { claudeProjectSlug, isClaudeSessionId } from './ipc/agents'
import { shellQuote } from './ssh-connection-manager'

export type MovableSessionKind = 'claude' | 'pi'

export interface SessionToMove {
  kind: MovableSessionKind
  sessionId: string
}

export type SessionCopyOutcome = 'copied' | 'exists' | 'missing'

/** Pi names a directory's session folder `--<path with separators as dashes>--`. */
export function piSessionDirName(cwd: string): string {
  return `--${cwd.replace(/^[/\\]+/, '').replace(/[/\\:]/g, '-')}--`
}

/** Where Pi keeps its sessions on this machine. */
export function localPiSessionsRoot(env: NodeJS.ProcessEnv = process.env, homeDir: string = os.homedir()): string {
  if (env.PI_CODING_AGENT_SESSION_DIR) return env.PI_CODING_AGENT_SESSION_DIR
  return path.join(env.PI_CODING_AGENT_DIR || path.join(homeDir, '.pi', 'agent'), 'sessions')
}

interface LocalRoots {
  claudeProjects: string
  piSessions: string
}

export function localSessionRoots(homeDir: string = os.homedir(), env: NodeJS.ProcessEnv = process.env): LocalRoots {
  return {
    claudeProjects: path.join(homeDir, '.claude', 'projects'),
    piSessions: localPiSessionsRoot(env, homeDir)
  }
}

/** The session's file in `dir` (Claude: `<id>.jsonl`; Pi: `<timestamp>_<id>.jsonl`). */
function findInDir(dir: string, kind: MovableSessionKind, sessionId: string): string | null {
  if (kind === 'claude') {
    const file = path.join(dir, `${sessionId}.jsonl`)
    return fs.existsSync(file) ? file : null
  }
  try {
    const name = fs.readdirSync(dir).find(entry => entry.endsWith(`_${sessionId}.jsonl`))
    return name ? path.join(dir, name) : null
  } catch {
    return null
  }
}

/** The source file: in the old directory's folder, else anywhere under the root. */
function findSession(root: string, fromFolder: string, kind: MovableSessionKind, sessionId: string): string | null {
  const direct = findInDir(path.join(root, fromFolder), kind, sessionId)
  if (direct) return direct
  try {
    for (const folder of fs.readdirSync(root)) {
      const hit = findInDir(path.join(root, folder), kind, sessionId)
      if (hit) return hit
    }
  } catch {
    // No sessions at all.
  }
  return null
}

/** Copy one session into `toDir`'s folder on this machine. */
export function copyLocalSession(
  session: SessionToMove,
  fromDir: string,
  toDir: string,
  roots: LocalRoots = localSessionRoots()
): SessionCopyOutcome {
  if (!isClaudeSessionId(session.sessionId)) return 'missing'
  const root = session.kind === 'claude' ? roots.claudeProjects : roots.piSessions
  const folder = (dir: string) => (session.kind === 'claude' ? claudeProjectSlug(dir) : piSessionDirName(dir))
  const targetDir = path.join(root, folder(toDir))
  if (findInDir(targetDir, session.kind, session.sessionId)) return 'exists'
  const source = findSession(root, folder(fromDir), session.kind, session.sessionId)
  if (!source) return 'missing'
  fs.mkdirSync(targetDir, { recursive: true })
  fs.copyFileSync(source, path.join(targetDir, path.basename(source)))
  // Claude keeps a session's subagent transcripts and tool results next to it.
  const sidecar = source.replace(/\.jsonl$/, '')
  const sidecarTarget = path.join(targetDir, path.basename(sidecar))
  if (session.kind === 'claude' && fs.existsSync(sidecar) && !fs.existsSync(sidecarTarget)) {
    fs.cpSync(sidecar, sidecarTarget, { recursive: true })
  }
  return 'copied'
}

/**
 * The same copy as a POSIX shell script, for a project on an SSH host (the
 * remote `$HOME`; Pi's default agent dir), followed by an existence check of
 * `dirs`. Never fails.
 */
export function buildRemoteSessionCopyScript(sessions: readonly SessionToMove[], fromDir: string, toDir: string, dirs: readonly string[] = []): string {
  const lines: string[] = []
  for (const { kind, sessionId } of sessions) {
    if (!isClaudeSessionId(sessionId)) continue
    if (kind === 'claude') {
      const root = '"$HOME"/.claude/projects'
      const to = `${root}/${shellQuote(claudeProjectSlug(toDir))}`
      lines.push(
        `f=${root}/${shellQuote(claudeProjectSlug(fromDir))}/${sessionId}.jsonl`,
        `[ -f "$f" ] || f=$(ls ${root}/*/${sessionId}.jsonl 2>/dev/null | head -n 1)`,
        `if [ -n "$f" ] && [ ! -e ${to}/${sessionId}.jsonl ]; then mkdir -p ${to} && cp "$f" ${to}/ && { [ ! -d "\${f%.jsonl}" ] || cp -R "\${f%.jsonl}" ${to}/; }; fi`
      )
    } else {
      const root = '"$HOME"/.pi/agent/sessions'
      const to = `${root}/${shellQuote(piSessionDirName(toDir))}`
      lines.push(
        `f=$(ls ${root}/${shellQuote(piSessionDirName(fromDir))}/*_${sessionId}.jsonl 2>/dev/null | head -n 1)`,
        `[ -n "$f" ] || f=$(ls ${root}/*/*_${sessionId}.jsonl 2>/dev/null | head -n 1)`,
        `if [ -n "$f" ] && ! ls ${to}/*_${sessionId}.jsonl >/dev/null 2>&1; then mkdir -p ${to} && cp "$f" ${to}/; fi`
      )
    }
  }
  // Then one line per `dirs` entry: 1 when it is a directory on the host, else 0.
  for (const dir of dirs) lines.push(`if [ -d ${shellQuote(dir)} ]; then echo 1; else echo 0; fi`)
  lines.push('true')
  return lines.join('\n')
}
