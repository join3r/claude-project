import React, { useEffect, useMemo, useRef, useState } from 'react'
import type { Project, Tag, WorkspaceConfig } from '../../shared/types'
import { NEW_TASK_NAME, isShellCommandProject } from '../../shared/types'
import { dirBasename } from '../../shared/paths'
import { Modal, SetBlock, Field, LinkBtn, PrimaryButton, HelperText, Switch, menuCls, menuItemCls } from './ui'
import AddLocalProject from './AddLocalProject'
import { branchSlug, defaultBaseBranch, isNewTaskDraftValid, isPendingWorkspaceDraft, matchProjects } from './newTask'
import type { NewTaskTarget } from './newTask'
import { Plus } from 'lucide-react'

interface Props {
  projects: Project[]
  /** Pre-selected project — the one you were last looking at. */
  defaultProjectId: string | null
  getProjectDir: (project: Project) => string
  allTags: readonly Tag[]
  onEnsureTag: (name: string) => string
  onAddProject: (name: string, directory: string, tagIds?: string[]) => Project
  onCreate: (target: NewTaskTarget, name: string) => void
  onCreateWorkspace: (target: NewTaskTarget, name: string, workspace: WorkspaceConfig) => void
  /** A workspace with no name or branch yet: the worktree is made when the first prompt names it. */
  onCreatePendingWorkspace: (target: NewTaskTarget, baseBranch: string) => void
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

/**
 * Compose a task the way you compose a mail: pick where it goes, give it a
 * subject, send. The optional workspace toggle is the one thing the tree's
 * "+ Task" can't do in a single step, so it lives here rather than forcing a
 * second trip through the project row.
 *
 * The destination list holds exactly one highlighted row, and that row is what
 * gets created — there is no separate "cursor" that can drift away from the
 * selection while the filter hides the difference.
 */
export default function NewTaskModal({
  projects,
  defaultProjectId,
  getProjectDir,
  allTags,
  onEnsureTag,
  onAddProject,
  onCreate,
  onCreateWorkspace,
  onCreatePendingWorkspace,
  onClose
}: Props): React.ReactElement {
  const [target, setTarget] = useState<NewTaskTarget | null>(() => {
    if (defaultProjectId && projects.some(p => p.id === defaultProjectId)) {
      return { kind: 'project', projectId: defaultProjectId }
    }
    return projects[0] ? { kind: 'project', projectId: projects[0].id } : null
  })
  const [name, setName] = useState('')
  const [workspace, setWorkspace] = useState(false)
  // null means "still following the task name"; typing in the field pins it.
  const [branchOverride, setBranchOverride] = useState<string | null>(null)
  const [branches, setBranches] = useState<string[]>([])
  const [branchesLoading, setBranchesLoading] = useState(false)
  const [baseBranch, setBaseBranch] = useState('')
  const [filter, setFilter] = useState('')
  const [projectFilter, setProjectFilter] = useState('')
  // The directory picked via "Use a directory…", if any. No project record exists
  // for it yet — one is minted only if this draft is actually created.
  const [pickedDir, setPickedDir] = useState<string | null>(null)
  const [addMenuOpen, setAddMenuOpen] = useState(false)
  const [newProjectOpen, setNewProjectOpen] = useState(false)
  const [creating, setCreating] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const [error, setError] = useState('')
  const projectListRef = useRef<HTMLDivElement>(null)
  const nameRef = useRef<HTMLInputElement>(null)
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
  // Shell-command projects have no directory to make a worktree in.
  const workspaceSupported = target?.kind === 'dir' || (!!project && !isShellCommandProject(project))
  const workspaceOn = workspace && workspaceSupported
  const branch = branchOverride ?? branchSlug(name)

  /** Point the composer somewhere else, dropping everything the old target loaded. */
  const selectTarget = (next: NewTaskTarget): void => {
    setTarget(next)
    // Another repo means other branches.
    setBranches([])
    setBaseBranch('')
    setFilter('')
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

  // Follow the selection — this also brings it into view on open.
  useEffect(() => {
    if (cursor < 0) return
    const row = projectListRef.current?.children[cursor] as HTMLElement | undefined
    row?.scrollIntoView({ block: 'nearest' })
  }, [cursor])

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

  /** Give up on the dialog, and on anything it has in flight. */
  const requestClose = (): void => {
    // First press while git is working stays up to say so; a second one bails out
    // and lets the unwind finish on its own.
    if (creating && !cancelling) {
      cancelledRef.current = true
      setCancelling(true)
      setError('')
      return
    }
    onClose()
  }

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      // Escape peels off one layer at a time: the nested "add project" dialog
      // first, so it never takes the composer down with it.
      if (newProjectOpen) {
        setNewProjectOpen(false)
        return
      }
      if (addMenuOpen) {
        setAddMenuOpen(false)
        return
      }
      requestClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose, creating, cancelling, newProjectOpen, addMenuOpen])

  useEffect(() => {
    if (!addMenuOpen) return
    const close = (): void => setAddMenuOpen(false)
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [addMenuOpen])

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

  const filteredBranches = filter
    ? branches.filter(b => b.toLowerCase().includes(filter.toLowerCase()))
    : branches

  const valid = isNewTaskDraftValid({ target, name, workspace: workspaceOn, branch, baseBranch })

  /** The unwind is done — drop the dialog, unless the user already walked away. */
  const finishCancel = (): void => {
    if (!mountedRef.current) return
    setCreating(false)
    setCancelling(false)
    onClose()
  }

  const handleCreate = async (): Promise<void> => {
    if (!valid || creating || !target) return
    const taskName = name.trim() || NEW_TASK_NAME

    if (!workspaceOn) {
      onCreate(target, taskName)
      return
    }

    if (isPendingWorkspaceDraft({ target, name, workspace: workspaceOn, branch, baseBranch })) {
      onCreatePendingWorkspace(target, baseBranch)
      return
    }

    cancelledRef.current = false
    setCreating(true)
    setCancelling(false)
    setError('')

    const workspaceTarget = {
      projectDir: targetDir,
      projectId: project?.ssh ? project.id : undefined,
      sshConfig: project?.ssh
    }

    let result: Awaited<ReturnType<typeof window.api.workspaceCreate>>
    try {
      result = await window.api.workspaceCreate({
        ...workspaceTarget,
        name: branch.trim(),
        baseBranch
      })
    } catch (err) {
      // A cancelled failure has nothing to unwind — git got no further than we did.
      if (cancelledRef.current) {
        finishCancel()
        return
      }
      if (!mountedRef.current) return
      setError(err instanceof Error ? err.message : 'Failed to create workspace')
      setCreating(false)
      return
    }

    if (!cancelledRef.current) {
      onCreateWorkspace(target, taskName, {
        worktreePath: result.worktreePath,
        branchName: result.branchName,
        baseBranch,
        relativeProjectPath: result.relativeProjectPath
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
      setCreating(false)
      setCancelling(false)
      return
    }
    finishCancel()
  }

  const submitOnEnter = (e: React.KeyboardEvent): void => {
    if (e.key === 'Enter') void handleCreate()
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
      nameRef.current?.focus()
    }
  }

  const handlePickDirectory = async (): Promise<void> => {
    const picked = await window.api.pickDirectory()
    if (!picked || !mountedRef.current) return
    setPickedDir(picked)
    setProjectFilter('')
    selectTarget({ kind: 'dir', directory: picked })
    nameRef.current?.focus()
  }

  const handleAddProject = (projectName: string, directory: string, tagIds?: string[]): void => {
    const created = onAddProject(projectName, directory, tagIds)
    setNewProjectOpen(false)
    setProjectFilter('')
    selectTarget({ kind: 'project', projectId: created.id })
    nameRef.current?.focus()
  }

  return (
    <>
      <Modal
        title="New task"
        onClose={requestClose}
        footer={
          <>
            <LinkBtn onClick={requestClose}>{cancelling ? 'Close anyway' : 'Cancel'}</LinkBtn>
            <PrimaryButton onClick={() => void handleCreate()} disabled={!valid || creating}>
              {cancelling ? 'Cancelling…' : creating ? 'Creating…' : 'Create'}
            </PrimaryButton>
          </>
        }
      >
        <SetBlock
          label={
            <span className="flex items-baseline gap-1.5">
              <span>Project</span>
              {/* Naming the destination in the label is what makes a filter that
                  matches nothing harmless: you can still read where this goes. */}
              {targetLabel && (
                <span className="text-sm font-normal text-text-muted truncate" title={targetDir || targetLabel}>
                  — {targetLabel}
                </span>
              )}
            </span>
          }
        >
          <div className="flex gap-2">
            {/* One project is nothing to filter — the input would just be noise. */}
            {projects.length > 1 && (
              <Field
                className="flex-1"
                value={projectFilter}
                onChange={(e) => setProjectFilter(e.target.value)}
                placeholder="Filter projects…"
                onKeyDown={onProjectFilterKeyDown}
              />
            )}
            <div className="relative ml-auto">
              <button
                className="h-(--ctl-h) px-2.5 flex items-center rounded-md bg-field text-text-muted hover:text-text border border-border cursor-pointer"
                onClick={(e) => { e.stopPropagation(); setAddMenuOpen(!addMenuOpen) }}
                title="Add a destination"
                aria-label="Add a destination"
              >
                <Plus size={14} />
              </button>
              {addMenuOpen && (
                <div
                  className={`absolute top-full right-0 mt-1 z-(--z-menu) whitespace-nowrap ${menuCls}`}
                  onMouseDown={(e) => e.stopPropagation()}
                >
                  <button
                    className={menuItemCls}
                    onClick={() => { setAddMenuOpen(false); setNewProjectOpen(true) }}
                  >
                    New project…
                  </button>
                  <button
                    className={menuItemCls}
                    onClick={() => { setAddMenuOpen(false); void handlePickDirectory() }}
                  >
                    Use a directory…
                  </button>
                </div>
              )}
            </div>
          </div>
          <div
            ref={projectListRef}
            role="group"
            aria-label="Destination"
            className="max-h-[160px] overflow-y-auto rounded-md border border-border bg-field p-1"
          >
            {rows.length === 0 && (
              <div className="px-2 py-1.5 text-sm text-text-muted">
                {projects.length === 0 ? 'No projects yet' : 'No matching projects'}
              </div>
            )}
            {rows.map(row => (
              <button
                key={row.key}
                title={row.title}
                // The background belongs to exactly one branch below: a static
                // `bg-transparent` here would out-rank `bg-sel` in the utility
                // layer and the selected row would draw as if nothing was picked.
                className={`flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-base text-text border-0 cursor-pointer ${cursor >= 0 && rows[cursor].key === row.key ? 'bg-sel' : 'bg-transparent hover:bg-surface-3'}`}
                onClick={() => selectTarget(row.target)}
              >
                <span className="truncate">{row.label}</span>
                {row.adhoc && (
                  <span className="text-2xs px-1 py-px rounded-sm bg-surface-3 text-text-muted shrink-0">dir</span>
                )}
              </button>
            ))}
          </div>
          {projects.length === 0 && !pickedDir && (
            <HelperText>Tasks live in a project — add one, or point this task at a directory.</HelperText>
          )}
        </SetBlock>

        <SetBlock label="Task name (optional)">
          <Field
            ref={nameRef}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="What needs doing?"
            autoFocus
            onKeyDown={submitOnEnter}
          />
        </SetBlock>

        <SetBlock
          label={
            <span className="flex items-center justify-between gap-3">
              <span>Isolate in a workspace</span>
              <Switch
                checked={workspaceOn}
                onChange={setWorkspace}
                disabled={!workspaceSupported}
              />
            </span>
          }
          sub={
            workspaceSupported
              ? 'Creates a git worktree on a new branch and points the task at it.'
              : 'Not available for custom shell projects.'
          }
        >
          {workspaceOn && (
            <div className="flex flex-col gap-3 pt-1">
              <SetBlock label={<span className="text-sm text-text-muted">Branch</span>}>
                <Field
                  value={branch}
                  onChange={(e) => setBranchOverride(e.target.value)}
                  placeholder="feature-name"
                  onKeyDown={submitOnEnter}
                />
                {!name.trim() && !branch.trim() && (
                  <HelperText>Left empty, the branch is named after the task's first prompt.</HelperText>
                )}
              </SetBlock>

              <SetBlock label={<span className="text-sm text-text-muted">Base branch</span>}>
                <Field
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  placeholder="Filter branches…"
                />
                <div className="max-h-[160px] overflow-y-auto rounded-md border border-border bg-field p-1">
                  {filteredBranches.length === 0 && (
                    <div className="px-2 py-1.5 text-sm text-text-muted">
                      {branchesLoading ? 'Loading…' : branches.length === 0 ? 'No branches' : 'No matching branches'}
                    </div>
                  )}
                  {filteredBranches.map(b => (
                    <button
                      key={b}
                      className={`block w-full rounded-md px-2 py-1 text-left text-base text-text border-0 cursor-pointer ${b === baseBranch ? 'bg-sel' : 'bg-transparent hover:bg-surface-3'}`}
                      onClick={() => setBaseBranch(b)}
                    >
                      {b}
                    </button>
                  ))}
                </div>
              </SetBlock>
            </div>
          )}
        </SetBlock>

        {cancelling && (
          <HelperText>Cancelling — removing the workspace git already started.</HelperText>
        )}
        {error && <HelperText><span className="text-danger">{error}</span></HelperText>}
      </Modal>

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
