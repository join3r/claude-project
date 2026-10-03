import React, { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowUp, GitBranch } from 'lucide-react'
import { useApp } from '../context/AppContext'
import { CHAT_PERMISSION_MODES } from '../../shared/claude-chat'
import type { Project, PromptBoxAgent, TabType, WorkspaceDraft } from '../../shared/types'
import ChipMenu from './claude-chat/ChipMenu'
import { MODE_HELP } from './claude-chat/Composer'
import {
  PROMPT_BOX_AGENT_LABEL,
  agentTakesMode,
  availablePromptAgents,
  pickPromptAgent,
  setPendingPrompt,
  shouldNameTask,
  taskNameFromPrompt
} from './promptBox'
import { usePendingWorkspace, type PendingWorkspace } from './usePendingWorkspace'

interface Props {
  project: Project
  taskId: string
  taskName: string
  /** Set on a task from + Workspace whose worktree is made when the first tab opens. */
  workspaceDraft?: WorkspaceDraft
  projectDir: string
  visible: boolean
}

// Models aren't known until a session runs (`supportedModels()`), so the box offers
// the aliases every Claude Code version accepts.
const MODEL_OPTIONS = [
  { value: '', label: 'Default' },
  { value: 'opus', label: 'Opus' },
  { value: 'sonnet', label: 'Sonnet' },
  { value: 'haiku', label: 'Haiku' }
]
const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max']
const MODE_OPTIONS = [
  { value: '', label: 'Default', description: 'Whatever your Claude settings choose' },
  ...CHAT_PERMISSION_MODES.map((m) => ({ value: m.value, label: m.label, description: MODE_HELP[m.value] }))
]
const MODE_CYCLE = ['', 'default', 'acceptEdits', 'plan', 'auto']

const linkCls = 'bg-transparent border-0 p-0 text-sm text-text-muted underline decoration-border-strong underline-offset-[3px] cursor-pointer hover:text-text'

/**
 * What an empty task shows: a box for the first prompt. Sending opens the chosen
 * agent's tab with the prompt already handed to it and names the task after it.
 * Without an agent to send to (none enabled, or a shell-command project) it falls
 * back to plain open-a-tab buttons.
 */
export default function TaskPromptBox({ project, taskId, taskName, workspaceDraft, projectDir, visible }: Props): React.ReactElement {
  const { config, addTab, renameTask, updateConfig } = useApp()
  const agents = useMemo(() => (config ? availablePromptAgents(config, project) : []), [config, project])
  const [picked, setPicked] = useState<PromptBoxAgent | null>(null)
  const agent = pickPromptAgent(picked ?? config?.promptBoxAgent, agents)
  const [mode, setMode] = useState<string | null>(null)
  const currentMode = mode ?? config?.promptBoxMode ?? ''
  const [model, setModel] = useState('')
  const [effort, setEffort] = useState('')
  const [draft, setDraft] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const workspace = usePendingWorkspace(project, taskId, workspaceDraft)
  const busy = workspace.creating !== null

  // Landing on an empty task (+ Task, Cmd+N, switching to it) puts the caret here.
  useEffect(() => {
    if (!visible) return
    const frame = requestAnimationFrame(() => textareaRef.current?.focus())
    return () => cancelAnimationFrame(frame)
  }, [visible])

  // Grow with the text, up to a cap.
  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`
  }, [draft])

  // After a pick from one of the chips, typing carries on in the box.
  const refocus = (): void => { requestAnimationFrame(() => textareaRef.current?.focus()) }
  const pick = <T,>(set: (value: T) => void) => (value: T): void => { set(value); refocus() }

  // A pending workspace gets its worktree first, so nothing opens in the main checkout.
  // Without a prompt to go by, the branch is named after the task.
  const openTab = async (type: TabType): Promise<void> => {
    if (!(await workspace.ensure(taskName))) return
    addTab(project.id, taskId, 'left', type)
  }

  if (!agent) {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-2 text-text-muted text-base">
        <span>Open a terminal or browser tab</span>
        {workspace.pending && <BranchChip workspace={workspace} onPicked={refocus} />}
        <span className="flex gap-3">
          <button type="button" disabled={busy} className={linkCls} onClick={() => void openTab('terminal')}>Terminal</button>
          <button type="button" disabled={busy} className={linkCls} onClick={() => void openTab('browser')}>Browser</button>
        </span>
        <WorkspaceStatus workspace={workspace} />
      </div>
    )
  }

  const takesMode = agentTakesMode(agent)
  const canSend = draft.trim().length > 0

  const send = async (): Promise<void> => {
    const text = draft.trim()
    if (!text || busy) return
    if (!(await workspace.ensure(text))) return
    const tab = addTab(project.id, taskId, 'left', agent)
    setPendingPrompt(tab.id, {
      text,
      ...(takesMode && currentMode ? { mode: currentMode } : {}),
      ...(agent === 'claude-chat' && model ? { model } : {}),
      ...(agent === 'claude-chat' && effort ? { effort } : {})
    })
    if (shouldNameTask(taskName)) renameTask(project.id, taskId, taskNameFromPrompt(text))
    updateConfig({ promptBoxAgent: agent, ...(takesMode ? { promptBoxMode: currentMode } : {}) })
    setDraft('')
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      void send()
    } else if (e.key === 'Tab' && e.shiftKey && takesMode) {
      e.preventDefault()
      const index = MODE_CYCLE.indexOf(currentMode)
      setMode(MODE_CYCLE[(index + 1) % MODE_CYCLE.length])
    }
  }

  const modeLabel = MODE_OPTIONS.find((m) => m.value === currentMode)?.label ?? 'Default'

  return (
    <div className="h-full overflow-y-auto flex items-center justify-center px-5 py-6">
      <div className="w-full max-w-[640px] flex flex-col gap-3">
        <div className="text-center select-none">
          <div className="text-md text-text">What should we work on?</div>
          <div className="text-sm text-text-subtle mt-0.5 font-mono truncate">{projectDir || project.ssh?.remoteDir || '~'}</div>
        </div>
        <div className="relative rounded-xl border-[0.5px] bg-field shadow-[0_1px_3px_rgba(0,0,0,0.12)] border-border-strong focus-within:border-border-focus transition-colors duration-(--motion-fast)">
          <textarea
            ref={textareaRef}
            rows={2}
            value={draft}
            readOnly={busy}
            aria-label="First prompt"
            placeholder={`Describe the task for ${PROMPT_BOX_AGENT_LABEL[agent]} — Enter to send, Shift+Enter for a new line`}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
            className="block w-full resize-none bg-transparent border-0 outline-none px-3 pt-2.5 pb-1 text-base text-text placeholder:text-text-subtle leading-[1.5] min-h-[58px] max-h-60"
          />
          <div className="flex items-center gap-0.5 px-1.5 pb-1.5 flex-wrap">
            <AgentMenu agents={agents} value={agent} onChange={pick(setPicked)} />
            {agent === 'claude-chat' && (
              <ChipMenu label={`Model: ${MODEL_OPTIONS.find((m) => m.value === model)?.label ?? model}`} title="Model" options={MODEL_OPTIONS} value={model} onChange={pick(setModel)} />
            )}
            {takesMode && (
              <ChipMenu label={`Mode: ${modeLabel}`} title="Permission mode (Shift+Tab cycles)" options={MODE_OPTIONS} value={currentMode} onChange={pick(setMode)} />
            )}
            {agent === 'claude-chat' && (
              <ChipMenu
                label={`Effort: ${effort || 'Default'}`}
                title="Thinking effort"
                options={[{ value: '', label: 'Default' }, ...EFFORT_LEVELS.map((level) => ({ value: level, label: level }))]}
                value={effort}
                onChange={pick(setEffort)}
              />
            )}
            {workspace.pending && <BranchChip workspace={workspace} onPicked={refocus} />}
            <div className="flex-1" />
            <button
              type="button"
              title="Send (Enter)"
              aria-label="Send"
              disabled={!canSend || busy}
              onClick={() => void send()}
              className="w-6 h-6 inline-flex items-center justify-center rounded-md border-0 bg-accent text-accent-ink cursor-pointer hover:brightness-105 disabled:opacity-35 disabled:cursor-default"
            >
              <ArrowUp size={14} strokeWidth={2.5} />
            </button>
          </div>
        </div>
        {busy || workspace.error ? (
          <WorkspaceStatus workspace={workspace} />
        ) : (
          <div className="text-center text-sm text-text-subtle">
            or open a{' '}
            <button type="button" className={linkCls} onClick={() => void openTab('terminal')}>terminal</button>
            {' · '}
            <button type="button" className={linkCls} onClick={() => void openTab('browser')}>browser</button>
          </div>
        )}
      </div>
    </div>
  )
}

/** The agent chip: like ChipMenu, but it stands out, since it decides what Enter starts. */
function AgentMenu({ agents, value, onChange }: { agents: PromptBoxAgent[]; value: PromptBoxAgent; onChange: (agent: PromptBoxAgent) => void }): React.ReactElement {
  if (agents.length === 1) {
    return <span className="inline-flex items-center h-5 px-1.5 rounded-md bg-surface-3 text-xs text-text">{PROMPT_BOX_AGENT_LABEL[value]}</span>
  }
  return (
    <div className="[&>div>button]:bg-surface-3 [&>div>button]:text-text">
      <ChipMenu
        label={PROMPT_BOX_AGENT_LABEL[value]}
        title="Agent"
        options={agents.map((a) => ({ value: a, label: PROMPT_BOX_AGENT_LABEL[a], description: a === 'claude-chat' ? 'Chat view' : a === 'claude' ? 'Terminal view' : undefined }))}
        value={value}
        onChange={(next) => onChange(next as PromptBoxAgent)}
      />
    </div>
  )
}

const DROP_WORKSPACE = '\u0000plain'

/** Which branch the worktree will fork from, or drop the workspace altogether. */
function BranchChip({ workspace, onPicked }: { workspace: PendingWorkspace; onPicked: () => void }): React.ReactElement {
  const base = workspace.baseBranch || '…'
  return (
    <span className="inline-flex items-center text-text-muted">
      <GitBranch size={11} className="ml-1 -mr-0.5 shrink-0" aria-hidden />
      <ChipMenu
        label={`New branch from ${base}`}
        title="Workspace: a new branch and worktree, created when the first tab opens"
        disabled={workspace.creating !== null}
        options={[
          ...workspace.branches.map((branch) => ({ value: branch, label: branch })),
          { value: DROP_WORKSPACE, label: 'Don’t isolate', description: 'Make this a plain task in the project folder' }
        ]}
        value={workspace.baseBranch}
        onChange={(value) => {
          if (value === DROP_WORKSPACE) workspace.dropWorkspace()
          else workspace.setBaseBranch(value)
          onPicked()
        }}
      />
    </span>
  )
}

/** Worktree creation in progress, or why it failed. */
function WorkspaceStatus({ workspace }: { workspace: PendingWorkspace }): React.ReactElement | null {
  if (workspace.creating) {
    return <div className="text-center text-sm text-text-subtle">Creating worktree <span className="font-mono">{workspace.creating}</span>…</div>
  }
  if (workspace.error) {
    return (
      <div role="alert" className="text-center text-sm text-danger">
        {workspace.error}{' '}
        <button type="button" className={linkCls} onClick={workspace.dropWorkspace}>Use the project folder instead</button>
      </div>
    )
  }
  return null
}
