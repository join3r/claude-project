import React, { useState } from 'react'
import { useApp } from '../context/AppContext'
import { projectRunCommands, streamOwnRunCommands } from '../../shared/stream-run'
import { isRemoteProject, type RunCommand } from '../../shared/types'
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

/**
 * A stream's commands: the project's, for every stream, and the stream's own,
 * where one named like a project command replaces it here and the others are added.
 * Both lists are edited here and saved together.
 */
function StreamRunCommandsModal({ projectId, streamId }: StreamRunStreamTarget): React.ReactElement | null {
  const { projects, setStreamRunCommands } = useApp()
  const project = projects.find(p => p.id === projectId)
  const stream = project?.streams.find(s => s.id === streamId)
  const [projectValue, setProjectValue] = useState<RunCommand[]>(() => (project ? projectRunCommands(project) : []))
  const [value, setValue] = useState<RunCommand[]>(() => (project ? streamOwnRunCommands(project, stream) : []))
  if (!project || !stream) return null
  const projectProblem = runCommandDraftsProblem(projectValue)
  const problem = runCommandDraftsProblem(value)
  const projectCommands = cleanRunCommandDrafts(projectValue)
  const canSuggest = !isRemoteProject(project)
  const save = () => {
    if (problem || projectProblem) return
    setStreamRunCommands(projectId, streamId, cleanRunCommandDrafts(value), projectCommands)
    closeStreamRunView()
  }
  return (
    <Modal
      title={`Commands · ${stream.name}`}
      onClose={closeStreamRunView}
      footer={
        <>
          <LinkBtn onClick={closeStreamRunView}>Cancel</LinkBtn>
          <PrimaryButton onClick={save} disabled={!!problem || !!projectProblem}>Save</PrimaryButton>
        </>
      }
    >
      <div className="flex flex-col gap-1.5 mb-4" data-testid="stream-commands-project">
        <div className="text-xs text-text-subtle">Every stream</div>
        <RunCommandsEditor
          value={projectValue}
          onChange={setProjectValue}
          onEnter={save}
          suggest={canSuggest ? (current) => window.api.runCommandsSuggest(projectId, undefined, current) : undefined}
        />
        <HelperText>{projectProblem ?? <>The project&apos;s commands, the same as in Project settings.</>}</HelperText>
      </div>
      <div className="flex flex-col gap-1.5" data-testid="stream-commands-own">
        <div className="text-xs text-text-subtle">Only in {stream.name}</div>
        <RunCommandsEditor
          value={value}
          onChange={setValue}
          namePlaceholder={projectCommands[0]?.name ?? 'run'}
          onEnter={save}
          suggest={canSuggest ? (current) => window.api.runCommandsSuggest(projectId, streamId, current) : undefined}
          inherited={projectCommands}
        />
        <HelperText>
          {problem ?? (projectCommands.length > 0
            ? <>Use a project command&apos;s name to replace it here; other names are added. They run in this stream&apos;s folder or a task&apos;s worktree.</>
            : <>They run in this stream&apos;s folder or a task&apos;s worktree.</>)}
        </HelperText>
      </div>
    </Modal>
  )
}
