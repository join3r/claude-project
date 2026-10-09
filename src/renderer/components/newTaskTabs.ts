/**
 * Tab construction, kept out of `useAppState` so a task can be created with its
 * tabs already in it. Chaining `addTask` then `addTab` is a race: `addTab` reads
 * `projectsRef.current`, which hasn't seen the new task yet, and its empty-task
 * fallback clobbers the view state `addTask` just wrote. One factory means the
 * quirks below (pi's pre-generated session id) live in exactly one place.
 */

import { v4 as uuid } from 'uuid'
import { AI_TAB_META, AI_TAB_TYPES, CLAUDE_CHAT_LABEL } from '../../shared/types'
import type { AiTabType, ClaudeView, Tab, TabType } from '../../shared/types'

export type CreateTabOptions = {
  filePath?: string
  url?: string
  noteId?: string
  noteName?: string
  cwd?: string
  /** The tab's title, instead of the one its type and options give. */
  title?: string
}

export function createTab(type: TabType, options: CreateTabOptions = {}): Tab {
  const { filePath, url, noteId, noteName, cwd } = options
  const isAi = (AI_TAB_TYPES as readonly string[]).includes(type)
  let title: string
  if (options.title?.trim()) {
    title = options.title.trim()
  } else if (noteId) {
    title = noteName ?? 'Note'
  } else if (filePath) {
    const fileName = filePath.split('/').pop() ?? filePath
    title = type === 'diff' ? `${fileName} (diff)` : fileName
  } else if (cwd && type === 'terminal') {
    const folder = cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? 'Terminal'
    title = folder
  } else if (type === 'claude-chat') {
    title = CLAUDE_CHAT_LABEL
  } else {
    title = isAi
      ? AI_TAB_META[type as AiTabType].label
      : (type === 'terminal' ? 'Terminal' : type === 'notebook' ? 'Notebook' : 'Browser')
  }
  return {
    id: uuid(),
    type,
    title,
    // pi resumes via `--session-id <uuid>`, and a chat tab creates its Claude session
    // with the id it is given; pre-generate a stable id at creation so the same
    // session is reloaded across app restarts.
    ...(type === 'pi' || type === 'claude-chat' ? { sessionId: uuid() } : {}),
    ...(filePath ? { filePath } : {}),
    ...(url ? { url } : {}),
    ...(noteId ? { noteId } : {}),
    ...(cwd ? { cwd } : {})
  }
}

/** A Claude choice opens as whichever view Settings picks; anything else is itself. */
export function claudeTabType<T extends TabType>(type: T, claudeView: ClaudeView): T | 'claude-chat' {
  return type === 'claude' && claudeView === 'chat' ? 'claude-chat' : type
}
