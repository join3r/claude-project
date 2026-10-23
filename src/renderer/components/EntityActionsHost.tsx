import React, { useEffect, useState } from 'react'
import { useApp } from '../context/AppContext'
import { isRemoteProject, isShellCommandProject } from '../../shared/types'
import type { Project } from '../../shared/types'
import { closeEntityDialog, onCloseStreamRequest, openEntityDialog, useEntityDialog } from '../entityActions'
import { paletteEvents } from '../palette/paletteEvents'
import { useMissingProjectDirs } from '../hooks/useMissingProjectDirs'
import { useCloseStream } from './sidebar/useCloseStream'
import ProjectSettings from './ProjectSettings'
import RenameProjectModal from './RenameProjectModal'
import MoveToServerDialog from './servers/MoveToServerDialog'
import StreamSetupModal from './StreamSetupModal'
import AddRemoteProject from './AddRemoteProject'
import AddShellCommandProject from './AddShellCommandProject'
import AddLocalProject from './AddLocalProject'
import { Field, LinkBtn, Modal, PrimaryButton } from './ui'

/**
 * The dialogs a project or stream menu opens (`entityActions`), and the close
 * flow of a stream closed from one, wherever the menu was shown. Mounted once
 * per window by App, so they work with the sidebar on the Inbox or hidden.
 */
export default function EntityActionsHost(): React.ReactElement {
  const { selectedProjectId } = useApp()
  const dialog = useEntityDialog()
  const closeStreamFlow = useCloseStream()
  const closeStream = closeStreamFlow.closeStream

  useEffect(() => onCloseStreamRequest((projectId, streamId) => { void closeStream(projectId, streamId) }), [closeStream])

  // ⌘K → Open Project Settings, on the project this window is in.
  useEffect(() => paletteEvents.on('open-project-settings', () => {
    if (selectedProjectId) openEntityDialog({ kind: 'project-settings', projectId: selectedProjectId })
  }), [selectedProjectId])

  return (
    <>
      {dialog && <EntityDialogView key={dialogKey(dialog)} />}
      {closeStreamFlow.dialog}
    </>
  )
}

function dialogKey(dialog: NonNullable<ReturnType<typeof useEntityDialog>>): string {
  switch (dialog.kind) {
    case 'move-to-server': return `${dialog.kind}:${dialog.project.id}`
    case 'rename': return `${dialog.kind}:${dialog.projectId}:${dialog.streamId ?? ''}`
    case 'stream-setup': return `${dialog.kind}:${dialog.streamId}`
    default: return `${dialog.kind}:${dialog.projectId}`
  }
}

function EntityDialogView(): React.ReactElement | null {
  const { projects, updateProject } = useApp()
  const dialog = useEntityDialog()
  if (!dialog) return null
  if (dialog.kind === 'move-to-server') {
    return <MoveToServerDialog project={dialog.project} onClose={closeEntityDialog} />
  }
  if (dialog.kind === 'stream-setup') {
    return (
      <StreamSetupModal
        projectId={dialog.projectId}
        streamId={dialog.streamId}
        branch={dialog.branch}
        pending={dialog.pending}
        serverId={projects.find(p => p.id === dialog.projectId)?.host}
        onClose={closeEntityDialog}
      />
    )
  }
  const project = projects.find(p => p.id === dialog.projectId)
  if (!project) return null
  switch (dialog.kind) {
    case 'project-settings':
      return (
        <ProjectSettings
          project={project}
          onSave={(payload) => updateProject(project.id, payload)}
          onClose={closeEntityDialog}
          onMoveToServer={() => openEntityDialog({ kind: 'move-to-server', project })}
        />
      )
    case 'rename-project':
      return <RenameFolderProject project={project} />
    case 'rename':
      return <RenameDialog project={project} streamId={dialog.streamId} />
    case 'duplicate-project':
      return <DuplicateProject project={project} />
  }
}

/** Rename… for a project with a folder; whether the folder is still there decides if it can follow. */
function RenameFolderProject({ project }: { project: Project }): React.ReactElement {
  const { renameProject } = useApp()
  const missing = useMissingProjectDirs([project])
  return (
    <RenameProjectModal
      project={project}
      folderMissing={missing.has(project.id)}
      onRenameOnly={(name) => renameProject(project.id, name)}
      onClose={closeEntityDialog}
    />
  )
}

/** A new name for a stream, or for a project without a folder: what the tree does in place. */
function RenameDialog({ project, streamId }: { project: Project; streamId?: string }): React.ReactElement | null {
  const { renameProject, renameStream } = useApp()
  const stream = streamId ? project.streams.find(s => s.id === streamId) : undefined
  const [value, setValue] = useState(stream ? stream.name : project.name)
  if (streamId && !stream) return null
  const save = () => {
    const name = value.trim()
    if (name) {
      if (stream) renameStream(project.id, stream.id, name)
      else renameProject(project.id, name)
    }
    closeEntityDialog()
  }
  return (
    <Modal
      title={stream ? `Rename stream · ${stream.name}` : `Rename ${project.name}`}
      onClose={closeEntityDialog}
      footer={
        <>
          <LinkBtn onClick={closeEntityDialog}>Cancel</LinkBtn>
          <PrimaryButton onClick={save} disabled={!value.trim()}>Rename</PrimaryButton>
        </>
      }
    >
      <Field
        autoFocus
        aria-label={stream ? 'Stream name' : 'Project name'}
        className={stream ? 'font-mono' : undefined}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onFocus={(e) => e.currentTarget.select()}
        onKeyDown={(e) => {
          if (e.key === 'Enter') save()
          if (e.key === 'Escape') closeEntityDialog()
        }}
      />
    </Modal>
  )
}

/** Duplicate: the add dialog of the project's kind, filled in from it. */
function DuplicateProject({ project }: { project: Project }): React.ReactElement {
  const { tags, addTag, addProject, addRemoteProject, addShellCommandProject } = useApp()
  if (isRemoteProject(project)) {
    return (
      <AddRemoteProject
        allTags={tags}
        onEnsureTag={addTag}
        initialValues={{
          host: project.ssh!.host,
          port: project.ssh!.port,
          username: project.ssh!.username,
          keyFile: project.ssh!.keyFile,
          remoteDir: project.ssh!.remoteDir,
          aiToolArgs: project.aiToolArgs
        }}
        onAdd={(name, ssh, aiToolArgs, tagIds) => {
          addRemoteProject(name, ssh, aiToolArgs, tagIds)
          closeEntityDialog()
        }}
        onCancel={closeEntityDialog}
      />
    )
  }
  if (isShellCommandProject(project)) {
    return (
      <AddShellCommandProject
        allTags={tags}
        onEnsureTag={addTag}
        initialValues={{
          name: project.name,
          command: project.shellCommand!.command
        }}
        onAdd={(name, command, tagIds) => {
          addShellCommandProject(name, command, tagIds)
          closeEntityDialog()
        }}
        onCancel={closeEntityDialog}
      />
    )
  }
  return (
    <AddLocalProject
      allTags={tags}
      onEnsureTag={addTag}
      initialValues={{
        name: project.name,
        directory: project.directory
      }}
      onAdd={(name, directory, tagIds) => {
        addProject(name, directory, tagIds)
        closeEntityDialog()
      }}
      onCancel={closeEntityDialog}
    />
  )
}
