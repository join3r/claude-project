import { useCallback, useEffect, useRef, useState } from 'react'

/** `projectId` routes the call to a DevTool server's project. */
export function useCommitHistory(projectDir: string, enabled: boolean, projectId?: string): {
  commits: string[]
  loading: boolean
} {
  const [commits, setCommits] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const requestIdRef = useRef(0)

  const fetch = useCallback(() => {
    if (!enabled || !projectDir) {
      requestIdRef.current += 1
      setCommits([])
      setLoading(false)
      return
    }
    const requestId = requestIdRef.current + 1
    requestIdRef.current = requestId
    setLoading(true)
    window.api.gitCommitHistory(projectDir, projectId)
      .then(result => {
        if (requestId !== requestIdRef.current) return
        setCommits(result.commits)
        setLoading(false)
      })
      .catch(() => {
        if (requestId !== requestIdRef.current) return
        setCommits([])
        setLoading(false)
      })
  }, [enabled, projectDir, projectId])

  useEffect(() => {
    fetch()
    const onFocus = () => fetch()
    window.addEventListener('focus', onFocus)
    return () => {
      requestIdRef.current += 1
      window.removeEventListener('focus', onFocus)
    }
  }, [fetch])

  return { commits, loading }
}
