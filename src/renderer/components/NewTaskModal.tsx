import React, { useEffect, useMemo, useRef, useState } from 'react'
import type { Project, WorkspaceConfig } from '../../shared/types'
import { isShellCommandProject } from '../../shared/types'
import { Modal, SetBlock, Field, LinkBtn, PrimaryButton, HelperText, Switch } from './ui'
import { branchSlug, defaultBaseBranch, isNewTaskDraftValid, matchProjects } from './newTask'

interface Props {
  projects: Project[]
  /** Pre-selected project — the one you were last looking at. */
  defaultProjectId: string | null
  getProjectDir: (project: Project) => string
  onCreate: (projectId: string, name: string) => void
  onCreateWorkspace: (projectId: string, name: string, workspace: WorkspaceConfig) => void
  onClose: () => void
}

/**
 * Compose a task the way you compose a mail: pick where it goes, give it a
 * subject, send. The optional workspace toggle is the one thing the tree's
 * "+ Task" can't do in a single step, so it lives here rather than forcing a
 * second trip through the project row.
 */
export default function NewTaskModal({
  projects,
  defaultProjectId,
  getProjectDir,
  onCreate,
  onCreateWorkspace,
  onClose
}: Props): React.ReactElement {
  const [projectId, setProjectId] = useState(() => {
    if (defaultProjectId && projects.some(p => p.id === defaultProjectId)) return defaultProjectId
    return projects[0]?.id ?? ''
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
  // Keyboard cursor in the project list, independent of what's actually selected.
  const [projectIndex, setProjectIndex] = useState(0)
  const [creating, setCreating] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const [error, setError] = useState('')
  const projectListRef = useRef<HTMLDivElement>(null)
  // git has no abort once it starts cutting a worktree, so "cancel" means: ignore
  // whatever comes back, and undo it. Checked after every await, not just the first.
  const cancelledRef = useRef(false)
  const mountedRef = useRef(true)

  const project = useMemo(() => projects.find(p => p.id === projectId) ?? null, [projects, projectId])
  const filteredProjects = useMemo(() => matchProjects(projects, projectFilter), [projects, projectFilter])
  // Shell-command projects have no directory to make a worktree in.
  const workspaceSupported = !!project && !isShellCommandProject(project)
  const workspaceOn = workspace && workspaceSupported
  const branch = branchOverride ?? branchSlug(name)

  // Re-aim the cursor whenever the filter narrows the list: with nothing typed the
  // whole list is on screen, so park it on the project you already have; otherwise
  // lead with the best match. Deliberately not keyed on projectId — picking a
  // project shouldn't yank the cursor away from where you were arrowing.
  useEffect(() => {
    if (projectFilter) {
      setProjectIndex(0)
      return
    }
    setProjectIndex(Math.max(filteredProjects.findIndex(p => p.id === projectId), 0))
  }, [projectFilter, filteredProjects])

  // Follow the cursor — this also brings the selected project into view on open.
  useEffect(() => {
    const row = projectListRef.current?.children[projectIndex] as HTMLElement | undefined
    row?.scrollIntoView({ block: 'nearest' })
  }, [projectIndex])

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
      if (e.key === 'Escape') requestClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose, creating, cancelling])

  // Branches are only fetched once you actually ask for a workspace — the common
  // case is a plain task, and a git call per project switch would be wasted work.
  useEffect(() => {
    if (!workspaceOn || !project) return
    let cancelled = false
    setBranchesLoading(true)
    setError('')
    window.api.workspaceListBranches({
      projectDir: getProjectDir(project),
      projectId: project.ssh ? project.id : undefined,
      sshConfig: project.ssh
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
  }, [workspaceOn, project, getProjectDir])

  const filteredBranches = filter
    ? branches.filter(b => b.toLowerCase().includes(filter.toLowerCase()))
    : branches

  const valid = isNewTaskDraftValid({ projectId, name, workspace: workspaceOn, branch, baseBranch })

  /** The unwind is done — drop the dialog, unless the user already walked away. */
  const finishCancel = (): void => {
    if (!mountedRef.current) return
    setCreating(false)
    setCancelling(false)
    onClose()
  }

  const handleCreate = async (): Promise<void> => {
    if (!valid || creating || !project) return
    const taskName = name.trim()

    if (!workspaceOn) {
      onCreate(project.id, taskName)
      return
    }

    cancelledRef.current = false
    setCreating(true)
    setCancelling(false)
    setError('')

    let result: Awaited<ReturnType<typeof window.api.workspaceCreate>>
    try {
      result = await window.api.workspaceCreate({
        projectDir: getProjectDir(project),
        projectId: project.ssh ? project.id : undefined,
        sshConfig: project.ssh,
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
      onCreateWorkspace(project.id, taskName, {
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
        projectDir: getProjectDir(project),
        projectId: project.ssh ? project.id : undefined,
        sshConfig: project.ssh,
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

  const selectProject = (id: string): void => {
    setProjectId(id)
    // Another repo means other branches; drop everything the old one loaded.
    setBranches([])
    setBaseBranch('')
    setFilter('')
    setError('')
  }

  const onProjectFilterKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const delta = e.key === 'ArrowDown' ? 1 : -1
      setProjectIndex(i => Math.min(Math.max(i + delta, 0), filteredProjects.length - 1))
    } else if (e.key === 'Enter') {
      // Enter picks a project here — only the task name field creates the task.
      e.preventDefault()
      const pick = filteredProjects[projectIndex] ?? filteredProjects[0]
      if (pick) selectProject(pick.id)
    }
  }

  return (
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
      {projects.length === 0 ? (
        <HelperText>Add a project first — tasks live inside one.</HelperText>
      ) : (
        <>
          <SetBlock label="Project">
            {/* One project is nothing to filter — the input would just be noise. */}
            {projects.length > 1 && (
              <Field
                value={projectFilter}
                onChange={(e) => setProjectFilter(e.target.value)}
                placeholder="Filter projects…"
                onKeyDown={onProjectFilterKeyDown}
              />
            )}
            <div ref={projectListRef} className="max-h-[160px] overflow-y-auto rounded-md border border-border bg-field p-1">
              {filteredProjects.length === 0 && (
                <div className="px-2 py-1.5 text-sm text-text-muted">No matching projects</div>
              )}
              {filteredProjects.map((p, i) => (
                <button
                  key={p.id}
                  // The background belongs to exactly one branch below: a static
                  // `bg-transparent` here would out-rank `bg-sel` in the utility
                  // layer and the selected row would draw as if nothing was picked.
                  className={`block w-full rounded-md px-2 py-1 text-left text-base text-text border-0 cursor-pointer ${p.id === projectId ? 'bg-sel' : i === projectIndex ? 'bg-surface-3' : 'bg-transparent hover:bg-surface-3'}`}
                  onClick={() => selectProject(p.id)}
                >
                  {p.name}
                </button>
              ))}
            </div>
          </SetBlock>

          <SetBlock label="Task name">
            <Field
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
        </>
      )}
    </Modal>
  )
}
