import React from 'react'
import type { Project, Stream, Task } from '../../shared/types'
import { LinkBtn, PrimaryButton } from './ui'
import { setLandingNotice, useLandingNotice, useLandingOp, type LandingOp } from '../taskLanding'
import { useTaskLandingActions } from './useTaskLandingActions'
import { taskAgentTab } from './taskHeaderState'

/** Files shown in the banner before "and N more". */
const FILE_LIMIT = 8

function plural(count: number, one: string): string {
  return `${count} ${count === 1 ? one : `${one}s`}`
}

/** What a running call is doing, by the call. */
function runningText(op: LandingOp, streamName: string): string {
  switch (op) {
    case 'update': return `Updating from ${streamName}…`
    case 'retry': return 'Retrying…'
    case 'abort': return 'Aborting…'
    case 'fix': return 'Asking the agent to fix it…'
    case 'keep':
    case 'discard': return 'Closing…'
    default: return `Landing into ${streamName}…`
  }
}

function FileList({ files }: { files: string[] }): React.ReactElement {
  const shown = files.slice(0, FILE_LIMIT)
  return (
    <ul className="m-0 mt-1 p-0 list-none font-mono text-xs text-text-muted" data-testid="task-landing-files">
      {shown.map(file => <li key={file} className="truncate" title={file}>{file}</li>)}
      {files.length > shown.length && <li className="text-text-subtle">and {files.length - shown.length} more</li>}
    </ul>
  )
}

/**
 * Above a task's panes while its landing into the stream runs or has stopped
 * (`Task.landing`), and for the last landing call's result. A conflict offers
 * Ask agent to fix / I'll fix it (a terminal in the worktree) / Retry / Abort;
 * a blocked stream offers Retry / Abort.
 */
export default function TaskLandingBanner({ project, stream, task }: { project: Project; stream: Stream; task: Task }): React.ReactElement | null {
  const op = useLandingOp(task.id)
  const notice = useLandingNotice(task.id)
  const actions = useTaskLandingActions()
  const landing = task.landing
  if (!landing && !op && !notice) return null

  const streamName = stream.name
  const busy = !!op
  const updating = landing?.intent === 'update'
  const files = landing?.files ?? []
  let title: React.ReactNode = null
  let detail: React.ReactNode = null
  let buttons: React.ReactNode = null
  let alert = false

  if (op && op !== 'retry' && op !== 'abort' && op !== 'fix') {
    title = runningText(op, streamName)
  } else if (landing?.state === 'conflict') {
    alert = true
    title = updating
      ? `Updating from ${streamName} stopped on conflicts in ${plural(files.length, 'file')}`
      : `Conflicts with ${streamName} in ${plural(files.length, 'file')}`
    detail = (
      <>
        Resolve them in the task&apos;s worktree, <span className="font-mono">git add</span> them, then Retry.
        Abort puts the branch back as it was.
      </>
    )
    const agentMissing = taskAgentTab(task) ? undefined : 'This task has no agent tab'
    buttons = (
      <>
        <LinkBtn danger disabled={busy} onClick={() => void actions.abort(project, task)}>Abort</LinkBtn>
        <LinkBtn disabled={busy} onClick={() => void actions.retry(project, task)}>Retry</LinkBtn>
        <LinkBtn disabled={busy} onClick={() => actions.fixByHand(project, task)}>I&apos;ll fix it</LinkBtn>
        <span title={agentMissing}>
          <PrimaryButton disabled={busy || !!agentMissing} onClick={() => void actions.fix(project, task)}>Ask agent to fix</PrimaryButton>
        </span>
      </>
    )
  } else if (landing?.state === 'fixing') {
    title = `Fixing conflicts with ${streamName}…`
    detail = updating
      ? `The agent is resolving ${plural(files.length, 'file')}. The update finishes when it is done.`
      : `The agent is resolving ${plural(files.length, 'file')}. The landing goes on when it is done.`
    buttons = (
      <>
        <LinkBtn danger disabled={busy} onClick={() => void actions.abort(project, task)}>Abort</LinkBtn>
        <LinkBtn disabled={busy} onClick={() => void actions.retry(project, task)}>Retry</LinkBtn>
      </>
    )
  } else if (landing?.state === 'blocked') {
    alert = true
    title = files.length > 0
      ? `${streamName} has local changes in ${plural(files.length, 'file')} this landing touches`
      : `Couldn't land into ${streamName}`
    detail = files.length > 0
      ? `Commit or stash them in ${streamName}'s worktree, then Retry.`
      : <pre className="m-0 mt-1 max-h-24 overflow-auto text-xs font-mono text-text-muted whitespace-pre-wrap break-words">{landing.message}</pre>
    buttons = (
      <>
        <LinkBtn danger disabled={busy} onClick={() => void actions.abort(project, task)}>Abort</LinkBtn>
        <PrimaryButton disabled={busy} onClick={() => void actions.retry(project, task)}>Retry</PrimaryButton>
      </>
    )
  } else if (landing?.state === 'landing') {
    title = updating ? `Updating from ${streamName}…` : `Landing into ${streamName}…`
  } else if (op) {
    title = runningText(op, streamName)
  }

  return (
    <div
      role={alert ? 'alert' : 'status'}
      className="shrink-0 flex items-start gap-3 px-3 py-2 text-sm bg-surface-2 border-b-[0.5px] border-border"
      data-testid="task-landing-banner"
    >
      <div className="flex-1 min-w-0">
        {title && <div className={alert ? 'text-text font-medium' : 'text-text'}>{title}</div>}
        {detail && <div className="text-text-muted mt-0.5">{detail}</div>}
        {(landing?.state === 'conflict' || landing?.state === 'fixing' || landing?.state === 'blocked') && files.length > 0 && <FileList files={files} />}
        {notice && (
          <div className={`flex items-start gap-3 ${title ? 'mt-1' : ''}`}>
            <span className={`flex-1 min-w-0 whitespace-pre-wrap break-words ${notice.tone === 'error' ? 'text-danger' : 'text-text-muted'}`}>{notice.text}</span>
            <LinkBtn onClick={() => setLandingNotice(task.id, null)}>Dismiss</LinkBtn>
          </div>
        )}
      </div>
      {buttons && <div className="flex items-center gap-4 shrink-0">{buttons}</div>}
    </div>
  )
}
