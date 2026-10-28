import { describe, expect, it, vi } from 'vitest'
import { TaskDiffWatch } from '../src/main/task-diff-watch'
import { createMainStream, type Project, type Task } from '../src/shared/types'

function task(id: string, extra: Partial<Task> = {}): Task {
  return { id, name: id, panes: [], ...extra }
}

const local: Project = {
  id: 'p',
  name: 'p',
  directory: '/src/p',
  streams: [
    createMainStream('p', [task('a'), task('b')]),
    {
      id: 's',
      name: '0.5.0',
      workspace: { worktreePath: '/wt/s', branchName: '0.5.0', baseBranch: 'main', relativeProjectPath: '' },
      tasks: [task('c', { workspace: { worktreePath: '/wt/c', branchName: '0.5.0--c', baseBranch: '0.5.0', relativeProjectPath: '' } })]
    }
  ]
}
const ssh: Project = { id: 'q', name: 'q', directory: '/x', ssh: { host: 'h', remoteDir: '/r' } as Project['ssh'], streams: [createMainStream('q', [task('d')])] }

describe('TaskDiffWatch', () => {
  it('counts each directory once, a task worktree against its stream, and skips SSH projects', async () => {
    const read = vi.fn(async (dir: string) => (dir === '/src/p' ? { added: 5, deleted: 1 } : { added: 0, deleted: 2 }))
    const watch = new TaskDiffWatch(() => [local, ssh], () => true, 15_000, read)
    const heard = vi.fn()
    watch.subscribe(heard)
    await watch.refresh()
    expect(read.mock.calls).toEqual([['/src/p', undefined], ['/wt/c', '0.5.0']])
    expect(Object.fromEntries(watch.peek())).toEqual({
      a: { added: 5, deleted: 1 }, b: { added: 5, deleted: 1 }, c: { added: 0, deleted: 2 }
    })
    expect(heard).toHaveBeenCalledTimes(1)
    await watch.refresh()
    expect(heard).toHaveBeenCalledTimes(1)
  })

  it('runs no git while no phone is connected', async () => {
    const read = vi.fn(async () => ({ added: 1, deleted: 0 }))
    const watch = new TaskDiffWatch(() => [local], () => false, 15_000, read)
    await watch.refresh()
    expect(read).not.toHaveBeenCalled()
    expect(watch.peek().size).toBe(0)
  })
})
