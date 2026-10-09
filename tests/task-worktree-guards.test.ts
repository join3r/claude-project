import { describe, expect, it } from 'vitest'
import { findStreamOfTask, findTaskInProject, needsTaskWorktree, reopensInOwnWorktree, taskWorktreesSupported } from '../src/shared/streams'
import { featureAvailable } from '../src/shared/project-features'
import { canLandTask } from '../src/renderer/taskLanding'
import { TaskLandingManager } from '../src/main/task-landing'
import { TaskWorktreeManager, type TaskWorktreeGit } from '../src/main/task-worktree'
import type { GitRunner } from '../src/main/git-runner'
import type { Project, ProjectsData, WorkspaceConfig } from '../src/shared/types'
import { fixtureProject } from './helpers/streams-fixtures'

/**
 * Plan step 8: task worktrees and landing are on for a DevTool server's projects
 * (the server's own git runs them), and still off for SSH projects.
 */

const streamWs: WorkspaceConfig = { worktreePath: '/repo/.worktrees/rel', branchName: 'rel', baseBranch: 'main', relativeProjectPath: '' }
const ownWs: WorkspaceConfig = { worktreePath: '/repo/.worktrees/rel--fix', branchName: 'rel--fix', baseBranch: 'rel', relativeProjectPath: '' }
const ssh = { host: 'h', port: 22, username: 'u', remoteDir: '/srv' }

function project(extra: Partial<Project> = {}): Project {
  const p = fixtureProject({
    id: 'p1',
    directory: '/repo',
    tasks: [{ id: 'new', workspace: streamWs }, { id: 'own', workspace: streamWs, ownWorkspace: ownWs }]
  })
  return { ...p, streams: p.streams.map(s => (s.workspace ? { ...s, taskWorktrees: true as const } : s)), ...extra }
}

const local = project()
const onServer = project({ host: 'srvA' })
const overSsh = project({ ssh })

function needs(p: Project, taskId = 'new'): boolean {
  return needsTaskWorktree(p, findStreamOfTask(p, taskId)!, findTaskInProject(p, taskId)!)
}

describe('task worktree guards', () => {
  it('turns task worktrees on for a server project, as for a local one, and keeps them off over SSH', () => {
    expect(featureAvailable(onServer, 'task-worktrees')).toBe(true)
    expect(taskWorktreesSupported(local)).toBe(true)
    expect(taskWorktreesSupported(onServer)).toBe(true)
    expect(taskWorktreesSupported(overSsh)).toBe(false)
  })

  it('gives a server project\'s new task a worktree of its own, and an SSH project\'s none', () => {
    expect(needs(local)).toBe(true)
    expect(needs(onServer)).toBe(true)
    expect(needs(overSsh)).toBe(false)
    for (const p of [local, onServer]) {
      expect(reopensInOwnWorktree(p, findStreamOfTask(p, 'new')!, findTaskInProject(p, 'new')!)).toBe(true)
    }
    expect(reopensInOwnWorktree(overSsh, findStreamOfTask(overSsh, 'new')!, findTaskInProject(overSsh, 'new')!)).toBe(false)
  })

  it('lets a server project\'s task land, and an SSH project\'s not', () => {
    expect(canLandTask(onServer, findTaskInProject(onServer, 'own')!)).toBe(true)
    expect(canLandTask(local, findTaskInProject(local, 'own')!)).toBe(true)
    expect(canLandTask(overSsh, findTaskInProject(overSsh, 'own')!)).toBe(false)
    expect(canLandTask(onServer, findTaskInProject(onServer, 'new')!)).toBe(false)
  })

  it('refuses to land or make a worktree for an SSH project in main', async () => {
    const data = (p: Project): ProjectsData => ({ projects: [p], tags: [], projectOrder: [p.id], pinnedItems: [] })
    const noGit: GitRunner = { kind: 'local', run: async () => ({ stdout: '', stderr: '', code: 1 }) }
    const landing = new TaskLandingManager({
      projects: { peek: () => data(overSsh), commit: () => {} },
      runner: noGit,
      git: { delete: async () => ({ status: 'ok' }) },
      activity: { getStatus: () => null, subscribe: () => () => {} }
    })
    expect(await landing.landTask('p1', 'own')).toEqual({ status: 'failed', error: 'Landing is not supported for SSH projects yet' })
    expect(await landing.streamAhead('p1', 'own')).toBeNull()

    const git = new Proxy({}, { get: () => () => { throw new Error('no git for an SSH project') } }) as TaskWorktreeGit
    const worktrees = new TaskWorktreeManager({ projects: { peek: () => data(overSsh), commit: () => {}, subscribe: () => () => {} }, git })
    expect(await worktrees.ensureTaskWorktree('p1', 'new')).toEqual({ status: 'not-needed' })
    expect(await worktrees.runStreamSetup('p1', overSsh.streams[1].id, { repoKey: '/r', hash: 'h', commands: [] }))
      .toEqual({ status: 'failed', error: 'No such stream worktree' })
  })
})
