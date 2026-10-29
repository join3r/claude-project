import React, { useState } from 'react'
import { useApp } from '../context/AppContext'
import { projectRunCommands, streamOwnRunCommands } from '../../shared/stream-run'
import type { RunCommand } from '../../shared/types'
import { closeStreamRunView, useStreamRunView, type StreamRunStreamTarget } from '../streamRuns'
import StreamRunLogs from './StreamRunLogs'
import { StreamRunPicker } from './StreamRunControls'
import RunCommandsEditor, { cleanRunCommandDrafts, runCommandDraftsProblem } from './RunCommandsEditor'
import { HelperText, LinkBtn, Modal, PrimaryButton } from './ui'

/** The window's one place for a run's logs, the command picker and a stream's commands dialog. */
export default function StreamRunHost(): React.ReactElement | null {
  const view = useStreamRunView()
  if (!view) return null
  if (view.view === 'logs') {
    return <StreamRunLogs key={`${view.projectId}:${view.streamId}:${view.commandId}`} projectId={view.projectId} streamId={view.streamId} commandId={view.commandId} />
  }
  if (view.view === 'picker') {
    // A fresh menu each time it opens, wherever it was before.
    return <StreamRunPicker key={`${view.x}:${view.y}`} {...view} onClose={closeStreamRunView} />
  }
  return <StreamRunCommandsModal key={`${view.projectId}:${view.streamId}`} projectId={view.projectId} streamId={view.streamId} />
}

/** The stream's own commands: one named like a project command replaces it here, the others are added. */
function StreamRunCommandsModal({ projectId, streamId }: StreamRunStreamTarget): React.ReactElement | null {
  const { projects, setStreamRunCommands } = useApp()
  const project = projects.find(p => p.id === projectId)
  const stream = project?.streams.find(s => s.id === streamId)
  const [value, setValue] = useState<RunCommand[]>(() => (project ? streamOwnRunCommands(project, stream) : []))
  if (!project || !stream) return null
  const problem = runCommandDraftsProblem(value)
  const projectCommands = projectRunCommands(project)
  const save = () => {
    if (problem) return
    setStreamRunCommands(projectId, streamId, cleanRunCommandDrafts(value))
    closeStreamRunView()
  }
  return (
    <Modal
      title={`Commands · ${stream.name}`}
      onClose={closeStreamRunView}
      footer={
        <>
          <LinkBtn onClick={closeStreamRunView}>Cancel</LinkBtn>
          <PrimaryButton onClick={save} disabled={!!problem}>Save</PrimaryButton>
        </>
      }
    >
      {projectCommands.length > 0 && (
        <div className="flex flex-col gap-0.5 mb-3" data-testid="stream-commands-project">
          <div className="text-xs text-text-subtle">From the project</div>
          {projectCommands.map(c => (
            <div key={c.id} className="flex items-baseline gap-2 text-xs min-w-0">
              <span className="text-text shrink-0">{c.name}</span>
              <span className="font-mono text-text-subtle truncate" title={c.command}>{c.command}</span>
            </div>
          ))}
        </div>
      )}
      <RunCommandsEditor value={value} onChange={setValue} namePlaceholder={projectCommands[0]?.name ?? 'run'} onEnter={save} />
      <HelperText>
        {problem ?? (projectCommands.length > 0
          ? <>Only in this stream. Use a project command&apos;s name to replace it here; other names are added. They run in this stream&apos;s folder or a task&apos;s worktree.</>
          : <>Only in this stream; they run in its folder or a task&apos;s worktree. Set commands for every stream in Project settings.</>)}
      </HelperText>
    </Modal>
  )
}
