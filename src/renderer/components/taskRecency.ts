/**
 * How often a task's `lastInteractedAt` is stamped while you work in it: once
 * per task per few seconds, so typing doesn't save the project on every key.
 */
export const INTERACTION_STAMP_INTERVAL_MS = 5000

export function createInteractionStampGate(): (taskId: string, now: number) => boolean {
  const lastStamp = new Map<string, number>()
  return (taskId, now) => {
    const previous = lastStamp.get(taskId)
    if (previous !== undefined && now - previous < INTERACTION_STAMP_INTERVAL_MS) {
      return false
    }
    lastStamp.set(taskId, now)
    return true
  }
}
