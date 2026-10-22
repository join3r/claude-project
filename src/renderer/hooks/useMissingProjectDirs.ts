import { useEffect, useState } from 'react'
import type { Project } from '../../shared/types'

const RECHECK_MS = 60_000
const NONE: ReadonlySet<string> = new Set()

/**
 * Ids of projects whose folder is gone (moved, renamed or deleted outside
 * DevTool), on this computer and on each DevTool server a project lives on.
 * Rechecked when a project's folder changes, when the window gets focus (you
 * likely just did something in Finder) and once a minute. A host that can't
 * answer (a server offline) keeps what it said last.
 */
export function useMissingProjectDirs(projects: readonly Project[]): ReadonlySet<string> {
  const [missing, setMissing] = useState<ReadonlySet<string>>(NONE)
  // Only folder projects matter; a key of them keeps unrelated edits from rechecking.
  const folders = projects.filter(p => !p.ssh && !p.shellCommand && p.directory)
  const key = folders.map(p => `${p.host ?? 'local'}\u0000${p.id}\u0000${p.directory}`).join('\u0001')
  const hosts = [...new Set(folders.map(p => p.host ?? 'local'))].join('\u0001')

  useEffect(() => {
    let cancelled = false
    const byHost = new Map<string, string[]>()
    const check = () => {
      for (const host of hosts ? hosts.split('\u0001') : []) {
        window.api.missingProjectDirs(host).then(ids => {
          if (cancelled || !Array.isArray(ids)) return
          byHost.set(host, ids)
          const all = [...byHost.values()].flat()
          setMissing(prev => {
            if (prev.size === all.length && all.every(id => prev.has(id))) return prev
            return all.length === 0 ? NONE : new Set(all)
          })
        }).catch(() => {})
      }
    }
    if (!hosts) setMissing(NONE)
    check()
    window.addEventListener('focus', check)
    const timer = window.setInterval(check, RECHECK_MS)
    return () => {
      cancelled = true
      window.removeEventListener('focus', check)
      window.clearInterval(timer)
    }
  }, [key, hosts])

  return missing
}
