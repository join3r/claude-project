import React, { useEffect, useMemo, useRef, useState } from 'react'
import type { AppConfig, DeskScope, Project, PromptBoxAgent } from '../../../shared/types'
import ProjectTileBadge from '../ProjectTileBadge'
import { PROMPT_BOX_AGENT_LABEL, availablePromptAgents, pickPromptAgent } from '../promptBox'
import type { NewTaskSubmission } from '../newTask'
import { useMenuPosition, type MenuAnchor } from '../../hooks/useMenuPosition'
import { formatShortcutForApp } from '../../../shared/shortcut-label'
import { composeTarget } from './deskInbox'
import { deskEvents } from './deskEvents'

const LAST_PROJECT_KEY = 'devtool.desk.lastProjectId'

function readLastProject(): string | null {
  try { return window.localStorage.getItem(LAST_PROJECT_KEY) } catch { return null }
}

function writeLastProject(id: string): void {
  try { window.localStorage.setItem(LAST_PROJECT_KEY, id) } catch { /* storage blocked: the default just falls back */ }
}

const chipCls = 'flex items-center gap-1.5 bg-surface-3 border border-border rounded-full px-2.5 py-[3px] text-sm text-[#d6d6d8] cursor-pointer hover:border-border-strong max-w-[60%] min-w-0'

/**
 * The desk's compose box: "Ask or give a task…", a where chip (project › stream)
 * and an agent chip. ↵ fires the task into the chosen stream and leaves you
 * here; ⇧↵ is a new line. It aims at the column's scope unless a chip says
 * otherwise. Agent tasks start in auto mode (decision 2 of the redesign).
 */
export default function DeskCompose({ projects, scope, config, theme, onCompose }: {
  projects: readonly Project[]
  scope: DeskScope | null
  config: AppConfig
  theme: 'dark' | 'light'
  onCompose: (submission: NewTaskSubmission) => void
}): React.ReactElement {
  const [text, setText] = useState('')
  // A chip's pick overrides the scope until the next fire or scope change.
  const [override, setOverride] = useState<DeskScope | null>(null)
  const [whereMenu, setWhereMenu] = useState<MenuAnchor | null>(null)
  const [agentOverride, setAgentOverride] = useState<PromptBoxAgent | null>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => { setOverride(null) }, [scope?.projectId, scope?.streamId])

  useEffect(() => deskEvents.onFocusCompose((where) => {
    if (where) setOverride(where)
    inputRef.current?.focus()
  }), [])

  const target = useMemo(
    () => composeTarget(projects, override ?? scope, readLastProject()),
    [projects, override, scope]
  )
  const agents = target ? availablePromptAgents(config, target.project) : []
  // Claude chat first: it is the agent the desk is built around.
  const agent = (agentOverride && agents.includes(agentOverride) ? agentOverride : null)
    ?? (agents.includes('claude-chat') ? 'claude-chat' : pickPromptAgent(config.promptBoxAgent, agents))

  useEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`
  }, [text])

  const fire = (): void => {
    const prompt = text.trim()
    if (!prompt || !target) return
    writeLastProject(target.project.id)
    onCompose({
      target: { kind: 'project', projectId: target.project.id },
      ...(target.stream ? { streamId: target.stream.id } : {}),
      ...(agent
        ? { start: { agent, prompt: { text: prompt, ...(agent === 'claude-chat' || agent === 'claude' ? { mode: 'auto' } : {}) } } }
        : { terminal: { command: prompt } })
    })
    setText('')
    setOverride(null)
  }

  const whereLabel = target
    ? (target.stream && !target.stream.isMain ? `${target.project.name} › ${target.stream.name}` : target.project.name)
    : 'No project yet'

  return (
    <div className="border border-[#2f3237] bg-[#1a1b1f] rounded-[10px] px-3 py-2.5 flex flex-col gap-2 focus-within:border-border-strong" data-testid="desk-compose">
      <textarea
        ref={inputRef}
        rows={1}
        aria-label="New task"
        placeholder={`Ask or give a task…   ${formatShortcutForApp('CmdOrCtrl+N')}`}
        className="bg-transparent border-0 outline-none text-text text-md resize-none leading-snug placeholder:text-text-muted"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); fire() }
          if (e.key === 'Escape') { e.currentTarget.blur() }
        }}
        data-testid="desk-compose-input"
      />
      <div className="flex gap-1.5 items-center">
        <button
          type="button"
          className={chipCls}
          onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setWhereMenu({ x: r.left, y: r.bottom + 4 }) }}
          title="Where the task goes"
          data-testid="desk-compose-where"
        >
          {target && <ProjectTileBadge project={target.project} theme={theme} size={14} />}
          <span className="overflow-hidden text-ellipsis whitespace-nowrap">{whereLabel}</span>
        </button>
        {agents.length > 1 ? (
          <button
            type="button"
            className={chipCls}
            title="Agent (click to switch)"
            onClick={() => {
              const index = agent ? agents.indexOf(agent) : -1
              setAgentOverride(agents[(index + 1) % agents.length])
            }}
          >{agent ? PROMPT_BOX_AGENT_LABEL[agent] : 'Terminal'}</button>
        ) : (
          <span className={`${chipCls} cursor-default`}>{agent ? PROMPT_BOX_AGENT_LABEL[agent] : 'Terminal'}</span>
        )}
        <span className="flex-1" />
        <span className="font-mono text-xs text-text-muted">↵ fire</span>
      </div>
      <WhereMenu
        anchor={whereMenu}
        projects={projects}
        theme={theme}
        onPick={(where) => { setOverride(where); setWhereMenu(null); inputRef.current?.focus() }}
        onClose={() => setWhereMenu(null)}
      />
    </div>
  )
}

/** Projects, each with its non-main streams under it. */
function WhereMenu({ anchor, projects, theme, onPick, onClose }: {
  anchor: MenuAnchor | null
  projects: readonly Project[]
  theme: 'dark' | 'light'
  onPick: (where: DeskScope) => void
  onClose: () => void
}): React.ReactElement | null {
  const pos = useMenuPosition<HTMLDivElement>(anchor)
  useEffect(() => {
    if (!anchor) return
    const dismiss = (): void => onClose()
    window.addEventListener('mousedown', dismiss)
    return () => window.removeEventListener('mousedown', dismiss)
  }, [anchor, onClose])
  if (!anchor) return null
  return (
    <div
      ref={pos.ref}
      className="fixed z-(--z-menu) w-[260px] bg-surface-3 border border-border-strong rounded-[10px] p-1 shadow-[0_18px_40px_rgba(0,0,0,0.5)] overflow-y-auto"
      style={pos.style}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {projects.map(project => (
        <React.Fragment key={project.id}>
          <button type="button" className="flex w-full items-center gap-2 px-2.5 py-1.5 rounded-md bg-transparent border-0 text-base text-text cursor-pointer hover:bg-sel text-left" onClick={() => onPick({ projectId: project.id })}>
            <ProjectTileBadge project={project} theme={theme} size={16} />
            <span className="overflow-hidden text-ellipsis whitespace-nowrap">{project.name}</span>
          </button>
          {project.streams.filter(stream => !stream.isMain).map(stream => (
            <button key={stream.id} type="button" className="flex w-full items-center gap-2 pl-[34px] pr-2.5 py-1 rounded-md bg-transparent border-0 text-sm text-text-muted cursor-pointer hover:bg-sel hover:text-text text-left font-mono" onClick={() => onPick({ projectId: project.id, streamId: stream.id })}>
              › {stream.name}
            </button>
          ))}
        </React.Fragment>
      ))}
    </div>
  )
}
