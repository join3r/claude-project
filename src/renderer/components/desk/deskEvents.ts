/**
 * Requests for the desk column from elsewhere in the window: ⌘N and the
 * palette's New task focus its compose box (optionally aimed at a project or
 * stream) instead of opening the New task dialog. A task filed from the full
 * form that compose's Options… opened clears the text compose handed it.
 */
type Where = { projectId: string; streamId?: string }
type Listener = (where: Where | null) => void

const listeners = new Set<Listener>()
const clearListeners = new Set<() => void>()

export const deskEvents = {
  focusCompose(where: Where | null = null): void {
    for (const listener of listeners) listener(where)
  },
  onFocusCompose(listener: Listener): () => void {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  },
  clearCompose(): void {
    for (const listener of clearListeners) listener()
  },
  onClearCompose(listener: () => void): () => void {
    clearListeners.add(listener)
    return () => { clearListeners.delete(listener) }
  }
}
