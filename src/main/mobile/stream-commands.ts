import { isShellCommandProject, type Project, type ProjectsData, type RunCommand, type Stream } from '../../shared/types'
import {
  newRunCommandId,
  projectRunCommands,
  streamOwnRunCommands,
  withProjectRunCommands,
  withStreamRunCommands
} from '../../shared/stream-run'
import { AppErrorCode, type StreamCommandsParams, type StreamCommandsResult, type StreamCommandsSetParams } from '../../../protocol/ts/index.ts'
import { mobileProject, type MobileOutcome } from './new-stream'

/**
 * `stream.commands.get` and `.set` (SPEC.md §8.21): the project's own commands
 * (no `streamId`, what Project settings edits) or a stream's own (what its
 * Commands… edits), read and replaced from the phone.
 */

/** Where a phone's commands op points: a project it sees that can run commands, and the stream when named. */
export function streamCommandsPlace(data: ProjectsData, projectId: string, streamId: string | undefined): MobileOutcome<{ project: Project; stream?: Stream }> {
  const found = mobileProject(data, projectId)
  if (!found.ok) return found
  const project = found.project
  if (isShellCommandProject(project)) {
    return { ok: false, code: AppErrorCode.Unsupported, message: 'A shell-command project runs one command, not named commands.' }
  }
  if (streamId === undefined) return { ok: true, project }
  const stream = project.streams.find(s => s.id === streamId)
  if (!stream) return { ok: false, code: AppErrorCode.NotFound, message: 'No such stream' }
  return { ok: true, project, stream }
}

/** The list saved there now: the stream's own, else the project's. */
export function savedRunCommands(project: Project, stream: Stream | undefined): RunCommand[] {
  return stream ? streamOwnRunCommands(project, stream) : projectRunCommands(project)
}

export function streamCommandsInData(data: ProjectsData, params: StreamCommandsParams): MobileOutcome<{ result: StreamCommandsResult }> {
  const place = streamCommandsPlace(data, params.projectId, params.streamId)
  if (!place.ok) return place
  const result: StreamCommandsResult = { commands: savedRunCommands(place.project, place.stream) }
  if (place.stream) {
    const inherited = projectRunCommands(place.project)
    if (inherited.length > 0) result.inherited = inherited
  }
  return { ok: true, result }
}

/**
 * Replaces the list. An `id` already in it keeps that command (a run is keyed by
 * it); any other gets a fresh one. `params` is parsed already: trimmed, within
 * limits, names unique.
 */
export function setStreamCommandsInData(
  data: ProjectsData,
  params: StreamCommandsSetParams,
  ids: () => string = newRunCommandId
): MobileOutcome<{ data: ProjectsData; changed: boolean }> {
  const place = streamCommandsPlace(data, params.projectId, params.streamId)
  if (!place.ok) return place
  const { project, stream } = place
  const saved = savedRunCommands(project, stream)
  const known = new Set(saved.map(c => c.id))
  const used = new Set<string>()
  const commands: RunCommand[] = params.commands.map(({ id, name, command }) => {
    let keep = id !== undefined && known.has(id) && !used.has(id) ? id : undefined
    while (!keep || used.has(keep)) keep = ids()
    used.add(keep)
    return { id: keep, name, command }
  })
  if (JSON.stringify(commands) === JSON.stringify(saved)) return { ok: true, data, changed: false }
  const next = stream
    ? { ...project, streams: project.streams.map(s => (s.id === stream.id ? withStreamRunCommands(s, commands) : s)) }
    : withProjectRunCommands(project, commands)
  return { ok: true, data: { ...data, projects: data.projects.map(p => (p.id === project.id ? next : p)) }, changed: true }
}
