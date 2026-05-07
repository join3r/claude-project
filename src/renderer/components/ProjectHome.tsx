import React from 'react'
import { useApp } from '../context/AppContext'
import { useGitStatus } from '../hooks/useGitStatus'
import { isRemoteProject, isShellCommandProject } from '../../shared/types'
import GitStatus from './GitStatus'
import { ProjectReadme } from './ProjectReadme'
import { RecentNotesList } from './RecentNotesList'

interface Props { projectId: string }

export function ProjectHome({ projectId }: Props): React.ReactElement | null {
  const actions = useApp()
  const project = actions.projects.find(p => p.id === projectId)
  const isLocal = project ? !isRemoteProject(project) && !isShellCommandProject(project) : false
  const projectDir = isLocal && project?.directory ? project.directory : ''
  const gitStatus = useGitStatus(projectDir, isLocal)

  if (!project) return null

  const taskId = project.tasks[0]?.id

  return (
    <div className="flex-1 min-h-0 flex bg-bg text-text">
      <div className="basis-3/5 grow-0 shrink min-w-0 flex flex-col overflow-y-auto border-r border-border">
        <ProjectReadme project={project} />
        {isLocal && (
          <section className="px-4 py-3 border-t border-border">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-text-subtle mb-2">Git Status</h2>
            {gitStatus ? (
              <GitStatus
                gitStatus={gitStatus}
                projectDir={projectDir}
                onFileClick={(filePath) => {
                  if (!taskId) return
                  actions.openOrFocusDiffTab(project.id, taskId, 'left', filePath)
                }}
              />
            ) : (
              <div className="text-sm text-text-subtle">No git status available.</div>
            )}
          </section>
        )}
      </div>
      <div className="basis-2/5 grow-0 shrink min-w-0 flex flex-col overflow-y-auto">
        <RecentNotesList project={project} />
      </div>
    </div>
  )
}
