import { describe, expect, it } from 'vitest'
import { aheadBehindLine, laneTrack, projectHostLabel, quietFor, recentWeeks } from '../src/renderer/components/desk/projectMap'
import type { GitBranchGraph, GitGraphCommit, Project, Stream, Task, WorkspaceConfig } from '../src/shared/types'

function commit(hash: string, parents: string[], day = 1): GitGraphCommit {
  return { hash, parents, subject: `commit ${hash}`, author: 'me', isoDate: `2026-10-${String(day).padStart(2, '0')}T10:00:00Z` }
}

function ws(branchName: string, baseBranch: string): WorkspaceConfig {
  return { worktreePath: `/wt/${branchName}`, branchName, baseBranch, relativeProjectPath: '' }
}

function task(id: string, workspace?: WorkspaceConfig): Task {
  return { id, name: id, panes: [], ...(workspace ? { workspace } : {}) } as unknown as Task
}

function stream(id: string, extra: Partial<Stream> = {}): Stream {
  return { id, name: id, tasks: [], ...extra } as Stream
}

/** Newest first, like `git log --topo-order`. */
function graph(commits: GitGraphCommit[], tips: Record<string, string>, head = 'master'): GitBranchGraph {
  return { commits, tips, head, more: false }
}

const ids = (items: ReturnType<typeof laneTrack>['items']) => items.map(i => i.kind === 'commit' ? i.commit.hash : `task:${i.task.id}`)

describe('project map lanes', () => {
  // master: a ← b ← c ← d; stream rel cut from b: b ← r1 ← r2; task t1 off c, task t2 off a.
  const g = graph([
    commit('r2', ['r1'], 9), commit('d', ['c'], 8), commit('t1x', ['c'], 7), commit('r1', ['b'], 6),
    commit('c', ['b'], 5), commit('b', ['a'], 4), commit('t2x', ['a'], 3), commit('a', [], 2)
  ], { master: 'd', rel: 'r2', 'task/t1': 't1x', 'task/t2': 't2x' })

  it('draws the main stream\'s first-parent history older → newer with tasks after the commit they forked from', () => {
    const main = stream('main', { isMain: true, tasks: [task('t1', ws('task/t1', 'master')), task('plain'), task('t2', ws('task/t2', 'master'))] })
    const track = laneTrack(g, main)
    expect(track.branch).toBe('master')
    expect(track.projectFolder).toBe(true)
    expect(ids(track.items)).toEqual(['a', 'task:t2', 'b', 'c', 'task:t1', 'd', 'task:plain'])
    expect(track.newest?.hash).toBe('d')
    expect(track.ahead).toBeNull()
  })

  it('keeps only the newest commits, and puts tasks forked from older ones first', () => {
    const main = stream('main', { isMain: true, tasks: [task('t2', ws('task/t2', 'master'))] })
    expect(ids(laneTrack(g, main, 2).items)).toEqual(['task:t2', 'c', 'd'])
  })

  it('counts a worktree stream ahead of and behind its base, drawing only its own commits', () => {
    const rel = stream('rel', { workspace: ws('rel', 'master') })
    const track = laneTrack(g, rel)
    expect(ids(track.items)).toEqual(['r1', 'r2'])
    expect([track.ahead, track.behind, track.partial]).toEqual([2, 2, false])
    expect(aheadBehindLine(track, 'master')).toBe('2 ahead of master · 2 behind')
  })

  it('draws no commits for another project-folder stream, which shares main\'s checkout', () => {
    const side = stream('side', { tasks: [task('x')] })
    const track = laneTrack(g, side)
    expect(track.branch).toBe('master')
    expect(ids(track.items)).toEqual(['task:x'])
    expect(track.newest).toBeNull()
  })

  it('without a graph lists the tasks alone', () => {
    const track = laneTrack(null, stream('main', { isMain: true, tasks: [task('a'), task('b')] }))
    expect(track.branch).toBeNull()
    expect(ids(track.items)).toEqual(['task:a', 'task:b'])
  })

  it('marks counts that ran past the loaded graph', () => {
    const cut = graph([commit('r2', ['r1']), commit('d', ['c'])], { master: 'd', rel: 'r2' })
    const track = laneTrack(cut, stream('rel', { workspace: ws('rel', 'master') }))
    expect(track.partial).toBe(true)
    expect(aheadBehindLine(track, 'master')).toBe('1+ ahead of master · 1+ behind')
  })
})

describe('project map lines', () => {
  it('says how a stream stands against its base', () => {
    const base = { branch: 'x', projectFolder: false, items: [], partial: false, newest: null }
    expect(aheadBehindLine({ ...base, ahead: 0, behind: 0 }, 'master')).toBe('up to date with master')
    expect(aheadBehindLine({ ...base, ahead: 0, behind: 3 }, 'master')).toBe('3 behind master')
    expect(aheadBehindLine({ ...base, ahead: null, behind: null }, 'master')).toBeNull()
  })

  it('says how long a quiet lane has been quiet', () => {
    const now = new Date('2026-10-30T12:00:00Z').getTime()
    expect(quietFor('2026-10-30T08:00:00Z', now)).toBeNull()
    expect(quietFor('2026-10-29T08:00:00Z', now)).toBe('Quiet since yesterday')
    expect(quietFor('2026-10-24T08:00:00Z', now)).toBe('Quiet for 6 days')
    expect(quietFor('2026-06-01T08:00:00Z', now)).toBe('Quiet for 5 months')
    expect(quietFor(undefined, now)).toBeNull()
  })

  it('names the host', () => {
    expect(projectHostLabel({ id: 'p' } as Project)).toBe('This Mac')
    expect(projectHostLabel({ id: 'p', host: 's1' } as Project, 'hetzner-1')).toBe('hetzner-1')
    expect(projectHostLabel({ id: 'p', ssh: { host: 'box', port: 22, username: 'me', remoteDir: '' } } as Project)).toBe('me@box')
    expect(projectHostLabel({ id: 'p', shellCommand: { command: 'orb shell' } } as Project)).toBe('Custom shell')
    expect(projectHostLabel({ id: 'p', shellCommand: { command: 'orb shell' } } as Project, undefined, 'Orb')).toBe('Orb')
  })

  it('lays out recent weeks Monday first, ending today', () => {
    const counts = new Map([['2026-10-30', 3], ['2026-10-26', 1]])
    const weeks = recentWeeks(counts, new Date(2026, 9, 30, 15), 2)
    expect(weeks).toHaveLength(2)
    expect(weeks[0][0].iso).toBe('2026-10-19')
    expect(weeks[0]).toHaveLength(7)
    // Friday the 30th is the last day drawn.
    expect(weeks[1].map(d => d.iso)).toEqual(['2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30'])
    expect(weeks[1].map(d => d.count)).toEqual([1, 0, 0, 0, 3])
  })
})
