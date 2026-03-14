import { execFile } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'

const DEFAULT_CODEX_HOME = path.join(os.homedir(), '.codex')

export class CodexSessionManager {
  private sharedHome: string
  private sqlite3Missing = false

  constructor(sharedHome = DEFAULT_CODEX_HOME) {
    this.sharedHome = sharedHome
  }

  findStateDbs(): string[] {
    let entries: string[]
    try {
      entries = fs.readdirSync(this.sharedHome)
    } catch {
      return []
    }

    const dbs: { path: string; n: number }[] = []
    for (const name of entries) {
      const m = /^state_(\d+)\.sqlite$/.exec(name)
      if (!m) continue
      dbs.push({ path: path.join(this.sharedHome, name), n: parseInt(m[1], 10) })
    }
    dbs.sort((a, b) => b.n - a.n)
    return dbs.map(d => d.path)
  }

  async readLatestSessionId(cwd: string, afterTs = 0): Promise<string | null> {
    if (this.sqlite3Missing) return null

    const dbPaths = this.findStateDbs()
    if (dbPaths.length === 0) return null

    const escapedCwd = cwd.replace(/'/g, "''")
    const safeAfterTs = Number.isFinite(afterTs) ? Math.floor(afterTs) : 0
    const sql = `SELECT id FROM threads WHERE cwd = '${escapedCwd}' AND created_at >= ${safeAfterTs} ORDER BY created_at DESC LIMIT 1`

    for (const dbPath of dbPaths) {
      const result = await this.queryDb(dbPath, sql)
      if (result !== undefined) return result
    }
    return null
  }

  /**
   * Query a single state DB. Returns:
   * - string: session ID found
   * - null: query succeeded but no results, or sqlite3 binary missing (ENOENT)
   * - undefined: DB-level error, caller should try next DB
   */
  private queryDb(dbPath: string, sql: string): Promise<string | null | undefined> {
    return new Promise((resolve) => {
      execFile('sqlite3', ['-readonly', dbPath, sql], { encoding: 'utf-8', timeout: 3000 }, (err, stdout) => {
        if (err) {
          if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
            this.sqlite3Missing = true
            resolve(null)
            return
          }
          resolve(undefined)
          return
        }
        const id = stdout.trim()
        resolve(id || null)
      })
    })
  }

  buildRemoteReadSessionScript(cwd: string, afterTs = 0): string {
    const safeAfterTs = Number.isFinite(afterTs) ? Math.floor(afterTs) : 0
    const payload = JSON.stringify({ cwd, afterTs: safeAfterTs })

    return `python3 -c "
import glob, json, os, re, sqlite3

data = json.loads(${this.shellQuote(payload)})
home = os.path.expanduser('~/.codex')
dbs = glob.glob(os.path.join(home, 'state_*.sqlite'))

def db_num(p):
    m = re.search(r'state_(\\\\d+)\\\\.sqlite$', p)
    return int(m.group(1)) if m else -1

dbs.sort(key=db_num, reverse=True)

sessionId = None
for db in dbs:
    try:
        conn = sqlite3.connect('file:' + db + '?mode=ro', uri=True)
        row = conn.execute(
            'SELECT id FROM threads WHERE cwd = ? AND created_at >= ? ORDER BY created_at DESC LIMIT 1',
            (data['cwd'], data.get('afterTs', 0))
        ).fetchone()
        conn.close()
        if row:
            sessionId = row[0]
            break
    except Exception:
        continue

print(json.dumps({'sessionId': sessionId}))
"`
  }

  private shellQuote(value: string): string {
    return "'" + value.replace(/'/g, "'\\''") + "'"
  }
}
