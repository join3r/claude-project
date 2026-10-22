import { useEffect, useState } from 'react'
import type { Project } from '../../shared/types'

const RECHECK_MS = 60_000
const NONE: ReadonlySet<string> = new Set()

/**
 * Ids of local projects whose folder is gone (moved, renamed or deleted outside
 * DevTool). Rechecked when a project's folder changes, when the window gets focus
 * (you likely just did something in Finder) and once a minute.
 */
export function useMissingProjectDirs(projects: readonly Project[]): ReadonlySet<string> {
  const [missing, setMissing] = useState<ReadonlySet<string>>(NONE)
  // Only local folders matter; a key of them keeps unrelated edits from rechecking.
  const key = projects
    .filter(p => !p.ssh && !p.host && !p.shellCommand && p.directory)
    .map(p => `${p.id}\u0000${p.directory}`)
    .join('\u0001')

  useEffect(() => {
    let cancelled = false
    const check = () => {
      window.api.missingProjectDirs().then(ids => {
        if (cancelled || !Array.isArray(ids)) return
        setMissing(prev => {
          if (prev.size === ids.length && ids.every(id => prev.has(id))) return prev
          return ids.length === 0 ? NONE : new Set(ids)
        })
      }).catch(() => {})
    }
    check()
    window.addEventListener('focus', check)
    const timer = window.setInterval(check, RECHECK_MS)
    return () => {
      cancelled = true
      window.removeEventListener('focus', check)
      window.clearInterval(timer)
    }
  }, [key])

  return missing
}
