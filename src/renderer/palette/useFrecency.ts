import { useCallback, useEffect, useRef, useState } from 'react'
import { recordUse, type FrecencyState } from './frecency'

/**
 * The palette's use counts (main's palette-frecency file), loaded once and saved
 * a second after the last change. Shared by the palette and the desk's ⌘K bar,
 * whose ids follow the same `kind:…` scheme.
 */
export function useFrecency(): { frecency: FrecencyState; record: (id: string) => void } {
  const [frecency, setFrecency] = useState<FrecencyState>({})
  const saveTimer = useRef<number | null>(null)
  const loaded = useRef(false)

  useEffect(() => {
    const api = (window as any).api
    if (!api?.paletteFrecencyLoad) return
    api.paletteFrecencyLoad().then((file: any) => {
      loaded.current = true
      if (file && file.entries) setFrecency(prev => ({ ...file.entries, ...prev }))
    })
  }, [])

  useEffect(() => {
    if (saveTimer.current) window.clearTimeout(saveTimer.current)
    // Nothing to save before the file loaded: an early save would wipe it.
    if (!loaded.current) return
    saveTimer.current = window.setTimeout(() => {
      const api = (window as any).api
      if (api?.paletteFrecencySave) {
        api.paletteFrecencySave({ version: 1, entries: frecency })
      }
    }, 1000)
    return () => { if (saveTimer.current) window.clearTimeout(saveTimer.current) }
  }, [frecency])

  const record = useCallback((id: string) => setFrecency(prev => recordUse(prev, id, Date.now())), [])
  return { frecency, record }
}
