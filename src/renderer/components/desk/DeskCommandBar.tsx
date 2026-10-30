import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { v4 as uuid } from 'uuid'
import type { Project, PromptBoxAgent, Task } from '../../../shared/types'
import { isEphemeralProject } from '../../../shared/types'
import { findTaskInProject, streamDirectory, taskDirectory } from '../../../shared/streams'
import { useApp } from '../../context/AppContext'
import { paletteEvents, setPaletteReturnFocus } from '../../palette/paletteEvents'
import { usePaletteHotkey } from '../../palette/usePaletteHotkey'
import { useFrecency } from '../../palette/useFrecency'
import { paletteCommandEntities, runPaletteCommand } from '../../palette/paletteCommands'
import { useAllStreamRuns, useDismissedStreamRunCrashes } from '../../streamRuns'
import { useAllTabStatuses } from '../../context/TabStatusContext'
import { useFileNewTask } from '../../hooks/useFileNewTask'
import { resolveLandingTaskId } from '../../hooks/taskNavigation'
import { showToast } from '../../toasts'
import { formatShortcutForApp } from '../../../shared/shortcut-label'
import { isNotebookFile } from '../../../shared/notebook'
import ProjectTileBadge from '../ProjectTileBadge'
import { PROMPT_BOX_AGENT_LABEL } from '../promptBox'
import { createTab } from '../newTaskTabs'
import { inboxApps } from '../inbox'
import { openBench } from './benchState'
import { openRunLog } from './DeskStatusBar'
import { AUTOPILOT_OFF, autopilotAvailable, busyInSameFolder, deskAgents, startsInOwnWorktree, deskSubmission, readLastProject, writeLastProject, type DeskAutopilot } from './deskStart'
import AutopilotChips from './AutopilotChips'
import {
  barSections, canQueue, completeToken, queuedPromptFor, resolveBar, targetLabel, targetStreamName,
  type BarHere, type BarItem, type BarSection, type BarTarget, type ResolvedBar
} from './commandBar'

const MAX_INPUT_HEIGHT = 160

/**
 * The desk's ⌘K bar (change 5 of the redesign; logic in `commandBar.ts`). One
 * input: plain words jump or start a task (↵), ⌘↵ queues them in the stream's
 * prompt queue instead, `@project` / `#stream` aim it, `>` runs a command, `/`
 * opens a file or note, `*` searches every project. Classic keeps the palette.
 */
export default function DeskCommandBar(): React.ReactElement | null {
  const actions = useApp()
  const {
    projects, projectOrder, notes, config, desk, updateDesk, selectedProjectId, selectedTaskId, effectiveTheme,
    switchToTask, selectProjectHome, updatePromptQueue, openOrFocusNoteTab, openOrFocusEditorTab, taskForTab
  } = actions
  const [open, setOpen] = useState(false)
  const [input, setInput] = useState('')
  const [selected, setSelected] = useState(0)
  const [agentOverride, setAgentOverride] = useState<PromptBoxAgent | null>(null)
  const [autopilot, setAutopilot] = useState<DeskAutopilot>(AUTOPILOT_OFF)
  const [files, setFiles] = useState<{ dir: string; list: string[] } | null>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const mirrorRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const returnFocus = useRef<HTMLElement | null>(null)
  const { frecency, record } = useFrecency()
  const fileNewTask = useFileNewTask()

  const toggle = useCallback(() => setOpen(o => !o), [])
  usePaletteHotkey(toggle)

  // The column's search button, ⌘P and Search All Projects open it with a prefix.
  useEffect(() => paletteEvents.on('palette-prefix-set', (prefix: string) => {
    setOpen(true)
    setInput(prev => prefix + (prev.startsWith(prefix) ? prev.slice(prefix.length) : prev))
  }), [])

  useEffect(() => {
    if (open) {
      const prev = document.activeElement
      returnFocus.current = prev instanceof HTMLElement ? prev : null
      setPaletteReturnFocus(returnFocus.current)
      setSelected(0)
      setAgentOverride(null)
      setAutopilot(AUTOPILOT_OFF)
      const t = window.setTimeout(() => {
        const el = inputRef.current
        if (!el) return
        el.focus()
        el.setSelectionRange(el.value.length, el.value.length)
      }, 0)
      return () => window.clearTimeout(t)
    }
    setInput('')
    const target = returnFocus.current
    if (target && document.body.contains(target)) {
      const t = window.setTimeout(() => target.focus(), 0)
      return () => window.clearTimeout(t)
    }
  }, [open])

  const composeProjects = useMemo(
    () => projectOrder.map(id => projects.find(p => p.id === id)).filter((p): p is Project => !!p && !isEphemeralProject(p)),
    [projectOrder, projects]
  )
  const projectIds = useMemo(() => projects.map(p => p.id), [projects])
  const runs = useAllStreamRuns(projectIds)
  const dismissed = useDismissedStreamRunCrashes()

  const here: BarHere = useMemo(
    () => ({ projectId: selectedProjectId, taskId: selectedTaskId, scope: desk.scope ?? null, lastProjectId: open ? readLastProject() : null }),
    [selectedProjectId, selectedTaskId, desk.scope, open]
  )
  const bar = useMemo(() => resolveBar(input, composeProjects, here), [input, composeProjects, here])

  // `/` lists the target's files: the open task's folder when it is in that project, else the stream's.
  const filesDir = useMemo(() => {
    if (!open || bar.mode !== 'files' || !bar.target) return null
    const { project, stream } = bar.target
    const task = project.id === selectedProjectId ? findTaskInProject(project, selectedTaskId) : undefined
    return { project, dir: task ? taskDirectory(project, task) : streamDirectory(project, stream) }
  }, [open, bar.mode, bar.target, selectedProjectId, selectedTaskId])
  useEffect(() => {
    if (!filesDir || files?.dir === filesDir.dir) return
    let cancelled = false
    const { project, dir } = filesDir
    window.api.chatListFiles(dir, project.id, project.ssh)
      .then(list => { if (!cancelled) setFiles({ dir, list }) })
      .catch(() => { if (!cancelled) setFiles({ dir, list: [] }) })
    return () => { cancelled = true }
  }, [filesDir, files?.dir])

  const sections = useMemo<BarSection[]>(() => {
    if (!open) return []
    return barSections(bar, {
      projects,
      composeProjects,
      apps: inboxApps(projects, runs, dismissed),
      commands: paletteCommandEntities(actions),
      notes,
      files: filesDir && files?.dir === filesDir.dir ? files.list : null
    }, here, frecency, Date.now())
  }, [open, bar, projects, composeProjects, runs, dismissed, actions, notes, filesDir, files, here, frecency])
  const flat = useMemo(() => sections.flatMap(section => section.items), [sections])

  useEffect(() => { setSelected(0) }, [input])
  useEffect(() => {
    listRef.current?.querySelector(`[data-bar-index="${selected}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [selected])

  const { agents, agent } = config && bar.target ? deskAgents(config, bar.target.project, agentOverride) : { agents: [], agent: null }
  const statuses = useAllTabStatuses()
  const busy = useMemo(
    () => (open && agent && bar.target ? busyInSameFolder(bar.target.project, bar.target.stream, (tabId) => statuses[tabId]) : []),
    [open, agent, bar.target, statuses]
  )

  // The input grows with the prompt; the mirror behind it (token colours) follows its scroll.
  useLayoutEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, MAX_INPUT_HEIGHT)}px`
    if (mirrorRef.current) mirrorRef.current.scrollTop = el.scrollTop
  }, [input, open])

  const close = (): void => setOpen(false)

  const startTask = (target: BarTarget, prompt: string): void => {
    writeLastProject(target.project.id)
    fileNewTask(deskSubmission(target.project, target.stream, agent, prompt, autopilot))
    close()
  }

  const queueTask = (target: BarTarget, prompt: string): void => {
    updatePromptQueue(target.project.id, { op: 'add', item: queuedPromptFor(target, uuid(), prompt) })
    showToast(`Queued in ${targetLabel(target)}`)
    close()
  }

  /** The task a file or note opened from here lands in, so its Bench can show it. */
  const landingTask = (projectId: string): string | null => {
    const project = projects.find(p => p.id === projectId)
    return projectId === selectedProjectId && findTaskInProject(project, selectedTaskId) ? selectedTaskId : resolveLandingTaskId(project)
  }

  const commit = (item: BarItem | undefined): void => {
    if (!item) return
    const prompt = bar.query.trim()
    if (item.kind === 'start') { if (prompt) startTask(item.target, prompt); return }
    if (item.kind === 'queue') { if (prompt) queueTask(item.target, prompt); return }
    if (item.kind === 'complete') {
      if (bar.completing) setInput(completeToken(input, bar.completing, item.sigil, item.value))
      inputRef.current?.focus()
      return
    }
    record(item.id)
    switch (item.kind) {
      case 'task': switchToTask(item.project.id, item.task.id); break
      case 'project':
        updateDesk({ scope: { projectId: item.project.id } })
        selectProjectHome(item.project.id)
        break
      case 'stream':
        updateDesk({ scope: { projectId: item.project.id, streamId: item.stream.id } })
        selectProjectHome(item.project.id)
        break
      case 'queued': selectProjectHome(item.project.id); break
      case 'app': openRunLog(item.app, { selectedProjectId, selectedTaskId, switchToTask }); break
      case 'command': runPaletteCommand(item.id, actions); break
      case 'note': {
        const taskId = landingTask(item.projectId)
        openOrFocusNoteTab(item.projectId, item.projectId === selectedProjectId ? selectedTaskId : null, 'focused', item.noteId)
        if (taskId) openBench(taskId, 'panes')
        break
      }
      case 'file': {
        const type = isNotebookFile(item.path) ? 'notebook' : 'editor'
        const name = item.path.split('/').pop() ?? item.path
        const taskId = taskForTab(item.projectId, item.projectId === selectedProjectId ? selectedTaskId : null, () => createTab(type, { filePath: item.path }), name)
        if (taskId) {
          openOrFocusEditorTab(item.projectId, taskId, 'focused', item.path)
          openBench(taskId, 'panes')
        }
        break
      }
    }
    close()
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.nativeEvent.isComposing) return
    if (e.key === 'Escape') { e.preventDefault(); close(); return }
    if (e.key === 'ArrowDown') { e.preventDefault(); setSelected(i => Math.min(i + 1, Math.max(0, flat.length - 1))); return }
    if (e.key === 'ArrowUp') { e.preventDefault(); setSelected(i => Math.max(0, i - 1)); return }
    if (e.key === 'Tab' && !e.shiftKey) {
      const pick = flat[selected]?.kind === 'complete' ? flat[selected] : flat.find(item => item.kind === 'complete')
      if (pick) { e.preventDefault(); commit(pick) }
      return
    }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      if (bar.mode === 'plain' && bar.query.trim() && bar.target && canQueue(bar.target)) queueTask(bar.target, bar.query.trim())
      return
    }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); commit(flat[selected]); return }
  }

  if (!open) return null

  let index = 0
  return createPortal(
    <div
      className="fixed inset-0 z-(--z-modal) bg-black/45 flex items-start justify-center pt-[12vh] px-4"
      data-modal
      onMouseDown={e => { if (e.target === e.currentTarget) close() }}
      data-testid="command-bar"
    >
      <div role="dialog" aria-label="Command bar" className="w-full max-w-[760px] bg-surface-2 text-text rounded-[14px] border border-line shadow-[0_30px_80px_rgba(0,0,0,0.6)] overflow-hidden flex flex-col max-h-[76vh]">
        <div className="px-[18px] py-4 flex flex-col gap-3 border-b border-hair">
          <div className="relative text-[16px] leading-[1.6]">
            <div ref={mirrorRef} aria-hidden className="absolute inset-0 overflow-hidden whitespace-pre-wrap break-words pointer-events-none text-text">
              <BarMirror input={input} bar={bar} />
            </div>
            <textarea
              ref={inputRef}
              rows={1}
              aria-label="Jump, run or start a task"
              placeholder="Jump to a task, or say what to do…"
              spellCheck={false}
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={onKeyDown}
              onScroll={e => { if (mirrorRef.current) mirrorRef.current.scrollTop = e.currentTarget.scrollTop }}
              className="relative block w-full bg-transparent border-0 outline-none resize-none p-0 text-[16px] leading-[1.6] text-transparent caret-text placeholder:text-text-muted whitespace-pre-wrap break-words"
              data-testid="command-bar-input"
            />
          </div>
          <div className="flex items-center gap-2 flex-wrap text-sm">
            {bar.target && (
              <button
                type="button"
                className="flex items-center gap-1.5 bg-surface-3 border border-border rounded-full px-2.5 py-[3px] text-body cursor-pointer hover:border-border-strong min-w-0"
                title="Where a task goes (type @ or # to change it)"
                onClick={() => { setInput(prev => (prev && !prev.endsWith(' ') ? `${prev} @` : `${prev}@`)); inputRef.current?.focus() }}
                data-testid="command-bar-where"
              >
                <ProjectTileBadge project={bar.target.project} theme={effectiveTheme} size={14} />
                <span className="truncate">{targetLabel(bar.target)}</span>
              </button>
            )}
            {agents.length > 1 ? (
              <button
                type="button"
                className="bg-surface-3 border border-border rounded-full px-2.5 py-[3px] text-body cursor-pointer hover:border-border-strong"
                title="Agent (click to switch)"
                onClick={() => {
                  const at = agent ? agents.indexOf(agent) : -1
                  setAgentOverride(agents[(at + 1) % agents.length])
                  inputRef.current?.focus()
                }}
              >{agentLabel(agent)}</button>
            ) : bar.target ? (
              <span className="bg-surface-3 border border-border rounded-full px-2.5 py-[3px] text-body">{agentLabel(agent)}</span>
            ) : null}
            {bar.mode === 'plain' && autopilotAvailable(bar.target?.project, agent) && (
              <AutopilotChips value={autopilot} onChange={(next) => { setAutopilot(next); inputRef.current?.focus() }} />
            )}
            {bar.allProjects && <span className="rounded-full px-2.5 py-[3px] border border-border text-text-muted">All projects</span>}
          </div>
        </div>

        <div ref={listRef} className="flex-1 min-h-0 overflow-y-auto py-1.5" data-testid="command-bar-list">
          {sections.length === 0 && (
            <div className="px-4 py-5 text-sm text-text-muted">{emptyText(bar, !!filesDir && files?.dir !== filesDir.dir)}</div>
          )}
          {sections.map(section => (
            <div key={section.key} data-testid={`command-bar-section-${section.key}`}>
              {section.label && <p className="m-0 px-4 pt-2.5 pb-1 text-xs font-semibold uppercase tracking-[0.07em] text-text-muted">{section.label}</p>}
              {section.items.map(item => {
                const at = index++
                return (
                  <BarRow
                    key={item.id}
                    item={item}
                    index={at}
                    selected={at === selected}
                    agent={agent}
                    busy={busy}
                    theme={effectiveTheme}
                    onHover={() => setSelected(at)}
                    onClick={() => commit(item)}
                  />
                )
              })}
            </div>
          ))}
        </div>

        <div className="flex gap-[18px] flex-wrap px-4 py-2.5 border-t border-hair text-xs text-text-muted">
          {([['@', 'project'], ['#', 'stream'], ['>', 'commands'], ['/', 'files and notes'], ['*', 'all projects']] as const).map(([sigil, label]) => (
            <button
              key={sigil}
              type="button"
              className="bg-transparent border-0 p-0 text-xs text-text-muted cursor-pointer hover:text-text"
              onClick={() => {
                setInput(prev => insertSigil(prev, sigil))
                inputRef.current?.focus()
              }}
            ><span className="font-mono text-text">{sigil}</span> {label}</button>
          ))}
          <span className="ml-auto">Plain words: jump, or start a task</span>
        </div>
      </div>
    </div>,
    document.body
  )
}

function agentLabel(agent: PromptBoxAgent | null): string {
  if (!agent) return 'Terminal'
  return agent === 'claude-chat' ? 'Claude · chat' : PROMPT_BOX_AGENT_LABEL[agent]
}

/** A footer sigil: `>` and `/` switch the mode at the front; `*` toggles; `@` and `#` start a token at the end. */
function insertSigil(input: string, sigil: '@' | '#' | '>' | '/' | '*'): string {
  if (sigil === '>' || sigil === '/') {
    const rest = input.replace(/^\s*[>/]/, '')
    return input.trimStart().startsWith(sigil) ? rest : sigil + rest
  }
  if (sigil === '*') {
    const parts = input.split(/(\s+)/)
    const at = parts.indexOf('*')
    if (at !== -1) return parts.filter((_, i) => i !== at).join('').replace(/\s{2,}/g, ' ')
  }
  return input && !/\s$/.test(input) ? `${input} ${sigil}` : `${input}${sigil}`
}

function emptyText(bar: ResolvedBar, loadingFiles: boolean): string {
  if (bar.mode === 'command') return 'No command matches.'
  if (bar.mode === 'files') return loadingFiles ? 'Loading files…' : 'No file or note matches.'
  if (bar.query) return 'Add a project first, then start a task.'
  return 'Type to jump to a task, project or stream, or say what to do.'
}

/** The input's text with its tokens coloured, laid out exactly like the textarea above it. */
function BarMirror({ input, bar }: { input: string; bar: ResolvedBar }): React.ReactElement {
  const marks: Array<{ start: number; end: number; cls: string; pad?: string }> = bar.tokens.map(token => (
    token.kind === 'project'
      ? { start: token.start, end: token.end, cls: 'text-answered', pad: '#1d2638' }
      : { start: token.start, end: token.end, cls: 'text-running', pad: '#16261d' }
  ))
  const lead = input.length - input.trimStart().length
  if (bar.mode !== 'plain') marks.push({ start: lead, end: lead + 1, cls: 'text-text-muted' })
  marks.sort((a, b) => a.start - b.start)
  const out: React.ReactNode[] = []
  let cursor = 0
  for (const mark of marks) {
    if (mark.start < cursor) continue
    if (mark.start > cursor) out.push(input.slice(cursor, mark.start))
    // box-shadow pads the token without moving the text under the caret.
    out.push(
      <span key={mark.start} className={`${mark.cls} rounded-[4px]`} style={mark.pad ? { background: mark.pad, boxShadow: `0 0 0 3px ${mark.pad}` } : undefined}>
        {input.slice(mark.start, mark.end)}
      </span>
    )
    cursor = mark.end
  }
  out.push(input.slice(cursor))
  // A trailing newline needs a character after it to take up its line.
  out.push('​')
  return <>{out}</>
}

const ROW = 'flex items-center gap-3 mx-1.5 px-2.5 rounded-lg text-base cursor-pointer'

function BarRow({ item, index, selected, agent, busy, theme, onHover, onClick }: {
  item: BarItem
  index: number
  selected: boolean
  agent: PromptBoxAgent | null
  /** Agents already working where a started task would go (see `busyInSameFolder`). */
  busy: readonly Task[]
  theme: 'dark' | 'light'
  onHover: () => void
  onClick: () => void
}): React.ReactElement {
  const bg = selected ? 'bg-row-sel' : ''
  const common = { 'data-bar-index': index, 'data-testid': `command-bar-item-${item.kind}`, onMouseMove: onHover, onClick }
  const kbd = (text: string): React.ReactElement => <span className="font-mono text-xs border border-line rounded px-1.5 py-px text-text-muted shrink-0">{text}</span>
  const where = (project: Project, streamName?: string, isMain?: boolean): string => (streamName && !isMain ? `${project.name} › ${streamName}` : project.name)

  switch (item.kind) {
    case 'start': {
      const { project, stream } = item.target
      const ownWorktree = startsInOwnWorktree(project, stream)
      const who = agent === 'claude-chat' || agent === 'claude' ? 'Claude' : agent ? PROMPT_BOX_AGENT_LABEL[agent] : 'A terminal'
      return (
        <div {...common} className={`${ROW} py-3 ${bg}`}>
          <ProjectTileBadge project={project} theme={theme} size={22} />
          <div className="flex-1 min-w-0 flex flex-col gap-0.5">
            <strong className="text-md text-text font-semibold truncate">Start task in {targetLabel(item.target)}</strong>
            <span className="text-sm text-text-muted truncate">
              {who} starts {ownWorktree ? 'in its own worktree' : stream?.workspace ? `in the ${stream.name} worktree` : 'in the project folder'}
              {busy.length > 0 && (
                <span className="text-warn" data-testid="command-bar-same-folder">
                  {' · '}{busy.length === 1 ? `"${busy[0].name}" is` : `${busy.length} agents are`} already working there
                </span>
              )}
            </span>
          </div>
          {kbd('↵')}
        </div>
      )
    }
    case 'queue':
      return (
        <div {...common} className={`${ROW} py-2 ${bg}`}>
          <span className="w-[22px] text-center text-text-muted">⇥</span>
          <span className="flex-1 truncate">Add to the <span className="font-mono">{targetStreamName(item.target)}</span> queue instead</span>
          {kbd(formatShortcutForApp('CmdOrCtrl+Enter').replace('Enter', '↵'))}
        </div>
      )
    case 'complete':
      return (
        <div {...common} className={`${ROW} py-2 ${bg}`}>
          <ProjectTileBadge project={item.project} theme={theme} size={18} />
          <span className="flex-1 truncate">
            <span className={`font-mono ${item.sigil === '@' ? 'text-answered' : 'text-running'}`}>{item.sigil}{item.value}</span>
            {item.stream && <span className="text-text-muted"> · {item.project.name}</span>}
          </span>
          {selected && kbd('⇥')}
        </div>
      )
    case 'task':
      return (
        <div {...common} className={`${ROW} py-2 ${bg}`}>
          <ProjectTileBadge project={item.project} theme={theme} size={18} />
          <span className="flex-1 min-w-0 truncate">{item.title}</span>
          <span className="text-sm text-text-muted truncate max-w-[40%]">{where(item.project, item.stream?.name, item.stream?.isMain)}</span>
        </div>
      )
    case 'project':
      return (
        <div {...common} className={`${ROW} py-2 ${bg}`}>
          <ProjectTileBadge project={item.project} theme={theme} size={18} />
          <span className="flex-1 min-w-0 truncate">{item.title}</span>
          <span className="text-sm text-text-muted">Project</span>
        </div>
      )
    case 'stream':
      return (
        <div {...common} className={`${ROW} py-2 ${bg}`}>
          <ProjectTileBadge project={item.project} theme={theme} size={18} />
          <span className="flex-1 min-w-0 truncate">{item.project.name} › <span className="font-mono">{item.title}</span></span>
          <span className="text-sm text-text-muted">Stream</span>
        </div>
      )
    case 'app':
      return (
        <div {...common} className={`${ROW} py-2 ${bg}`}>
          <span className={`size-[7px] mx-[7px] rounded-full shrink-0 ${item.app.crashed ? 'bg-crashed' : 'bg-running'}`} />
          <span className="flex-1 min-w-0 truncate">Open <span className="font-mono">{item.title}</span> logs · {where(item.app.project, item.app.stream.name, item.app.stream.isMain)}</span>
          <span className="text-sm text-text-muted">{item.app.crashed ? 'Crashed' : 'App'}</span>
        </div>
      )
    case 'queued':
      return (
        <div {...common} className={`${ROW} py-2 ${bg}`}>
          <span className="size-[7px] mx-[7px] rounded-full shrink-0 bg-status-exited" />
          <span className="flex-1 min-w-0 truncate">{item.title}</span>
          <span className="text-sm text-text-muted truncate max-w-[40%]">Queued · {item.stream?.name ?? 'main'}</span>
        </div>
      )
    case 'command':
      return (
        <div {...common} className={`${ROW} py-2 ${bg}`}>
          <span className="w-[22px] text-center font-mono text-sm text-text-muted">&gt;</span>
          <span className="flex-1 min-w-0 truncate">{item.title}</span>
          {item.shortcut && kbd(item.shortcut)}
        </div>
      )
    case 'note':
      return (
        <div {...common} className={`${ROW} py-2 ${bg}`}>
          <span className="w-[22px] text-center text-sm text-text-muted">✎</span>
          <span className="flex-1 min-w-0 truncate">{item.title}</span>
          <span className="text-sm text-text-muted truncate">{item.detail ?? 'Note'}</span>
        </div>
      )
    case 'file': {
      const slash = item.path.lastIndexOf('/')
      return (
        <div {...common} className={`${ROW} py-1.5 ${bg}`}>
          <span className="w-[22px] text-center font-mono text-sm text-text-muted">/</span>
          <span className="flex-1 min-w-0 truncate font-mono text-sm">
            {slash >= 0 && <span className="text-text-muted">{item.path.slice(0, slash + 1)}</span>}
            {item.path.slice(slash + 1)}
          </span>
        </div>
      )
    }
  }
}
