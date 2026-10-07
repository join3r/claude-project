export function buildWindowTitle(projectName: string | null, taskName: string | null): string {
  if (projectName && taskName) {
    return `${projectName} / ${taskName}`
  }
  if (projectName) {
    return projectName
  }
  return 'DevTool'
}
