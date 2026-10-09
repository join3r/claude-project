import { useCallback, useEffect, useRef, useState } from 'react'
import type { GitPostureResult } from '../../shared/types'
import { FILE_BROWSER_REFRESH_MS } from './fileBrowserRefresh'

/** `projectId` routes the calls to a DevTool server's project. */
export function useGitPosture(projectDir: string, enabled: boolean, projectId?: string): GitPostureResult | null {
  const [posture, setPosture] = useState<GitPostureResult | null>(null)
  const requestIdRef = useRef(0)

  const fetchPosture = useCallback(() => {
    if (!enabled || !projectDir) {
      requestIdRef.current += 1
      setPosture(null)
      return
    }
    const requestId = requestIdRef.current + 1
    requestIdRef.current = requestId
    window.api.gitProjectPosture(projectDir, projectId)
      .then(result => { if (requestId === requestIdRef.current) setPosture(result) })
      .catch(() => { if (requestId === requestIdRef.current) setPosture(null) })
  }, [enabled, projectDir, projectId])

  useEffect(() => {
    if (!enabled || !projectDir) {
      requestIdRef.current += 1
      setPosture(null)
      return
    }
    fetchPosture()
    const intervalId = window.setInterval(fetchPosture, FILE_BROWSER_REFRESH_MS)
    const onFocus = () => fetchPosture()
    window.addEventListener('focus', onFocus)
    return () => {
      requestIdRef.current += 1
      window.clearInterval(intervalId)
      window.removeEventListener('focus', onFocus)
    }
  }, [enabled, projectDir, fetchPosture])

  return posture
}
