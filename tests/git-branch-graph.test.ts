import { execFileSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readBranchGraph } from '../src/main/git-branch-graph'
import { layoutGraph } from '../src/renderer/components/gitGraphLayout'
import type { GitGraphCommit } from '../src/shared/types'

const c = (hash: string, ...parents: string[]): GitGraphCommit => ({ hash, parents, subject: hash, author: 'a', isoDate: '2026-10-29T00:00:00Z' })

describe('layoutGraph', () => {
  it('keeps a straight history in one lane', () => {
    const { rows, width } = layoutGraph([c('c', 'b'), c('b', 'a'), c('a')])
    expect(width).toBe(1)
    expect(rows.map(r => r.column)).toEqual([0, 0, 0])
    expect(rows[2].segments).toEqual([{ from: 0, to: 0, part: 'top', lane: 0 }])
  })

  it('opens a lane for a merged branch and closes it where the branch forked', () => {
    // m merges s2 into b; s1 forked off a.
    const { rows, width } = layoutGraph([c('m', 'b', 's2'), c('s2', 's1'), c('b', 'a'), c('s1', 'a'), c('a')])
    expect(width).toBe(2)
    expect(rows[0]).toMatchObject({ column: 0, merge: true })
    expect(rows[0].segments).toContainEqual({ from: 0, to: 1, part: 'bottom', lane: 1 })
    expect(rows[1].column).toBe(1)
    // b's lane passes through s2's row, and s2's lane through b's.
    expect(rows[1].segments).toContainEqual({ from: 0, to: 0, part: 'full', lane: 0 })
    expect(rows[2].segments).toContainEqual({ from: 1, to: 1, part: 'full', lane: 1 })
    // At the fork both lanes come into a.
    expect(rows[4].column).toBe(0)
    expect(rows[4].segments).toEqual(expect.arrayContaining([
      { from: 0, to: 0, part: 'top', lane: 0 },
      { from: 1, to: 0, part: 'top', lane: 1 }
    ]))
  })

  it('starts a branch tip in a free lane', () => {
    const { rows } = layoutGraph([c('t', 'a'), c('b', 'a'), c('a')])
    expect(rows.map(r => r.column)).toEqual([0, 1, 0])
    expect(rows[1].segments.some(s => s.part === 'top')).toBe(false)
  })

  it('keeps a lane drawn through a merge whose second parent it already waits for', () => {
    // x and m both have p as a parent; p's lane exists before m's row.
    const { rows } = layoutGraph([c('x', 'p'), c('m', 'y', 'p'), c('y', 'p'), c('p')])
    expect(rows[1].segments).toContainEqual({ from: 0, to: 0, part: 'full', lane: 0 })
    expect(rows[1].segments).toContainEqual({ from: 1, to: 0, part: 'bottom', lane: 0 })
  })
})

describe('readBranchGraph', () => {
  let repo: string
  const git = (...args: string[]): string => execFileSync('git', args, { cwd: repo, encoding: 'utf-8' }).trim()
  const commit = (msg: string) => git('commit', '-q', '--allow-empty', '-m', msg)

  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'branch-graph-'))
    git('init', '-q', '-b', 'main')
    git('config', 'user.email', 't@t')
    git('config', 'user.name', 't')
    commit('root')
  })
  afterEach(() => fs.rmSync(repo, { recursive: true, force: true }))

  it('reads the checked-out branch and the asked-for ones, dropping what is not a local branch', async () => {
    git('branch', 'stream')
    git('checkout', '-q', 'stream')
    commit('on stream')
    git('checkout', '-q', 'main')
    commit('on main')
    git('branch', 'unlisted')
    git('checkout', '-q', 'unlisted')
    commit('hidden')
    git('checkout', '-q', 'main')

    const graph = await readBranchGraph(repo, ['stream', 'gone', '--all', 'HEAD~1'], 50)
    expect(graph.head).toBe('main')
    expect(Object.keys(graph.tips).sort()).toEqual(['main', 'stream'])
    expect(graph.commits.map(x => x.subject).sort()).toEqual(['on main', 'on stream', 'root'])
    expect(graph.more).toBe(false)
  })

  it('shows a merged stream as a merge commit after its branch is deleted', async () => {
    git('checkout', '-q', '-b', 'stream')
    commit('work')
    git('checkout', '-q', 'main')
    commit('main moved')
    git('merge', '-q', '--no-ff', '-m', 'Merge stream "s" (stream) into main', 'stream')
    git('branch', '-D', 'stream')

    const graph = await readBranchGraph(repo, ['stream'], 50)
    expect(graph.tips).toEqual({ main: git('rev-parse', 'main') })
    expect(graph.commits[0]).toMatchObject({ subject: 'Merge stream "s" (stream) into main' })
    expect(graph.commits[0].parents).toHaveLength(2)
    expect(layoutGraph(graph.commits).width).toBe(2)
  })

  it('stops at the limit and says there is more', async () => {
    commit('two')
    commit('three')
    const graph = await readBranchGraph(repo, [], 2)
    expect(graph.commits.map(x => x.subject)).toEqual(['three', 'two'])
    expect(graph.more).toBe(true)
  })
})
