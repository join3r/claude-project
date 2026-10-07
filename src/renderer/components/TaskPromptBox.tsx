import React, { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowUp } from 'lucide-react'
import { useApp } from '../context/AppContext'
import type { Project, PromptBoxAgent, TabType } from '../../shared/types'
import ChipMenu from './claude-chat/ChipMenu'
import { AttachmentStrip, toChatImages, useImageAttachments } from './claude-chat/imageAttachments'
import { AgentMenu, EFFORT_OPTIONS, MODEL_OPTIONS, MODE_OPTIONS, modeLabel, nextMode } from './promptChips'
import {
  PROMPT_BOX_AGENT_LABEL,
  agentTakesMode,
  availablePromptAgents,
  pickPromptAgent,
  setPendingPrompt,
  shouldNameTask,
  taskNameFromPrompt
} from './promptBox'
import { TERMINAL_TASK_NAME } from './newTask'

interface Props {
  project: Project
  taskId: string
  taskName: string
  projectDir: string
  visible: boolean
}

const linkCls = 'bg-transparent border-0 p-0 text-sm text-text-muted underline decoration-border-strong underline-offset-[3px] cursor-pointer hover:text-text'

/**
 * What an empty task shows: a box for the first prompt. Sending opens the chosen
 * agent's tab with the prompt already handed to it and names the task after it.
 * Without an agent to send to (none enabled, or a shell-command project) it falls
 * back to plain open-a-tab buttons.
 */
export default function TaskPromptBox({ project, taskId, taskName, projectDir, visible }: Props): React.ReactElement {
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
  // Only the chat view takes images; switching away hides them rather than dropping them.
  const takesImages = agent === 'claude-chat'
  const attachments = useImageAttachments(takesImages)
  const images = takesImages ? attachments.images : []

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

  // A terminal opened here makes this a terminal task, named "Terminal" until renamed.
  const openTab = (type: TabType): void => {
    addTab(project.id, taskId, 0, type)
    if (type === 'terminal' && shouldNameTask(taskName)) renameTask(project.id, taskId, TERMINAL_TASK_NAME)
  }

  if (!agent) {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-2 text-text-muted text-base">
        <span>Open a terminal or browser tab</span>
        <span className="flex gap-3">
          <button type="button" className={linkCls} onClick={() => openTab('terminal')}>Terminal</button>
          <button type="button" className={linkCls} onClick={() => openTab('browser')}>Browser</button>
        </span>
      </div>
    )
  }

  const takesMode = agentTakesMode(agent)
  const canSend = draft.trim().length > 0

  const send = (): void => {
    const text = draft.trim()
    if (!text) return
    const tab = addTab(project.id, taskId, 0, agent)
    setPendingPrompt(tab.id, {
      text,
      ...(takesMode && currentMode ? { mode: currentMode } : {}),
      ...(agent === 'claude-chat' && model ? { model } : {}),
      ...(agent === 'claude-chat' && effort ? { effort } : {}),
      ...(images.length > 0 ? { images: toChatImages(images) } : {})
    })
    if (shouldNameTask(taskName)) renameTask(project.id, taskId, taskNameFromPrompt(text))
    updateConfig({ promptBoxAgent: agent, ...(takesMode ? { promptBoxMode: currentMode } : {}) })
    setDraft('')
    attachments.clear()
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      send()
    } else if (e.key === 'Tab' && e.shiftKey && takesMode) {
      e.preventDefault()
      setMode(nextMode(currentMode))
    }
  }

  return (
    <div className="h-full overflow-y-auto flex items-center justify-center px-5 py-6">
      <div className="w-full max-w-[640px] flex flex-col gap-3">
        <div className="text-center select-none">
          <div className="text-md text-text">What should we work on?</div>
          <div className="text-sm text-text-subtle mt-0.5 font-mono truncate">{projectDir || project.ssh?.remoteDir || '~'}</div>
        </div>
        <div
          className="relative rounded-xl border-[0.5px] bg-field shadow-[0_1px_3px_rgba(0,0,0,0.12)] border-border-strong focus-within:border-border-focus transition-colors duration-(--motion-fast)"
          {...attachments.dropProps}
        >
          <AttachmentStrip images={images} onRemove={attachments.remove} />
          <textarea
            ref={textareaRef}
            rows={2}
            value={draft}
            aria-label="First prompt"
            placeholder={`Describe the task for ${PROMPT_BOX_AGENT_LABEL[agent]} — Enter to send, Shift+Enter for a new line`}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
            onPaste={attachments.onPaste}
            className="block w-full resize-none bg-transparent border-0 outline-none px-3 pt-2.5 pb-1 text-base text-text placeholder:text-text-subtle leading-[1.5] min-h-[58px] max-h-60"
          />
          <div className="flex items-center gap-0.5 px-1.5 pb-1.5 flex-wrap">
            <AgentMenu agents={agents} value={agent} onChange={pick(setPicked)} />
            {agent === 'claude-chat' && (
              <ChipMenu label={`Model: ${MODEL_OPTIONS.find((m) => m.value === model)?.label ?? model}`} title="Model" options={MODEL_OPTIONS} value={model} onChange={pick(setModel)} />
            )}
            {takesMode && (
              <ChipMenu label={`Mode: ${modeLabel(currentMode)}`} title="Permission mode (Shift+Tab cycles)" options={MODE_OPTIONS} value={currentMode} onChange={pick(setMode)} />
            )}
            {agent === 'claude-chat' && (
              <ChipMenu
                label={`Effort: ${effort || 'Default'}`}
                title="Thinking effort"
                options={EFFORT_OPTIONS}
                value={effort}
                onChange={pick(setEffort)}
              />
            )}
            <div className="flex-1" />
            <button
              type="button"
              title="Send (Enter)"
              aria-label="Send"
              disabled={!canSend}
              onClick={() => send()}
              className="w-6 h-6 inline-flex items-center justify-center rounded-md border-0 bg-accent text-accent-ink cursor-pointer hover:brightness-105 disabled:opacity-35 disabled:cursor-default"
            >
              <ArrowUp size={14} strokeWidth={2.5} />
            </button>
          </div>
        </div>
        <div className="text-center text-sm text-text-subtle">
          or open a{' '}
          <button type="button" className={linkCls} onClick={() => openTab('terminal')}>terminal</button>
          {' · '}
          <button type="button" className={linkCls} onClick={() => openTab('browser')}>browser</button>
        </div>
      </div>
    </div>
  )
}

