/**
 * Tab construction, kept out of `useAppState` so a task can be created with its
 * tabs already in it. Chaining `addTask` then `addTab` is a race: `addTab` reads
 * `projectsRef.current`, which hasn't seen the new task yet, and its empty-task
 * fallback clobbers the view state `addTask` just wrote. One factory means the
 * quirks below (pi's pre-generated session id) live in exactly one place.
 */

import { v4 as uuid } from 'uuid'
import { AI_TAB_META, AI_TAB_TYPES } from '../../shared/types'
import type { AiTabType, NewTaskAutoOpen, Tab, TabType } from '../../shared/types'

export type CreateTabOptions = {
  filePath?: string
  url?: string
  noteId?: string
  noteName?: string
}

export function createTab(type: TabType, options: CreateTabOptions = {}): Tab {
  const { filePath, url, noteId, noteName } = options
  const isAi = (AI_TAB_TYPES as readonly string[]).includes(type)
  let title: string
  if (noteId) {
    title = noteName ?? 'Note'
  } else if (filePath) {
    const fileName = filePath.split('/').pop() ?? filePath
    title = type === 'diff' ? `${fileName} (diff)` : fileName
  } else {
    title = isAi ? AI_TAB_META[type as AiTabType].label : (type === 'terminal' ? 'Terminal' : 'Browser')
  }
  return {
    id: uuid(),
    type,
    title,
    // pi resumes via `--session-id <uuid>`; pre-generate a stable id at creation so
    // the same session is reloaded across app restarts (pi creates it if missing).
    ...(type === 'pi' ? { sessionId: uuid() } : {}),
    ...(filePath ? { filePath } : {}),
    ...(url ? { url } : {}),
    ...(noteId ? { noteId } : {})
  }
}

/** The enable flags an auto-open choice depends on — the AI tools can be turned off. */
export type EnabledTools = { enableClaude: boolean; enableCodex: boolean; enablePi: boolean }

/** Which enable flag gates a choice, if any. */
export function autoOpenRequires(value: NewTaskAutoOpen): keyof EnabledTools | null {
  if (value === 'claude') return 'enableClaude'
  if (value === 'codex') return 'enableCodex'
  if (value === 'pi') return 'enablePi'
  return null
}

/** False when the choice names an AI tool the app is configured to hide. */
export function isAutoOpenAvailable(value: NewTaskAutoOpen, enabled: EnabledTools): boolean {
  const flag = autoOpenRequires(value)
  return flag === null || enabled[flag]
}

/**
 * Tabs a freshly composed task starts with. Opening a tab for a disabled tool
 * would put a tab in the task the rest of the app refuses to offer, so that case
 * opens nothing — the Settings row says as much rather than failing silently.
 */
export function newTaskInitialTabs(value: NewTaskAutoOpen, enabled: EnabledTools): Tab[] {
  if (value === 'none') return []
  if (!isAutoOpenAvailable(value, enabled)) return []
  return [createTab(value)]
}
