import { useCallback, useEffect, useRef, useState } from 'react'

export function useCommitHistory(projectDir: string, enabled: boolean): {
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
    window.api.gitCommitHistory(projectDir)
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
  }, [enabled, projectDir])

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
