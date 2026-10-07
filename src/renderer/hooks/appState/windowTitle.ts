import { taskPlace } from '../../../shared/project-label'

/**
 * `project › stream — task`, the stream left out on `main` (see `taskPlace`);
 * just the project on its Home, `DevTool` with nothing selected.
 */
export function buildWindowTitle(
  projectName: string | null,
  taskName: string | null,
  stream?: { name: string; isMain?: boolean } | null
): string {
  if (!projectName) return 'DevTool'
  const place = taskPlace(projectName, taskName ? stream : null)
  return taskName ? `${place} — ${taskName}` : place
}
