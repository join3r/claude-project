import { useCallback, useEffect, useRef, useState } from 'react'
import { useApp } from '../context/AppContext'
import type { Project, WorkspaceDraft } from '../../shared/types'
import { getProjectDir } from '../hooks/appState/projectsData'
import { defaultBaseBranch } from './newTask'
import { workspaceBranchName } from './promptBox'

export interface PendingWorkspace {
  /** False for a plain task: `ensure` then has nothing to do. */
  pending: boolean
  branches: string[]
  baseBranch: string
  /** The branch being created right now, or null. */
  creating: string | null
  error: string | null
  setBaseBranch: (branch: string) => void
  /** Turn the task back into a plain one. */
  dropWorkspace: () => void
  /**
   * Create the worktree, branch named after `nameSource`, and point the task at it.
   * Resolves true once the task has its directory (at once for a plain task).
   */
  ensure: (nameSource: string) => Promise<boolean>
}

const ATTEMPTS = 3

/**
 * The worktree side of a task opened from + Workspace: it is created when the first
 * tab opens, so the branch can be named after the first prompt.
 */
export function usePendingWorkspace(project: Project, taskId: string, draft: WorkspaceDraft | undefined): PendingWorkspace {
  const { setWorkspaceDraft, attachWorkspace } = useApp()
  const pending = !!draft
  const [branches, setBranches] = useState<string[]>([])
  const [creating, setCreating] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const creatingRef = useRef(false)

  const target = useCallback(() => ({
    projectDir: getProjectDir(project),
    projectId: project.ssh ? project.id : undefined,
    sshConfig: project.ssh
  }), [project])

  useEffect(() => {
    if (!pending) return
    let cancelled = false
    window.api.workspaceListBranches(target())
      .then((list) => { if (!cancelled) setBranches(list) })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Could not list branches. Is this a git repository?')
      })
    return () => { cancelled = true }
  }, [pending, target])

  const baseBranch = draft?.baseBranch ?? defaultBaseBranch(branches)

  const ensure = useCallback(async (nameSource: string): Promise<boolean> => {
    if (!pending) return true
    if (creatingRef.current) return false
    if (!baseBranch) {
      setError('No branch to start the workspace from yet.')
      return false
    }
    creatingRef.current = true
    setError(null)
    const taken = [...branches]
    try {
      // The listed branches rule out most clashes; a branch made since then (or a
      // stale .worktrees folder) still fails, so step to the next name and retry.
      for (let attempt = 1; ; attempt++) {
        const name = workspaceBranchName(nameSource, taken)
        setCreating(name)
        try {
          const result = await window.api.workspaceCreate({ ...target(), name, baseBranch })
          attachWorkspace(project.id, taskId, {
            worktreePath: result.worktreePath,
            branchName: result.branchName,
            baseBranch,
            relativeProjectPath: result.relativeProjectPath
          })
          return true
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          if (attempt < ATTEMPTS && /already exists/i.test(message)) {
            taken.push(name)
            continue
          }
          setError(message)
          return false
        }
      }
    } finally {
      creatingRef.current = false
      setCreating(null)
    }
  }, [pending, baseBranch, branches, target, attachWorkspace, project.id, taskId])

  return {
    pending,
    branches,
    baseBranch,
    creating,
    error,
    setBaseBranch: (branch) => setWorkspaceDraft(project.id, taskId, { ...draft, baseBranch: branch }),
    dropWorkspace: () => { setError(null); setWorkspaceDraft(project.id, taskId, null) },
    ensure
  }
}
