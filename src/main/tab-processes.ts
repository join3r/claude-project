import { execFile } from 'child_process'
import fs from 'fs'

/**
 * Set on every local agent DevTool starts (a chat tab's `claude`, an agent PTY
 * tab), to the tab's id. Children inherit it, including the ones an agent
 * detaches with `nohup` / `( … &)` — a dev server, an app it launched to try a
 * change — which killing the agent leaves running with launchd as their parent.
 * When the tab goes, {@link reapTabProcesses} finds them by it.
 *
 * Plain terminal tabs don't get it: a tmux server or a daemon someone starts by
 * hand there is theirs to keep.
 *
 * macOS hides a platform binary's environment (`/bin/sleep`, `/usr/bin/python3`)
 * from `ps`, so those are missed; node, Electron and Homebrew tools are found.
 */
export const TAB_OWNER_ENV = 'DEVTOOL_TAB_OWNER'

const KILL_GRACE_MS = 3000

/** Of `ps -axEww -o pid=,command=` lines, the pids whose environment carries the tab's tag. */
export function pidsWithTag(psOutput: string, tagId: string, exclude: readonly number[]): number[] {
  const needle = ` ${TAB_OWNER_ENV}=${tagId}`
  const pids: number[] = []
  for (const line of psOutput.split('\n')) {
    const match = /^\s*(\d+)\s/.exec(line)
    if (!match) continue
    const at = line.indexOf(needle)
    if (at < 0) continue
    const next = line.charAt(at + needle.length)
    if (next !== '' && next !== ' ') continue
    const pid = Number(match[1])
    if (!exclude.includes(pid)) pids.push(pid)
  }
  return pids
}

/** Of `/proc/<pid>/environ` contents, whether it carries the tab's tag. */
export function environHasTag(environ: string, tagId: string): boolean {
  return environ.split('\0').includes(`${TAB_OWNER_ENV}=${tagId}`)
}

function listTagged(tagId: string, exclude: readonly number[]): Promise<number[]> {
  if (process.platform === 'linux') {
    const pids: number[] = []
    for (const entry of fs.readdirSync('/proc')) {
      const pid = Number(entry)
      if (!Number.isInteger(pid) || exclude.includes(pid)) continue
      try {
        if (environHasTag(fs.readFileSync(`/proc/${pid}/environ`, 'utf8'), tagId)) pids.push(pid)
      } catch {
        // Gone, or someone else's.
      }
    }
    return Promise.resolve(pids)
  }
  if (process.platform !== 'darwin') return Promise.resolve([])
  return new Promise((resolve) => {
    execFile('ps', ['-axEww', '-o', 'pid=,command='], { maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => {
      resolve(err ? [] : pidsWithTag(stdout, tagId, exclude))
    })
  })
}

function signal(pids: readonly number[], sig: NodeJS.Signals): number[] {
  const hit: number[] = []
  for (const pid of pids) {
    try {
      process.kill(pid, sig)
      hit.push(pid)
    } catch {
      // Already exited.
    }
  }
  return hit
}

/**
 * End whatever a closed agent tab left running: SIGTERM, then SIGKILL for what
 * is still there after a grace period. Never this process or its parent, which
 * a dev DevTool started from an agent tab would otherwise count among its own.
 */
export async function reapTabProcesses(tabId: string, log: (message: string) => void): Promise<void> {
  const exclude = [process.pid, process.ppid]
  try {
    const pids = signal(await listTagged(tabId, exclude), 'SIGTERM')
    if (pids.length === 0) return
    log(`tabReap tab=${tabId} term=${pids.join(',')}`)
    await new Promise(resolve => setTimeout(resolve, KILL_GRACE_MS))
    const left = await listTagged(tabId, exclude)
    if (signal(left, 'SIGKILL').length > 0) log(`tabReap tab=${tabId} kill=${left.join(',')}`)
  } catch (err) {
    log(`tabReap tab=${tabId} error=${err instanceof Error ? err.message : String(err)}`)
  }
}
