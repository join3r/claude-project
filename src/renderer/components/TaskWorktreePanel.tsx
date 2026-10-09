import React, { useState } from 'react'
import type { TaskWorktreeState, WorktreeSetupDecision } from '../../shared/types'
import { serverName, useServersState } from '../serversState'
import { LinkBtn, PrimaryButton } from './ui'

/** Lines of setup output shown under "Preparing worktree…". */
const LOG_LINES = 12

/**
 * The commands a repo's `.devtool/worktree.json` wants to run in a new
 * worktree, exactly as written there, for the user to approve. A DevTool
 * server's project runs them on that server, which keeps the approval: the
 * prompt names it.
 */
export function SetupCommands({ commands, serverId }: { commands: string[]; serverId?: string }): React.ReactElement {
  const servers = useServersState()
  const where = serverId ? serverName(serverId, servers) : null
  return (
    <div className="flex flex-col gap-1.5 text-left">
      <div className="text-sm text-text-muted">
        This repository&apos;s <span className="font-mono">.devtool/worktree.json</span> runs these commands in the new worktree
        {where ? <> on <span className="text-text">{where}</span></> : null}:
      </div>
      <pre className="m-0 max-h-48 overflow-auto rounded-md bg-surface-2 border-[0.5px] border-border px-2.5 py-2 text-sm font-mono text-text whitespace-pre-wrap break-all">
        {commands.join('\n')}
      </pre>
      <div className="text-sm text-text-subtle">
        Running them approves this exact file for the repository{where ? ` on ${where}` : ''}. If it changes, you are asked again.
      </div>
    </div>
  )
}

interface Props {
  /** Undefined while the request is on its way to main. */
  state: TaskWorktreeState | undefined
  /** The task is closing and its worktree is gone already. */
  closing?: boolean
  /** The DevTool server the task's project is on, which makes the worktree and runs its setup. */
  serverId?: string
  onDecide: (decision: WorktreeSetupDecision) => Promise<unknown>
  onRetry: () => void
}

/**
 * What a task's tab area shows while its own worktree is being made: progress
 * with the tail of the setup output, the setup approval, or why git refused.
 */
export default function TaskWorktreePanel({ state, closing, serverId, onDecide, onRetry }: Props): React.ReactElement {
  const [deciding, setDeciding] = useState(false)
  const decide = (decision: WorktreeSetupDecision): void => {
    setDeciding(true)
    void onDecide(decision)
      // The answer never arrived (a server that went away): ask again.
      .catch((err: unknown) => window.alert(`Couldn't send the answer: ${err instanceof Error ? err.message : String(err)}`))
      .finally(() => setDeciding(false))
  }

  let body: React.ReactNode
  if (closing) {
    body = <div className="text-md text-text" role="status">Closing…</div>
  } else if (state?.phase === 'needs-approval') {
    body = (
      <>
        <div className="text-md text-text">Run the worktree setup?</div>
        <div className="text-sm text-text-subtle font-mono truncate">{state.branch}</div>
        <SetupCommands commands={state.pending.commands} serverId={serverId} />
        <div className="flex items-center justify-end gap-4">
          <LinkBtn onClick={() => decide('skip')} disabled={deciding}>Skip this time</LinkBtn>
          <PrimaryButton onClick={() => decide('run')} disabled={deciding}>Run setup</PrimaryButton>
        </div>
      </>
    )
  } else if (state?.phase === 'failed') {
    body = (
      <>
        <div className="text-md text-text">Couldn&apos;t create the task&apos;s worktree</div>
        <pre role="alert" className="m-0 max-h-48 overflow-auto text-sm font-mono text-danger whitespace-pre-wrap break-words">{state.error}</pre>
        <div className="flex justify-end">
          <PrimaryButton onClick={onRetry}>Retry</PrimaryButton>
        </div>
      </>
    )
  } else {
    const branch = state && 'branch' in state ? state.branch : undefined
    const log = state && 'log' in state && state.log ? state.log.trimEnd().split('\n').slice(-LOG_LINES).join('\n') : ''
    body = (
      <>
        <div className="text-md text-text" role="status">{state?.phase === 'setup' ? 'Running worktree setup…' : 'Preparing worktree…'}</div>
        {branch && <div className="text-sm text-text-subtle font-mono truncate">{branch}</div>}
        {log && (
          <pre className="m-0 max-h-60 overflow-hidden rounded-md bg-surface-2 border-[0.5px] border-border px-2.5 py-2 text-xs font-mono text-text-muted whitespace-pre-wrap break-all">{log}</pre>
        )}
      </>
    )
  }

  return (
    <div className="h-full overflow-y-auto flex items-center justify-center px-5 py-6 bg-surface" data-testid="task-worktree-panel">
      <div className="w-full max-w-[560px] flex flex-col gap-3">{body}</div>
    </div>
  )
}
