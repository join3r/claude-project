import { useState, useEffect, useCallback, useRef } from 'react'
import { useDirtyBufferStore, type DirtyBuffer } from '../../context/DirtyBufferContext'

/** What the unsaved-changes dialog is currently asking about. */
export interface DirtyClosePrompt {
  /** Every unsaved file the pending removal would take, by path. */
  files: string[]
  /** A Save is in flight; the buttons are held until it lands or fails. */
  saving: boolean
  /** Why the last Save did not land. The removal stays un-done while this is set. */
  error: string | null
}

export type DirtyCloseChoice = 'save' | 'discard' | 'cancel'

export interface DirtyCloseActions {
  dirtyPrompt: DirtyClosePrompt | null
  resolveDirtyPrompt: (choice: DirtyCloseChoice) => Promise<void>
  /** Resolves 'proceed' at once when none of `tabIds` has unsaved edits. */
  confirmDiscardDirty: (tabIds: string[]) => Promise<'proceed' | 'cancel'>
}

/** Nothing was dirty, so the removal goes ahead without a dialog ever existing. */
const PROCEED: Promise<'proceed'> = Promise.resolve('proceed')

/**
 * The unsaved-editor gate in front of every tab/task/project removal, plus the
 * report of dirty tabs to main that a phone's task close relies on.
 */
export function useDirtyClosePrompt(): DirtyCloseActions {
  const dirtyBuffers = useDirtyBufferStore()
  const [dirtyPrompt, setDirtyPrompt] = useState<DirtyClosePrompt | null>(null)
  // The buffers themselves never enter state: they carry live closures over the
  // editors, and the dialog only ever needs their paths to render.
  const dirtyPromptBuffersRef = useRef<DirtyBuffer[]>([])
  const dirtyPromptResolveRef = useRef<((outcome: 'proceed' | 'cancel') => void) | null>(null)

  /**
   * The one gate every removal path goes through. Clean tabs never see a dialog
   * — the promise is already resolved — so ⌘W on a terminal costs nothing.
   */
  const confirmDiscardDirty = useCallback((tabIds: string[]): Promise<'proceed' | 'cancel'> => {
    const dirty = dirtyBuffers.getDirtyTabs(tabIds)
    if (dirty.length === 0) return PROCEED
    // A second removal while the dialog is up would strand the first caller's
    // promise; the modal blocks the UI, so this only guards the odd programmatic
    // caller racing the user.
    if (dirtyPromptResolveRef.current) return Promise.resolve('cancel')

    return new Promise<'proceed' | 'cancel'>(resolve => {
      dirtyPromptResolveRef.current = resolve
      dirtyPromptBuffersRef.current = dirty
      setDirtyPrompt({ files: dirty.map(buffer => buffer.filePath), saving: false, error: null })
    })
  }, [dirtyBuffers])

  const settleDirtyPrompt = useCallback((outcome: 'proceed' | 'cancel') => {
    const resolve = dirtyPromptResolveRef.current
    dirtyPromptResolveRef.current = null
    dirtyPromptBuffersRef.current = []
    setDirtyPrompt(null)
    resolve?.(outcome)
  }, [])

  const resolveDirtyPrompt = useCallback(async (choice: DirtyCloseChoice): Promise<void> => {
    if (!dirtyPromptResolveRef.current) return
    if (choice === 'cancel') {
      settleDirtyPrompt('cancel')
      return
    }
    if (choice === 'discard') {
      settleDirtyPrompt('proceed')
      return
    }

    setDirtyPrompt(prev => (prev ? { ...prev, saving: true, error: null } : prev))
    for (const buffer of dirtyPromptBuffersRef.current) {
      try {
        await buffer.save()
      } catch (err) {
        // Nothing is removed on the strength of a write that did not land. The
        // dialog stays up with the reason so the user can retry, discard, or
        // back out — and the rejection dies here rather than reaching the
        // unhandled-rejection crash screen in src/renderer/main.tsx.
        const message = err instanceof Error ? err.message : String(err)
        setDirtyPrompt(prev => (prev
          ? { ...prev, saving: false, error: message ? `Save failed: ${message}` : 'Save failed.' }
          : prev))
        return
      }
    }
    settleDirtyPrompt('proceed')
  }, [settleDirtyPrompt])

  /**
   * Publish this window's unsaved editors to main. A phone's close runs there with
   * nobody in front of a Save/Discard dialog, so a dirty buffer has to be a
   * safeguard rather than a prompt — and main cannot see one on its own.
   */
  useEffect(() => {
    let lastReported = ''
    const report = () => {
      const tabIds = dirtyBuffers.getDirtyTabs().map(buffer => buffer.tabId).sort()
      const serialized = JSON.stringify(tabIds)
      if (serialized === lastReported) return
      lastReported = serialized
      void window.api.reportDirtyTabs(tabIds).catch(() => {})
    }
    report()
    return dirtyBuffers.subscribe(report)
  }, [dirtyBuffers])

  return { dirtyPrompt, resolveDirtyPrompt, confirmDiscardDirty }
}
