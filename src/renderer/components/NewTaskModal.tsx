import React, { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowUp, ChevronDown, GitBranch, Plus } from 'lucide-react'
import type { AppConfig, Project, PromptBoxAgent, Tag } from '../../shared/types'
import { dirBasename } from '../../shared/paths'
import { Field, HelperText, menuItemCls } from './ui'
import AddLocalProject from './AddLocalProject'
import ChipMenu from './claude-chat/ChipMenu'
import { AttachmentStrip, toChatImages, useImageAttachments } from './claude-chat/imageAttachments'
import { defaultBaseBranch, isNewTaskDraftValid, isPendingWorkspaceDraft, matchProjects } from './newTask'
import type { NewTaskSubmission, NewTaskTarget } from './newTask'
import { PROMPT_BOX_AGENT_LABEL, agentTakesMode, availablePromptAgents, pickPromptAgent, workspaceBranchName } from './promptBox'
import { AgentMenu, EFFORT_OPTIONS, MODEL_OPTIONS, MODE_OPTIONS, modeLabel, nextMode } from './promptChips'

interface Props {
  projects: Project[]
  /** Pre-selected project — the one you were last looking at. */
  defaultProjectId: string | null
  getProjectDir: (project: Project) => string
  /** Which agents are switched on, and the last agent and mode a prompt went to. */
  config: Pick<AppConfig, 'enableClaude' | 'enableCodex' | 'enablePi' | 'promptBoxAgent' | 'promptBoxMode'>
  allTags: readonly Tag[]
  onEnsureTag: (name: string) => string
  onAddProject: (name: string, directory: string, tagIds?: string[]) => Project
  onCreate: (submission: NewTaskSubmission) => void
  onClose: () => void
}

/** A row in the destination list: a real project, or the directory you just picked. */
interface TargetRow {
  key: string
  target: NewTaskTarget
  label: string
  /** Tooltip — the full path, which the label usually shortens away. */
  title: string
  /** Ad-hoc directories are marked, so "no project is being created" is visible. */
  adhoc: boolean
}

function sameTarget(a: NewTaskTarget | null, b: NewTaskTarget): boolean {
  if (!a || a.kind !== b.kind) return false
  return a.kind === 'project' && b.kind === 'project'
    ? a.projectId === b.projectId
    : a.kind === 'dir' && b.kind === 'dir' && a.directory === b.directory
}

const ATTEMPTS = 3

/**
 * Start a task the way you start an agent: say where, say what, send. The first
 * prompt names the task and opens the chosen agent on it; a workspace gets its
 * branch named after the prompt too. Sent empty, the task opens on its prompt box.
 *
 * The destination list holds exactly one highlighted row, and that row is what
 * gets created — there is no separate "cursor" that can drift away from the
 * selection while the filter hides the difference.
 */
export default function NewTaskModal({
  projects,
  defaultProjectId,
  getProjectDir,
  config,
  allTags,
  onEnsureTag,
  onAddProject,
  onCreate,
  onClose
}: Props): React.ReactElement {
  const [target, setTarget] = useState<NewTaskTarget | null>(() => {
    if (defaultProjectId && projects.some(p => p.id === defaultProjectId)) {
      return { kind: 'project', projectId: defaultProjectId }
    }
    return projects[0] ? { kind: 'project', projectId: projects[0].id } : null
  })
  const [prompt, setPrompt] = useState('')
  const [picked, setPicked] = useState<PromptBoxAgent | null>(null)
  const [mode, setMode] = useState(config.promptBoxMode ?? '')
  const [model, setModel] = useState('')
  const [effort, setEffort] = useState('')
  const [workspace, setWorkspace] = useState(false)
  const [branches, setBranches] = useState<string[]>([])
  const [branchesLoading, setBranchesLoading] = useState(false)
  const [baseBranch, setBaseBranch] = useState('')
  const [pickerOpen, setPickerOpen] = useState(false)
  const [projectFilter, setProjectFilter] = useState('')
  // The directory picked via "Use a directory…", if any. No project record exists
  // for it yet — one is minted only if this draft is actually created.
  const [pickedDir, setPickedDir] = useState<string | null>(null)
  const [newProjectOpen, setNewProjectOpen] = useState(false)
  // The branch git is cutting right now, or null.
  const [creating, setCreating] = useState<string | null>(null)
  const [cancelling, setCancelling] = useState(false)
  const [error, setError] = useState('')
  const projectListRef = useRef<HTMLDivElement>(null)
  const pickerRef = useRef<HTMLDivElement>(null)
  const promptRef = useRef<HTMLTextAreaElement>(null)
  // git has no abort once it starts cutting a worktree, so "cancel" means: ignore
  // whatever comes back, and undo it. Checked after every await, not just the first.
  const cancelledRef = useRef(false)
  const mountedRef = useRef(true)

  const project = useMemo(
    () => (target?.kind === 'project' ? projects.find(p => p.id === target.projectId) ?? null : null),
    [projects, target]
  )
  const filteredProjects = useMemo(() => matchProjects(projects, projectFilter), [projects, projectFilter])
  // The picked directory is pinned to the top and never filtered out: it is the
  // one row the filter box has nothing to say about.
  const rows = useMemo<TargetRow[]>(() => {
    const dirRow: TargetRow[] = pickedDir
      ? [{
          key: `dir:${pickedDir}`,
          target: { kind: 'dir', directory: pickedDir },
          label: dirBasename(pickedDir),
          title: pickedDir,
          adhoc: true
        }]
      : []
    return [
      ...dirRow,
      ...filteredProjects.map(p => ({
        key: p.id,
        target: { kind: 'project', projectId: p.id } as NewTaskTarget,
        label: p.name,
        title: p.name,
        adhoc: false
      }))
    ]
  }, [pickedDir, filteredProjects])
  const cursor = rows.findIndex(row => sameTarget(target, row.target))

  // Where the task will run, and what to call it. A directory target has no
  // project record behind it, so both come straight off the path.
  const targetDir = project ? getProjectDir(project) : pickedDir && target?.kind === 'dir' ? pickedDir : ''
  const targetLabel = project ? project.name : target?.kind === 'dir' ? dirBasename(target.directory) : ''
  // Shell-command projects have no directory to make a worktree in, and run no agents.
  const workspaceSupported = target?.kind === 'dir' || (!!project && !project.shellCommand)
  const workspaceOn = workspace && workspaceSupported
  const agents = useMemo(
    () => (target ? availablePromptAgents(config, project ?? {}) : []),
    [config, project, target]
  )
  const agent = pickPromptAgent(picked ?? config.promptBoxAgent, agents)
  const takesMode = !!agent && agentTakesMode(agent)
  // Without an agent to hand it to, there is no prompt — the task opens blank.
  const promptText = agent ? prompt.trim() : ''
  const busy = creating !== null
  // Only the chat view takes images; switching away hides them rather than dropping them.
  const takesImages = agent === 'claude-chat'
  const attachments = useImageAttachments(takesImages && !busy)
  const images = takesImages ? attachments.images : []
  // Images go with a prompt: one alone would name the task and branch after nothing.
  const imagesNeedPrompt = images.length > 0 && !promptText

  /** Point the composer somewhere else, dropping everything the old target loaded. */
  const selectTarget = (next: NewTaskTarget): void => {
    setTarget(next)
    // Another repo means other branches.
    setBranches([])
    setBaseBranch('')
    setError('')
  }

  // Keep the selection inside the visible list: if the filter hides whatever was
  // picked, the top match takes over. Without this the highlighted row and the
  // row that actually gets created can drift apart.
  useEffect(() => {
    if (rows.length === 0) return
    if (rows.some(row => sameTarget(target, row.target))) return
    // A project the composer just created can be selected a beat before the
    // parent hands it back down. That is a pending selection, not a filtered-out
    // one, and stealing it back to the top match would undo the add.
    if (target?.kind === 'project' && !projects.some(p => p.id === target.projectId)) return
    selectTarget(rows[0].target)
  }, [rows, projects])

  // Follow the selection — this also brings it into view when the picker opens.
  useEffect(() => {
    if (cursor < 0 || !pickerOpen) return
    const row = projectListRef.current?.children[cursor] as HTMLElement | undefined
    row?.scrollIntoView({ block: 'nearest' })
  }, [cursor, pickerOpen])

  // However the dialog goes away — Escape, backdrop, or the parent dropping it —
  // it takes any request it started with it.
  useEffect(() => {
    cancelledRef.current = false
    mountedRef.current = true
    return () => {
      cancelledRef.current = true
      mountedRef.current = false
    }
  }, [])

  // Grow with the text, up to a cap.
  useEffect(() => {
    const el = promptRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`
  }, [prompt])

  const focusPrompt = (): void => { requestAnimationFrame(() => promptRef.current?.focus()) }

  /** Give up on the dialog, and on anything it has in flight. */
  const requestClose = (): void => {
    // First press while git is working stays up to say so; a second one bails out
    // and lets the unwind finish on its own.
    if (busy && !cancelling) {
      cancelledRef.current = true
      setCancelling(true)
      setError('')
      return
    }
    onClose()
  }

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      // A chip menu already took this one.
      if (e.key !== 'Escape' || e.defaultPrevented) return
      // Escape peels off one layer at a time: the nested "add project" dialog
      // first, so it never takes the composer down with it.
      if (newProjectOpen) {
        setNewProjectOpen(false)
        return
      }
      if (pickerOpen) {
        setPickerOpen(false)
        focusPrompt()
        return
      }
      requestClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose, busy, cancelling, newProjectOpen, pickerOpen])

  useEffect(() => {
    if (!pickerOpen) return
    const close = (e: MouseEvent): void => {
      if (!pickerRef.current?.contains(e.target as Node)) setPickerOpen(false)
    }
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [pickerOpen])

  // Branches are only fetched once you actually ask for a workspace — the common
  // case is a plain task, and a git call per project switch would be wasted work.
  useEffect(() => {
    if (!workspaceOn || !targetDir) return
    let cancelled = false
    setBranchesLoading(true)
    setError('')
    window.api.workspaceListBranches({
      projectDir: targetDir,
      projectId: project?.ssh ? project.id : undefined,
      sshConfig: project?.ssh
    })
      .then(list => {
        if (cancelled) return
        setBranches(list)
        setBaseBranch(defaultBaseBranch(list))
      })
      .catch(err => {
        if (cancelled) return
        setBranches([])
        setBaseBranch('')
        setError(err instanceof Error ? err.message : 'Failed to list branches. Is this a git repository?')
      })
      .finally(() => {
        if (!cancelled) setBranchesLoading(false)
      })
    return () => { cancelled = true }
  }, [workspaceOn, targetDir, project])

  const draft = { target, prompt: promptText, workspace: workspaceOn, baseBranch }
  const valid = isNewTaskDraftValid(draft) && !imagesNeedPrompt

  /** The unwind is done — drop the dialog, unless the user already walked away. */
  const finishCancel = (): void => {
    if (!mountedRef.current) return
    setCreating(null)
    setCancelling(false)
    onClose()
  }

  const handleCreate = async (): Promise<void> => {
    if (!valid || busy || !target) return
    const start = agent && promptText
      ? {
          agent,
          prompt: {
            text: promptText,
            ...(takesMode && mode ? { mode } : {}),
            ...(agent === 'claude-chat' && model ? { model } : {}),
            ...(agent === 'claude-chat' && effort ? { effort } : {}),
            ...(images.length > 0 ? { images: toChatImages(images) } : {})
          }
        }
      : undefined

    if (!workspaceOn) {
      onCreate({ target, start })
      return
    }

    if (isPendingWorkspaceDraft(draft)) {
      onCreate({ target, workspaceDraft: { baseBranch } })
      return
    }

    cancelledRef.current = false
    setCancelling(false)
    setError('')

    const workspaceTarget = {
      projectDir: targetDir,
      projectId: project?.ssh ? project.id : undefined,
      sshConfig: project?.ssh
    }

    // The listed branches rule out most clashes; a branch made since then (or a
    // stale .worktrees folder) still fails, so step to the next name and retry.
    const taken = [...branches]
    let result: Awaited<ReturnType<typeof window.api.workspaceCreate>> | null = null
    for (let attempt = 1; !result; attempt++) {
      const name = workspaceBranchName(promptText, taken)
      setCreating(name)
      try {
        result = await window.api.workspaceCreate({ ...workspaceTarget, name, baseBranch })
      } catch (err) {
        // A cancelled failure has nothing to unwind — git got no further than we did.
        if (cancelledRef.current) {
          finishCancel()
          return
        }
        if (!mountedRef.current) return
        const message = err instanceof Error ? err.message : 'Failed to create workspace'
        if (attempt < ATTEMPTS && /already exists/i.test(message)) {
          taken.push(name)
          continue
        }
        setError(message)
        setCreating(null)
        return
      }
    }

    if (!cancelledRef.current) {
      onCreate({
        target,
        start,
        workspace: {
          worktreePath: result.worktreePath,
          branchName: result.branchName,
          baseBranch,
          relativeProjectPath: result.relativeProjectPath
        }
      })
      return
    }

    // Cancelled while git was working: the worktree is on disk with nothing
    // pointing at it. Force is safe here — the branch is seconds old and sits on
    // its base, so there is no uncommitted or unmerged work to protect.
    try {
      await window.api.workspaceDelete({
        ...workspaceTarget,
        worktreePath: result.worktreePath,
        branchName: result.branchName,
        baseBranch,
        force: true
      })
    } catch (err) {
      // Never drop an orphan quietly: if we can't undo it, name it so the user can.
      if (!mountedRef.current) return
      const why = err instanceof Error ? err.message : 'unknown error'
      setError(`Cancelled, but the workspace at ${result.worktreePath} could not be removed (${why}). Delete it by hand.`)
      setCreating(null)
      setCancelling(false)
      return
    }
    finishCancel()
  }

  const onPromptKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      void handleCreate()
    } else if (e.key === 'Tab' && e.shiftKey && takesMode) {
      e.preventDefault()
      setMode(nextMode(mode))
    }
  }

  const onProjectFilterKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      if (rows.length === 0) return
      const delta = e.key === 'ArrowDown' ? 1 : -1
      const next = Math.min(Math.max((cursor < 0 ? 0 : cursor) + delta, 0), rows.length - 1)
      selectTarget(rows[next].target)
    } else if (e.key === 'Enter') {
      // The destination is already picked — Enter here just moves you along to
      // the thing you still have to type.
      e.preventDefault()
      setPickerOpen(false)
      focusPrompt()
    }
  }

  const choose = (next: NewTaskTarget): void => {
    selectTarget(next)
    setPickerOpen(false)
    focusPrompt()
  }

  const handlePickDirectory = async (): Promise<void> => {
    setPickerOpen(false)
    const dir = await window.api.pickDirectory()
    if (!dir || !mountedRef.current) return
    setPickedDir(dir)
    setProjectFilter('')
    selectTarget({ kind: 'dir', directory: dir })
    focusPrompt()
  }

  const handleAddProject = (projectName: string, directory: string, tagIds?: string[]): void => {
    const created = onAddProject(projectName, directory, tagIds)
    setNewProjectOpen(false)
    setProjectFilter('')
    selectTarget({ kind: 'project', projectId: created.id })
    focusPrompt()
  }

  const placeholder = !target
    ? 'Pick a project first'
    : agent
      ? `What should ${PROMPT_BOX_AGENT_LABEL[agent]} work on? Enter to start, Shift+Enter for a new line`
      : project?.shellCommand
        ? 'Custom shell projects take no prompt. Enter opens the task.'
        : 'No agent is switched on in Settings. Enter opens the task.'

  return (
    <>
      <div className="fixed inset-0 z-(--z-modal) flex items-start justify-center pt-[14vh] bg-black/50" onClick={requestClose}>
        <div
          role="dialog"
          aria-label="New task"
          className="w-[640px] max-w-[90vw] rounded-xl border border-border bg-surface shadow-pop flex flex-col gap-3 p-4"
          onClick={(e) => e.stopPropagation()}
        >
          <header className="flex items-center gap-1.5 min-w-0">
            <h2 className="text-md font-semibold text-text m-0 shrink-0">New task</h2>
            <span className="text-md text-text-muted shrink-0">in</span>
            <div ref={pickerRef} className="relative min-w-0">
              <button
                type="button"
                aria-label="Project"
                aria-expanded={pickerOpen}
                title={targetDir || targetLabel || undefined}
                disabled={busy}
                onClick={() => setPickerOpen(!pickerOpen)}
                className="inline-flex items-center gap-1 max-w-full h-7 px-2 rounded-md border-0 bg-surface-3 text-md text-text cursor-pointer hover:bg-sel disabled:opacity-50 disabled:cursor-default"
              >
                <span className="truncate">{targetLabel || 'Choose a project'}</span>
                {target?.kind === 'dir' && (
                  <span className="text-2xs px-1 py-px rounded-sm bg-surface text-text-muted shrink-0">dir</span>
                )}
                <ChevronDown size={13} className="shrink-0 opacity-70" />
              </button>
              {pickerOpen && (
                <div className="absolute top-full left-0 mt-1 z-(--z-menu) w-72 bg-surface border-[0.5px] border-border rounded-lg p-1 shadow-pop flex flex-col gap-1">
                  {/* One project is nothing to filter — the input would just be noise. */}
                  {projects.length > 1 && (
                    <Field
                      value={projectFilter}
                      onChange={(e) => setProjectFilter(e.target.value)}
                      placeholder="Filter projects…"
                      onKeyDown={onProjectFilterKeyDown}
                      autoFocus
                    />
                  )}
                  <div
                    ref={projectListRef}
                    role="group"
                    aria-label="Destination"
                    className="max-h-[240px] overflow-y-auto"
                  >
                    {rows.length === 0 && (
                      <div className="px-2.5 py-1 text-sm text-text-muted">
                        {projects.length === 0 ? 'No projects yet' : 'No matching projects'}
                      </div>
                    )}
                    {rows.map(row => (
                      <button
                        key={row.key}
                        type="button"
                        title={row.title}
                        // The background belongs to exactly one branch below: a static
                        // `bg-transparent` here would out-rank `bg-sel` in the utility
                        // layer and the selected row would draw as if nothing was picked.
                        className={`flex w-full items-center gap-1.5 rounded-md px-2.5 py-1 text-left text-sm text-text border-0 cursor-pointer ${cursor >= 0 && rows[cursor].key === row.key ? 'bg-sel' : 'bg-transparent hover:bg-surface-3'}`}
                        onClick={() => choose(row.target)}
                      >
                        <span className="truncate">{row.label}</span>
                        {row.adhoc && (
                          <span className="text-2xs px-1 py-px rounded-sm bg-surface-3 text-text-muted shrink-0">dir</span>
                        )}
                      </button>
                    ))}
                  </div>
                  <div className="border-t border-hair pt-1">
                    <button type="button" className={menuItemCls} onClick={() => { setPickerOpen(false); setNewProjectOpen(true) }}>
                      <Plus size={12} className="inline mr-1" />New project…
                    </button>
                    <button type="button" className={menuItemCls} onClick={() => void handlePickDirectory()}>
                      <Plus size={12} className="inline mr-1" />Use a directory…
                    </button>
                  </div>
                </div>
              )}
            </div>
            <button
              type="button"
              onClick={requestClose}
              className="ml-auto bg-transparent border-0 text-text-muted cursor-pointer text-lg leading-none px-1 rounded-sm hover:text-text"
              title="Close"
            >
              &times;
            </button>
          </header>

          <div
            className="relative rounded-xl border-[0.5px] bg-field shadow-[0_1px_3px_rgba(0,0,0,0.12)] border-border-strong focus-within:border-border-focus transition-colors duration-(--motion-fast)"
            {...attachments.dropProps}
          >
            <AttachmentStrip images={images} onRemove={attachments.remove} />
            <textarea
              ref={promptRef}
              rows={3}
              value={prompt}
              readOnly={busy}
              disabled={!agent}
              autoFocus
              aria-label="First prompt"
              placeholder={placeholder}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={onPromptKeyDown}
              onPaste={attachments.onPaste}
              className="block w-full resize-none bg-transparent border-0 outline-none px-3 pt-2.5 pb-1 text-base text-text placeholder:text-text-subtle leading-[1.5] min-h-[82px] max-h-60 disabled:cursor-default"
            />
            <div className="flex items-end gap-1 px-1.5 pb-1.5">
              <div className="flex-1 min-w-0 flex items-center gap-0.5 flex-wrap">
                {agent && <AgentMenu agents={agents} value={agent} onChange={(a) => { setPicked(a); focusPrompt() }} placement="down" />}
                {agent === 'claude-chat' && (
                  <ChipMenu label={`Model: ${MODEL_OPTIONS.find((m) => m.value === model)?.label ?? model}`} title="Model" placement="down" options={MODEL_OPTIONS} value={model} onChange={(v) => { setModel(v); focusPrompt() }} />
                )}
                {takesMode && (
                  <ChipMenu label={`Mode: ${modeLabel(mode)}`} title="Permission mode (Shift+Tab cycles)" placement="down" options={MODE_OPTIONS} value={mode} onChange={(v) => { setMode(v); focusPrompt() }} />
                )}
                {agent === 'claude-chat' && (
                  <ChipMenu label={`Effort: ${effort || 'Default'}`} title="Thinking effort" placement="down" options={EFFORT_OPTIONS} value={effort} onChange={(v) => { setEffort(v); focusPrompt() }} />
                )}
                <button
                  type="button"
                  role="switch"
                  aria-checked={workspaceOn}
                  aria-label="Isolate in a workspace"
                  disabled={!workspaceSupported || busy}
                  title={workspaceSupported
                    ? 'Run the task in its own git worktree, on a new branch named after the prompt'
                    : 'Not available for custom shell projects'}
                  onClick={() => { setWorkspace(!workspaceOn); focusPrompt() }}
                  className={[
                    'inline-flex items-center gap-1 h-5 px-1.5 rounded-md border-0 text-xs cursor-pointer disabled:opacity-50 disabled:cursor-default transition-colors duration-(--motion-fast)',
                    workspaceOn ? 'bg-sel text-text' : 'bg-transparent text-text-muted hover:bg-surface-3 hover:text-text'
                  ].join(' ')}
                >
                  <GitBranch size={11} className="shrink-0" aria-hidden />
                  Workspace
                </button>
                {workspaceOn && (
                  <ChipMenu
                    label={`from ${baseBranch || (branchesLoading ? '…' : 'no branch')}`}
                    title="Base branch"
                    placement="down"
                    disabled={busy || branches.length === 0}
                    options={branches.map((b) => ({ value: b, label: b }))}
                    value={baseBranch}
                    onChange={(v) => { setBaseBranch(v); focusPrompt() }}
                  />
                )}
              </div>
              <button
                type="button"
                title={promptText ? 'Start (Enter)' : 'Create an empty task (Enter)'}
                aria-label="Create task"
                disabled={!valid || busy}
                onClick={() => void handleCreate()}
                className="w-6 h-6 shrink-0 inline-flex items-center justify-center rounded-md border-0 bg-accent text-accent-ink cursor-pointer hover:brightness-105 disabled:opacity-35 disabled:cursor-default"
              >
                <ArrowUp size={14} strokeWidth={2.5} />
              </button>
            </div>
          </div>

          {cancelling ? (
            <HelperText>Cancelling — removing the workspace git already started.</HelperText>
          ) : creating ? (
            <HelperText>Creating worktree <span className="font-mono">{creating}</span>…</HelperText>
          ) : error ? (
            <HelperText><span className="text-danger">{error}</span></HelperText>
          ) : workspaceOn && !branchesLoading && branches.length === 0 ? (
            <HelperText>No branch to fork a workspace from. Is this a git repository with a commit?</HelperText>
          ) : imagesNeedPrompt ? (
            <HelperText>Add a prompt to send the images with.</HelperText>
          ) : !target ? (
            <HelperText>Tasks live in a project — add one, or point this task at a directory.</HelperText>
          ) : (
            <HelperText>
              {agent
                ? `The first prompt names the task.${takesImages ? ' Paste or drop images to send them with it.' : ''} Send it empty to open the task without starting an agent.`
                : 'The task opens empty; add a terminal or browser tab from there.'}
            </HelperText>
          )}
        </div>
      </div>

      {newProjectOpen && (
        <AddLocalProject
          onAdd={handleAddProject}
          onCancel={() => setNewProjectOpen(false)}
          allTags={allTags}
          onEnsureTag={onEnsureTag}
        />
      )}
    </>
  )
}
