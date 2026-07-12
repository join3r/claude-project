import React from 'react'
import { useApp } from '../context/AppContext'
import { GrpHead, FormGroup } from './ui'
import { useGitPosture } from '../hooks/useGitPosture'
import { useCommitHistory } from '../hooks/useCommitHistory'
import { isRemoteProject, isShellCommandProject } from '../../shared/types'
import { CommitHeatmap } from './CommitHeatmap'
import { CommitSparkline } from './CommitSparkline'
import { formatRelativeTime } from './projectStats'
import type { Tab, TabType } from '../../shared/types'

interface Props { projectId: string }

const TAB_TYPE_ORDER: TabType[] = ['terminal', 'editor', 'diff', 'note', 'browser', 'claude', 'codex', 'pi']
const TAB_TYPE_LABEL: Record<TabType, string> = {
  terminal: 'terminal', editor: 'editor', diff: 'diff', note: 'note',
  browser: 'browser', claude: 'claude', codex: 'codex', pi: 'pi',
  home: 'home'
}

export function ProjectHome({ projectId }: Props): React.ReactElement | null {
  const actions = useApp()
  const project = actions.projects.find(p => p.id === projectId)
  const isLocal = project ? !isRemoteProject(project) && !isShellCommandProject(project) : false
  const projectDir = isLocal && project?.directory ? project.directory : ''
  const posture = useGitPosture(projectDir, isLocal)
  const { commits } = useCommitHistory(projectDir, isLocal)

  if (!project) return null

  const visibleTasks = project.tasks.filter(t => t.system !== 'home')
  const allTabs: Tab[] = visibleTasks.flatMap(t => [...t.tabs.left, ...t.tabs.right]).filter(tab => tab.system !== 'home')
  const tabsByType = new Map<TabType, number>()
  for (const tab of allTabs) tabsByType.set(tab.type, (tabsByType.get(tab.type) ?? 0) + 1)
  const tabBreakdown = TAB_TYPE_ORDER
    .map(type => ({ type, count: tabsByType.get(type) ?? 0 }))
    .filter(x => x.count > 0)

  const activeTaskCount = visibleTasks.length
  const mostRecentTask = visibleTasks
    .filter(t => t.lastInteractedAt)
    .sort((a, b) => (b.lastInteractedAt ?? 0) - (a.lastInteractedAt ?? 0))[0] ?? null

  const lifetime = project.lifetimeStats ?? {
    tasksCreated: visibleTasks.length,
    notesCreated: (actions.notes[project.id] ?? []).length
  }

  return (
    <div className="flex-1 min-h-0 flex flex-col overflow-y-auto bg-bg text-text">
      <div className="px-4 py-3 max-w-[760px] w-full mx-auto flex flex-col gap-2">
        {isLocal && (
          <>
            <GrpHead>Git</GrpHead>
            <FormGroup>
              {!posture ? (
                <div className="text-base text-text-subtle">Loading…</div>
              ) : !posture.isGitRepo ? (
                <div className="text-base text-text-subtle">Not a git repository.</div>
              ) : (
                <div className="text-base text-text leading-[1.6]">
                  <div>
                    on <span className="font-mono">{posture.branch ?? '(detached)'}</span>
                    {posture.upstream && (
                      <>
                        {' · '}
                        <span className={posture.ahead > 0 ? 'text-success' : 'text-text-subtle'}>{posture.ahead} ahead</span>
                        {', '}
                        <span className={posture.behind > 0 ? 'text-warn' : 'text-text-subtle'}>{posture.behind} behind</span>
                      </>
                    )}
                    {' · '}
                    <span className={posture.dirtyCount > 0 ? 'text-warn' : 'text-text-subtle'}>{posture.dirtyCount} dirty</span>
                  </div>
                  {posture.lastCommit && (
                    <div className="text-text-subtle text-xs mt-1 truncate" title={posture.lastCommit.subject}>
                      last: {posture.lastCommit.subject} · {formatRelativeTime(new Date(posture.lastCommit.isoDate).getTime())} · {posture.lastCommit.author}
                    </div>
                  )}
                </div>
              )}
            </FormGroup>
          </>
        )}

        <GrpHead>Activity</GrpHead>
        <div className="grid grid-cols-3 gap-2">
          <FormGroup>
            <div className="text-xs text-text-muted">Active tasks</div>
            <div className="text-xl font-semibold text-text">{activeTaskCount}</div>
            {mostRecentTask && mostRecentTask.lastInteractedAt && (
              <div className="text-xs text-text-subtle truncate" title={mostRecentTask.name}>
                last touched: {mostRecentTask.name} · {formatRelativeTime(mostRecentTask.lastInteractedAt)}
              </div>
            )}
          </FormGroup>
          <FormGroup>
            <div className="text-xs text-text-muted">Open tabs</div>
            <div className="text-xl font-semibold text-text">{allTabs.length} <span className="text-xs text-text-subtle font-normal">total</span></div>
            {tabBreakdown.length > 0 && (
              <ul className="text-xs text-text-subtle space-y-0.5">
                {tabBreakdown.map(x => (
                  <li key={x.type}>• {x.count} {TAB_TYPE_LABEL[x.type]}</li>
                ))}
              </ul>
            )}
          </FormGroup>
          <FormGroup>
            <div className="text-xs text-text-muted">Lifetime</div>
            <div className="text-base text-text leading-[1.6]">
              <div><span className="text-xl font-semibold">{lifetime.tasksCreated}</span> tasks created</div>
              <div><span className="text-xl font-semibold">{lifetime.notesCreated}</span> notes written</div>
            </div>
          </FormGroup>
        </div>

        {isLocal && posture?.isGitRepo && (
          <>
            <CommitHeatmap isoTimestamps={commits} />
            <CommitSparkline isoTimestamps={commits} />
          </>
        )}
      </div>
    </div>
  )
}
