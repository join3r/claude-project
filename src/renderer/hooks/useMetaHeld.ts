import { useEffect } from 'react'

const CLASS_NAME = 'meta-held'

export function useMetaHeld(): void {
  useEffect(() => {
    const add = () => document.body.classList.add(CLASS_NAME)
    const remove = () => document.body.classList.remove(CLASS_NAME)

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Meta') add()
    }

    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'Meta' || !e.metaKey) remove()
    }

    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', remove)

    return () => {
      remove()
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', remove)
    }
  }, [])
}
