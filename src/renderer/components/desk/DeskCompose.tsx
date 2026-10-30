import React, { useEffect, useMemo, useRef, useState } from 'react'
import type { AppConfig, DeskScope, Project, PromptBoxAgent } from '../../../shared/types'
import ProjectTileBadge from '../ProjectTileBadge'
import { PROMPT_BOX_AGENT_LABEL } from '../promptBox'
import type { NewTaskSubmission } from '../newTask'
import { useMenuPosition, type MenuAnchor } from '../../hooks/useMenuPosition'
import { formatShortcutForApp } from '../../../shared/shortcut-label'
import { composeTarget } from './deskInbox'
import { deskEvents } from './deskEvents'
import { autopilotAvailable, deskAgents, deskSubmission, readLastProject, whereOptions, writeLastProject, type DeskAutopilot } from './deskStart'
import { paletteEvents } from '../../palette/paletteEvents'

const chipCls = 'flex items-center gap-1.5 bg-surface-3 border border-border rounded-full px-2.5 py-[3px] text-sm text-body cursor-pointer hover:border-border-strong min-w-0'

/**
 * The desk's compose box: "Ask or give a task…", a where chip (project › stream)
 * and an agent chip. Where comes first: ⌘N (and `@` in an empty box) opens the
 * where picker, type to narrow, ↵ picks and hands you to the prompt. ↵ fires
 * the task into the chosen stream and leaves you here; ⇧↵ is a new line. It
 * aims at the column's scope unless the picker says otherwise. Agent tasks
 * start in auto mode (decision 2 of the redesign); ⌘↵ fires one on Autopilot,
 * so main takes it to Done, and ⇧⌘↵ adds a Codex review.
 */
export default function DeskCompose({ projects, scope, config, theme, onCompose }: {
  projects: readonly Project[]
  scope: DeskScope | null
  config: AppConfig
  theme: 'dark' | 'light'
  onCompose: (submission: NewTaskSubmission) => void
}): React.ReactElement {
  const [text, setText] = useState('')
  // A picked where overrides the scope until the next fire or scope change.
  const [override, setOverride] = useState<DeskScope | null>(null)
  const [whereMenu, setWhereMenu] = useState<MenuAnchor | null>(null)
  const [agentOverride, setAgentOverride] = useState<PromptBoxAgent | null>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const whereRef = useRef<HTMLButtonElement>(null)

  useEffect(() => { setOverride(null) }, [scope?.projectId, scope?.streamId])

  const openWhere = (): void => {
    const r = whereRef.current?.getBoundingClientRect()
    if (r) setWhereMenu({ x: r.left, y: r.bottom + 4 })
  }

  // ⌘N with nowhere given starts on the picker; "New task in…" already said where.
  useEffect(() => deskEvents.onFocusCompose((where) => {
    if (where) {
      setOverride(where)
      inputRef.current?.focus()
    } else if (projects.length > 1) {
      openWhere()
    } else {
      inputRef.current?.focus()
    }
  }), [projects.length])

  // Options… keeps the text until the form files it: closing the form must not lose what you typed.
  useEffect(() => deskEvents.onClearCompose(() => { setText(''); setOverride(null) }), [])

  const target = useMemo(
    () => composeTarget(projects, override ?? scope, readLastProject()),
    [projects, override, scope]
  )
  // Claude chat first: it is the agent the desk is built around.
  const { agents, agent } = deskAgents(config, target?.project, agentOverride)
  const canAutopilot = autopilotAvailable(target?.project, agent)

  useEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`
  }, [text])

  const fire = (autopilot: DeskAutopilot | null): void => {
    const prompt = text.trim()
    if (!prompt || !target) return
    writeLastProject(target.project.id)
    onCompose(deskSubmission(target.project, target.stream, agent, prompt, autopilot))
    setText('')
    setOverride(null)
  }

  const whereLabel = target
    ? (target.stream && !target.stream.isMain ? `${target.project.name} › ${target.stream.name}` : target.project.name)
    : 'No project yet'

  return (
    <div className="@container border border-line bg-row-hover rounded-[10px] px-3 py-2.5 flex flex-col gap-2 focus-within:border-border-strong" data-testid="desk-compose">
      <textarea
        ref={inputRef}
        rows={1}
        aria-label="New task"
        placeholder={`Ask or give a task…   ${formatShortcutForApp('CmdOrCtrl+N')}`}
        title={canAutopilot ? '↵ starts the task · ⌘↵ on Autopilot · ⇧⌘↵ Autopilot with a Codex review · @ picks the project' : '↵ starts the task · @ picks the project'}
        className="bg-transparent border-0 outline-none text-text text-md resize-none leading-snug placeholder:text-text-muted"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault()
            fire(canAutopilot ? { on: true, review: e.shiftKey } : null)
          } else if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            fire(null)
          } else if (e.key === '@' && !text && projects.length > 1) {
            e.preventDefault()
            openWhere()
          } else if (e.key === 'Escape') {
            e.currentTarget.blur()
          }
        }}
        data-testid="desk-compose-input"
      />
      <div className="flex gap-1.5 items-center min-w-0">
        <button
          ref={whereRef}
          type="button"
          className={`${chipCls} shrink`}
          onClick={openWhere}
          title={`Where the task goes: ${whereLabel} (${formatShortcutForApp('CmdOrCtrl+N')} or @ to pick it from the keyboard)`}
          data-testid="desk-compose-where"
        >
          {target && <ProjectTileBadge project={target.project} theme={theme} size={14} />}
          <span className="overflow-hidden text-ellipsis whitespace-nowrap">{whereLabel}</span>
        </button>
        {agents.length > 1 ? (
          <button
            type="button"
            className={`${chipCls} shrink-0 whitespace-nowrap`}
            title="Agent (click to switch)"
            onClick={() => {
              const index = agent ? agents.indexOf(agent) : -1
              setAgentOverride(agents[(index + 1) % agents.length])
            }}
          >{agent ? PROMPT_BOX_AGENT_LABEL[agent] : 'Terminal'}</button>
        ) : (
          <span className={`${chipCls} shrink-0 whitespace-nowrap cursor-default`}>{agent ? PROMPT_BOX_AGENT_LABEL[agent] : 'Terminal'}</span>
        )}
        <span className="flex-1" />
        <button
          type="button"
          className="shrink-0 px-1.5 py-px rounded-md border-0 bg-transparent text-xs text-text-muted cursor-pointer hover:text-text hover:bg-surface-3 whitespace-nowrap"
          title="The full form: model, permission mode, effort, Autopilot, pictures, a terminal task, any folder"
          onClick={() => {
            paletteEvents.emit('open-new-task-form', {
              ...(target ? { projectId: target.project.id, ...(target.stream ? { streamId: target.stream.id } : {}) } : {}),
              prompt: text
            })
          }}
          data-testid="desk-compose-options"
        >Options…</button>
        {/* A narrow sidebar keeps the chips and drops the key hint (it is the textarea's tooltip too). */}
        <span className="hidden @[440px]:inline font-mono text-xs text-text-muted whitespace-nowrap">
          ↵ fire{canAutopilot && ' · ⌘↵ autopilot'}
        </span>
      </div>
      <WhereMenu
        anchor={whereMenu}
        projects={projects}
        current={target ? (target.stream && !target.stream.isMain ? `${target.project.id}:${target.stream.id}` : target.project.id) : null}
        theme={theme}
        onPick={(where) => { setOverride(where); setWhereMenu(null); inputRef.current?.focus() }}
        onClose={() => { setWhereMenu(null); inputRef.current?.focus() }}
        onDismiss={() => setWhereMenu(null)}
      />
    </div>
  )
}

/** Projects, each with its non-main streams under it; a filter field on top drives it from the keyboard. */
function WhereMenu({ anchor, projects, current, theme, onPick, onClose, onDismiss }: {
  anchor: MenuAnchor | null
  projects: readonly Project[]
  current: string | null
  theme: 'dark' | 'light'
  onPick: (where: DeskScope) => void
  /** Escape: back to the prompt. */
  onClose: () => void
  /** A click elsewhere: the click decides where focus goes. */
  onDismiss: () => void
}): React.ReactElement | null {
  const pos = useMenuPosition<HTMLDivElement>(anchor)
  const [filter, setFilter] = useState('')
  const [cursor, setCursor] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)
  const options = useMemo(() => whereOptions(projects, filter), [projects, filter])

  // Open on what the box already aims at, so ↵ alone keeps it.
  useEffect(() => {
    if (!anchor) return
    setFilter('')
    setCursor(Math.max(0, whereOptions(projects, '').findIndex(option => option.key === current)))
  }, [anchor])
  useEffect(() => { if (filter) setCursor(0) }, [filter])
  useEffect(() => {
    listRef.current?.querySelector(`[data-where-index="${cursor}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [cursor, options])

  useEffect(() => {
    if (!anchor) return
    window.addEventListener('mousedown', onDismiss)
    return () => window.removeEventListener('mousedown', onDismiss)
  }, [anchor, onDismiss])
  if (!anchor) return null

  const pick = (index: number): void => {
    const option = options[index]
    if (option) onPick(option.stream ? { projectId: option.project.id, streamId: option.stream.id } : { projectId: option.project.id })
  }

  return (
    <div
      ref={pos.ref}
      className="fixed z-(--z-menu) w-[260px] bg-surface-3 border border-border-strong rounded-[10px] p-1 shadow-[0_18px_40px_rgba(0,0,0,0.5)] flex flex-col"
      style={pos.style}
      onMouseDown={(e) => e.stopPropagation()}
      data-testid="desk-compose-where-menu"
    >
      <input
        autoFocus
        value={filter}
        placeholder="Project or stream…"
        aria-label="Where the task goes"
        className="mb-1 px-2.5 py-1.5 rounded-md bg-field border border-border text-base text-text outline-none placeholder:text-text-muted focus:border-border-focus"
        onChange={(e) => setFilter(e.target.value)}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return
          if (e.key === 'ArrowDown') { e.preventDefault(); setCursor(i => Math.min(i + 1, Math.max(0, options.length - 1))) }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setCursor(i => Math.max(0, i - 1)) }
          else if (e.key === 'Enter' || (e.key === 'Tab' && !e.shiftKey)) { e.preventDefault(); pick(cursor) }
          else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose() }
        }}
        data-testid="desk-compose-where-filter"
      />
      <div ref={listRef} className="overflow-y-auto min-h-0">
        {options.length === 0 && <div className="px-2.5 py-1.5 text-sm text-text-muted">No match</div>}
        {options.map((option, index) => {
          const sel = index === cursor ? 'bg-sel' : 'bg-transparent'
          return option.stream ? (
            <button key={option.key} type="button" data-where-index={index} className={`flex w-full items-center gap-2 pl-[34px] pr-2.5 py-1 rounded-md border-0 text-sm cursor-pointer hover:bg-sel hover:text-text text-left font-mono ${sel} ${index === cursor ? 'text-text' : 'text-text-muted'}`} onMouseMove={() => setCursor(index)} onClick={() => pick(index)}>
              <span className="overflow-hidden text-ellipsis whitespace-nowrap">{filter ? `${option.project.name} › ${option.stream.name}` : `› ${option.stream.name}`}</span>
            </button>
          ) : (
            <button key={option.key} type="button" data-where-index={index} className={`flex w-full items-center gap-2 px-2.5 py-1.5 rounded-md border-0 text-base text-text cursor-pointer hover:bg-sel text-left ${sel}`} onMouseMove={() => setCursor(index)} onClick={() => pick(index)}>
              <ProjectTileBadge project={option.project} theme={theme} size={16} />
              <span className="overflow-hidden text-ellipsis whitespace-nowrap">{option.project.name}</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}
