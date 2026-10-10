import type { ProjectsData } from './types'
import { mapTaskInProject } from './streams'

/** How long a task name taken from a prompt may be: about what the sidebar shows. */
export const TASK_NAME_FROM_PROMPT_MAX = 50

/**
 * A task name from a prompt's first non-empty line, whitespace collapsed, cut with
 * an ellipsis to fit. Shared by the desktop's prompt box and the phone's `task.new`.
 */
export function taskNameFromPrompt(text: string, max = TASK_NAME_FROM_PROMPT_MAX): string {
  const line = text.split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).find((l) => l.length > 0) ?? ''
  if (line.length <= max) return line
  return line.slice(0, max - 1).trimEnd() + '…'
}

/** Past this a model's title is no better than the prompt's first line. */
export const TASK_TITLE_MAX = 40

/**
 * A model's reply as a task name: its first line, unquoted, without a "Title:"
 * label or a closing period. Null when nothing usable is left or it runs too long.
 */
export function cleanTaskTitle(raw: string): string | null {
  const line = raw.split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).find((l) => l.length > 0) ?? ''
  const title = line
    .replace(/^(?:title|task|name)\s*:\s*/i, '')
    .replace(/^[*_#`"'“”‘’«»\s]+|[*_`"'“”‘’«»\s]+$/g, '')
    .replace(/[.。]+$/, '')
    .trim()
  if (!title || title.length > TASK_TITLE_MAX) return null
  return title
}

/**
 * Rename a task to `name` only while it still has the name it was born with
 * (`from`), so a rename made in the meantime wins. Unchanged data when it doesn't apply.
 */
export function renameTaskIfStill(data: ProjectsData, taskId: string, from: string, name: string): ProjectsData {
  let changed = false
  const projects = data.projects.map((project) =>
    mapTaskInProject(project, taskId, (task) => {
      if (task.name !== from || task.name === name) return task
      changed = true
      return { ...task, name }
    })
  )
  return changed ? { ...data, projects } : data
}
