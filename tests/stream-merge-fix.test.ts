import { describe, it, expect, vi } from 'vitest'
import type { ProjectsData } from '../src/shared/types'
import { findTaskInProject } from '../src/shared/streams'
import { startStreamMergeFix, streamMergeFixPrompt } from '../src/main/stream-merge-fix'
import { fixtureProject, fixtureTask } from './helpers/streams-fixtures'

function data(): ProjectsData {
  const project = fixtureProject({
    id: 'p1',
    name: 'Alpha',
    directory: '/repo',
    streams: [
      {
        id: 's-rel',
        name: '2.1.0',
        workspace: { worktreePath: '/repo/.worktrees/rel', branchName: '2.1.0', baseBranch: 'master', relativeProjectPath: '' },
        taskWorktrees: true,
        tasks: [fixtureTask({ id: 't1', name: 'Work' })]
      }
    ]
  })
  return { projects: [project] } as ProjectsData
}

describe('streamMergeFixPrompt', () => {
  it('asks for the base branch merged into the stream, the files listed, nothing destructive', () => {
    const prompt = streamMergeFixPrompt({ streamBranch: '2.1.0', baseBranch: 'master', files: ['a.ts', 'b c.md'] })
    expect(prompt).toContain('git merge --no-edit "master"')
    expect(prompt).toContain('- "a.ts"\n- "b c.md"')
    expect(prompt).toContain('Never run `git reset --hard`')
  })
})

describe('startStreamMergeFix', () => {
  it('adds a chat task sharing the stream\'s worktree and sends it the prompt', async () => {
    let current = data()
    const sendFirstPrompt = vi.fn().mockResolvedValue(undefined)
    const result = await startStreamMergeFix({
      peek: () => current,
      commit: next => { current = next },
      blocker: () => null,
      sendFirstPrompt,
      log: () => {}
    }, 'p1', 's-rel', ['a.ts'])

    expect(result.ok).toBe(true)
    if (!result.ok) return
    const task = findTaskInProject(current.projects[0], result.taskId)
    expect(task).toMatchObject({ name: 'Merge master into 2.1.0', sharesStreamWorktree: true })
    expect(current.projects[0].streams[1].tasks.map(t => t.id)).toEqual(['t1', result.taskId])
    expect(sendFirstPrompt).toHaveBeenCalledWith('p1', result.taskId, expect.any(String), expect.stringContaining('"a.ts"'))
  })

  it('refuses main, and a project that can\'t run Claude', async () => {
    const deps = { peek: data, commit: vi.fn(), blocker: () => null, sendFirstPrompt: vi.fn(), log: () => {} }
    const mainId = data().projects[0].streams[0].id
    expect(await startStreamMergeFix(deps, 'p1', mainId, [])).toEqual({ ok: false, error: 'This stream has no branch of its own.' })
    expect(await startStreamMergeFix({ ...deps, blocker: () => 'Claude is turned off in Settings.' }, 'p1', 's-rel', []))
      .toEqual({ ok: false, error: 'Claude is turned off in Settings.' })
    expect(deps.commit).not.toHaveBeenCalled()
  })
})
