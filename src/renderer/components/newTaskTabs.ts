/**
 * Tab construction, kept out of `useAppState` so a task can be created with its
 * tabs already in it. Chaining `addTask` then `addTab` is a race: `addTab` reads
 * `projectsRef.current`, which hasn't seen the new task yet, and its empty-task
 * fallback clobbers the view state `addTask` just wrote. One factory means the
 * quirks below (pi's pre-generated session id) live in exactly one place.
 */

import { v4 as uuid } from 'uuid'
import { AI_TAB_META, AI_TAB_TYPES, CHAT_TAB_LABEL, chatTabTypeFor, isChatTabType } from '../../shared/types'
import type { AiTabType, AppConfig, ChatTabType, ClaudeView, Tab, TabType } from '../../shared/types'

export type CreateTabOptions = {
  filePath?: string
  url?: string
  noteId?: string
  noteName?: string
  cwd?: string
  /** The tab's title, instead of the one its type and options give. */
  title?: string
  artifact?: Tab['artifact']
}

export function createTab(type: TabType, options: CreateTabOptions = {}): Tab {
  const { filePath, url, noteId, noteName, cwd, artifact } = options
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
  } else if (isChatTabType(type)) {
    title = CHAT_TAB_LABEL[type]
  } else {
    title = isAi
      ? AI_TAB_META[type as AiTabType].label
      : (type === 'terminal' ? 'Terminal' : type === 'notebook' ? 'Notebook' : 'Browser')
  }
  return {
    id: uuid(),
    type,
    title,
    // pi resumes via `--session-id <uuid>`, and a chat tab creates its session with
    // the id it is given (a Codex chat swaps it for its new thread's id); pre-generate
    // a stable id at creation so the same session is reloaded across app restarts.
    ...(type === 'pi' || isChatTabType(type) ? { sessionId: uuid() } : {}),
    ...(filePath ? { filePath } : {}),
    ...(url ? { url } : {}),
    ...(noteId ? { noteId } : {}),
    ...(cwd ? { cwd } : {}),
    ...(artifact ? { artifact } : {})
  }
}

/** An agent choice opens as whichever view Settings picks for that agent; anything else is itself. */
export function agentTabType<T extends TabType>(type: T, view: ClaudeView): T | ChatTabType {
  return view === 'chat' && (AI_TAB_TYPES as readonly string[]).includes(type) ? chatTabTypeFor(type as AiTabType) : type
}

/** Settings' default view for an agent's new tabs. */
export function defaultAgentView(config: Pick<AppConfig, 'claudeDefaultView' | 'codexDefaultView' | 'piDefaultView'> | null | undefined, agent: AiTabType): ClaudeView {
  if (!config) return 'chat'
  return agent === 'claude' ? config.claudeDefaultView : agent === 'codex' ? config.codexDefaultView : config.piDefaultView
}
