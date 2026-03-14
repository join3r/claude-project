import fs from 'fs'
import os from 'os'
import path from 'path'

const SHARED_CODEX_HOME = path.join(os.homedir(), '.codex')
const VOLATILE_ENTRY_NAMES = new Set([
  'archived_sessions',
  'history.jsonl',
  'session_index.jsonl',
  'sessions',
  'shell_snapshots',
  'tmp'
])

function isVolatileEntry(name: string): boolean {
  if (VOLATILE_ENTRY_NAMES.has(name)) return true
  return /^logs_\d+\.sqlite(?:-(?:shm|wal))?$/.test(name)
    || /^state_\d+\.sqlite(?:-(?:shm|wal))?$/.test(name)
}

function readLatestSessionId(homeDir: string): string | null {
  const indexPath = path.join(homeDir, 'session_index.jsonl')

  try {
    const lines = fs.readFileSync(indexPath, 'utf-8').trim().split('\n')
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const line = lines[i]?.trim()
      if (!line) continue
      const parsed = JSON.parse(line) as { id?: unknown }
      if (typeof parsed.id === 'string' && parsed.id) {
        return parsed.id
      }
    }
  } catch {
    // No prior session state yet.
  }

  return null
}

export class CodexSessionManager {
  private rootDir: string
  private sharedHome: string

  constructor(rootDir: string, sharedHome = SHARED_CODEX_HOME) {
    this.rootDir = rootDir
    this.sharedHome = sharedHome
    fs.mkdirSync(this.rootDir, { recursive: true })
  }

  getLocalTabHome(tabId: string): string {
    return path.join(this.rootDir, tabId)
  }

  getRemoteTabHome(remoteDir: string, tabId: string): string {
    return path.posix.join(remoteDir, '.devtool', 'codex-tabs', tabId)
  }

  prepareLocalTab(tabId: string): { home: string; sessionId: string | null } {
    const home = this.getLocalTabHome(tabId)
    fs.mkdirSync(home, { recursive: true })
    this.linkSharedEntries(home)
    return { home, sessionId: this.readLocalTabSessionId(tabId) }
  }

  readLocalTabSessionId(tabId: string): string | null {
    return readLatestSessionId(this.getLocalTabHome(tabId))
  }

  cleanupLocalTab(tabId: string): void {
    try {
      fs.rmSync(this.getLocalTabHome(tabId), { recursive: true, force: true })
    } catch {
      // Best-effort cleanup.
    }
  }

  buildRemotePrepareScript(remoteDir: string, tabId: string): string {
    const remoteHome = this.getRemoteTabHome(remoteDir, tabId)
    const payload = JSON.stringify({ remoteHome })

    return `python3 -c "
import json, os
data = json.loads(${this.shellQuote(payload)})
shared = os.path.expanduser('~/.codex')
home = data['remoteHome']
os.makedirs(home, exist_ok=True)

def is_volatile(name):
    if name in {'archived_sessions', 'history.jsonl', 'session_index.jsonl', 'sessions', 'shell_snapshots', 'tmp'}:
        return True
    return name.startswith('logs_') or name.startswith('state_')

if os.path.isdir(shared):
    for name in os.listdir(shared):
        if is_volatile(name):
            continue
        src = os.path.join(shared, name)
        dst = os.path.join(home, name)
        if os.path.lexists(dst):
            continue
        os.symlink(src, dst)

session_id = None
index_path = os.path.join(home, 'session_index.jsonl')
try:
    with open(index_path) as f:
        for raw_line in f:
            line = raw_line.strip()
            if not line:
                continue
            parsed = json.loads(line)
            if isinstance(parsed, dict) and isinstance(parsed.get('id'), str) and parsed['id']:
                session_id = parsed['id']
except Exception:
    pass

print(json.dumps({'home': home, 'sessionId': session_id}))
"`
  }

  buildRemoteReadSessionScript(remoteDir: string, tabId: string): string {
    const remoteHome = this.getRemoteTabHome(remoteDir, tabId)
    const payload = JSON.stringify({ remoteHome })

    return `python3 -c "
import json, os
data = json.loads(${this.shellQuote(payload)})
session_id = None
index_path = os.path.join(data['remoteHome'], 'session_index.jsonl')
try:
    with open(index_path) as f:
        for raw_line in f:
            line = raw_line.strip()
            if not line:
                continue
            parsed = json.loads(line)
            if isinstance(parsed, dict) and isinstance(parsed.get('id'), str) and parsed['id']:
                session_id = parsed['id']
except Exception:
    pass

print(json.dumps({'sessionId': session_id}))
"`
  }

  buildRemoteCleanupScript(remoteDir: string, tabId: string): string {
    const remoteHome = this.getRemoteTabHome(remoteDir, tabId)
    const payload = JSON.stringify({ remoteHome })

    return `python3 -c "
import json, shutil
data = json.loads(${this.shellQuote(payload)})
shutil.rmtree(data['remoteHome'], ignore_errors=True)
" 2>/dev/null || true`
  }

  private linkSharedEntries(home: string): void {
    let entries: string[] = []
    try {
      entries = fs.readdirSync(this.sharedHome)
    } catch {
      return
    }

    for (const name of entries) {
      if (isVolatileEntry(name)) continue

      const source = path.join(this.sharedHome, name)
      const destination = path.join(home, name)
      if (fs.existsSync(destination)) continue

      try {
        const stat = fs.lstatSync(source)
        const type: fs.symlink.Type | undefined = stat.isDirectory() ? 'junction' : 'file'
        fs.symlinkSync(source, destination, type)
      } catch {
        // Ignore individual link failures; Codex can still create what it needs.
      }
    }
  }

  private shellQuote(value: string): string {
    return "'" + value.replace(/'/g, "'\\''") + "'"
  }
}
