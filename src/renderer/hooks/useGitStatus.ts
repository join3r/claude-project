import { useCallback, useEffect, useRef, useState } from 'react'
import type { GitStatusResult } from '../../shared/types'

const GIT_STATUS_REFRESH_MS = 2000

export function useGitStatus(projectDir: string, enabled: boolean): GitStatusResult | null {
  const [gitStatus, setGitStatus] = useState<GitStatusResult | null>(null)
  const requestIdRef = useRef(0)

  const fetchGitStatus = useCallback(() => {
    if (!enabled || !projectDir) {
      requestIdRef.current += 1
      setGitStatus(null)
      return
    }

    const requestId = requestIdRef.current + 1
    requestIdRef.current = requestId

    window.api.fbGitStatus(projectDir)
      .then((status) => {
        if (requestId !== requestIdRef.current) return
        setGitStatus(status)
      })
      .catch(() => {
        if (requestId !== requestIdRef.current) return
        setGitStatus(null)
      })
  }, [enabled, projectDir])

  useEffect(() => {
    if (!enabled || !projectDir) {
      requestIdRef.current += 1
      setGitStatus(null)
      return
    }

    fetchGitStatus()

    const intervalId = window.setInterval(() => {
      fetchGitStatus()
    }, GIT_STATUS_REFRESH_MS)

    const handleFocus = () => fetchGitStatus()
    const handleFileSaved = () => fetchGitStatus()

    window.addEventListener('focus', handleFocus)
    window.addEventListener('file-saved', handleFileSaved)

    return () => {
      requestIdRef.current += 1
      window.clearInterval(intervalId)
      window.removeEventListener('focus', handleFocus)
      window.removeEventListener('file-saved', handleFileSaved)
    }
  }, [enabled, projectDir, fetchGitStatus])

  return gitStatus
}
