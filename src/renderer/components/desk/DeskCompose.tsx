import React, { useEffect, useMemo, useRef, useState } from 'react'
import type { AppConfig, DeskScope, Project, PromptBoxAgent } from '../../../shared/types'
import ProjectTileBadge from '../ProjectTileBadge'
import { PROMPT_BOX_AGENT_LABEL } from '../promptBox'
import type { NewTaskSubmission } from '../newTask'
import { useMenuPosition, type MenuAnchor } from '../../hooks/useMenuPosition'
import { formatShortcutForApp } from '../../../shared/shortcut-label'
import { composeTarget } from './deskInbox'
import { deskEvents } from './deskEvents'
import { AUTOPILOT_OFF, autopilotAvailable, deskAgents, deskSubmission, readLastProject, writeLastProject, type DeskAutopilot } from './deskStart'
import AutopilotChips from './AutopilotChips'
import { paletteEvents } from '../../palette/paletteEvents'

const chipCls = 'flex items-center gap-1.5 bg-surface-3 border border-border rounded-full px-2.5 py-[3px] text-sm text-body cursor-pointer hover:border-border-strong max-w-[60%] min-w-0'

/**
 * The desk's compose box: "Ask or give a task…", a where chip (project › stream)
 * and an agent chip. ↵ fires the task into the chosen stream and leaves you
 * here; ⇧↵ is a new line. It aims at the column's scope unless a chip says
 * otherwise. Agent tasks start in auto mode (decision 2 of the redesign); the
 * Autopilot chip (off again after every fire) lets main take one to Done.
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
  const [autopilot, setAutopilot] = useState<DeskAutopilot>(AUTOPILOT_OFF)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => { setOverride(null) }, [scope?.projectId, scope?.streamId])

  useEffect(() => deskEvents.onFocusCompose((where) => {
    if (where) setOverride(where)
    inputRef.current?.focus()
  }), [])

  // Options… keeps the text until the form files it: closing the form must not lose what you typed.
  useEffect(() => deskEvents.onClearCompose(() => { setText(''); setOverride(null) }), [])

  const target = useMemo(
    () => composeTarget(projects, override ?? scope, readLastProject()),
    [projects, override, scope]
  )
  // Claude chat first: it is the agent the desk is built around.
  const { agents, agent } = deskAgents(config, target?.project, agentOverride)

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
    onCompose(deskSubmission(target.project, target.stream, agent, prompt, autopilot))
    setText('')
    setOverride(null)
    setAutopilot(AUTOPILOT_OFF)
  }

  const whereLabel = target
    ? (target.stream && !target.stream.isMain ? `${target.project.name} › ${target.stream.name}` : target.project.name)
    : 'No project yet'

  return (
    <div className="border border-line bg-row-hover rounded-[10px] px-3 py-2.5 flex flex-col gap-2 focus-within:border-border-strong" data-testid="desk-compose">
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
        {autopilotAvailable(target?.project, agent) && <AutopilotChips value={autopilot} onChange={setAutopilot} />}
        <span className="flex-1" />
        <button
          type="button"
          className="px-1.5 py-px rounded-md border-0 bg-transparent text-xs text-text-muted cursor-pointer hover:text-text hover:bg-surface-3 whitespace-nowrap"
          title="The full form: model, permission mode, effort, pictures, a terminal task, any folder"
          onClick={() => {
            paletteEvents.emit('open-new-task-form', {
              ...(target ? { projectId: target.project.id, ...(target.stream ? { streamId: target.stream.id } : {}) } : {}),
              prompt: text
            })
          }}
          data-testid="desk-compose-options"
        >Options…</button>
        <span className="font-mono text-xs text-text-muted whitespace-nowrap">↵ fire</span>
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
