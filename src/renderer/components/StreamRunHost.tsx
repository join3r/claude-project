import React, { useState } from 'react'
import { useApp } from '../context/AppContext'
import { closeStreamRunView, useStreamRunView, type StreamRunLogsTarget } from '../streamRuns'
import StreamRunLogs from './StreamRunLogs'
import { Field, HelperText, LinkBtn, Modal, PrimaryButton } from './ui'

/** The window's one place for a stream run's logs and its Run command dialog. */
export default function StreamRunHost(): React.ReactElement | null {
  const view = useStreamRunView()
  if (!view) return null
  const target = { projectId: view.projectId, streamId: view.streamId }
  return view.view === 'logs'
    ? <StreamRunLogs key={`${view.projectId}:${view.streamId}`} {...target} />
    : <StreamRunCommandModal key={`${view.projectId}:${view.streamId}`} {...target} />
}

/** The stream's own app command; blank uses the project's. */
function StreamRunCommandModal({ projectId, streamId }: StreamRunLogsTarget): React.ReactElement | null {
  const { projects, setStreamRunCommand } = useApp()
  const project = projects.find(p => p.id === projectId)
  const stream = project?.streams.find(s => s.id === streamId)
  const [value, setValue] = useState(stream?.runCommand ?? '')
  if (!project || !stream) return null
  const save = () => {
    setStreamRunCommand(projectId, streamId, value)
    closeStreamRunView()
  }
  return (
    <Modal
      title={`Run command · ${stream.name}`}
      onClose={closeStreamRunView}
      footer={
        <>
          <LinkBtn onClick={closeStreamRunView}>Cancel</LinkBtn>
          <PrimaryButton onClick={save}>Save</PrimaryButton>
        </>
      }
    >
      <Field
        autoFocus
        className="font-mono"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') save()
          if (e.key === 'Escape') closeStreamRunView()
        }}
        placeholder={project.runCommand ? project.runCommand : 'e.g. npm run dev'}
      />
      <HelperText>
        {project.runCommand
          ? <>Leave it blank to use the project&apos;s <span className="font-mono">{project.runCommand}</span>. Runs in this stream&apos;s folder.</>
          : <>Runs in this stream&apos;s folder. Set one for every stream in Project settings.</>}
      </HelperText>
    </Modal>
  )
}
