import { describe, expect, it } from 'vitest'
import { queuedPromptForRun, updateQueueInData } from '../src/main/mobile/queue'
import { mainStreamId, type Project, type ProjectsData, type Stream } from '../src/shared/types'
import { fixtureProject } from './helpers/streams-fixtures'

const BUGS: Stream = { id: 's-bugs', name: 'bugfixes', tasks: [] }

function data(extra: Partial<Project> = {}): ProjectsData {
  const projects = [
    fixtureProject({
      id: 'p1', name: 'api', directory: '/src/api', streams: [BUGS],
      promptQueue: [{ id: 'q1', text: 'first' }, { id: 'q2', text: 'second', streamId: 's-bugs' }],
      ...extra
    }),
    fixtureProject({ id: 'hidden', hideFromMobile: true, promptQueue: [{ id: 'h1', text: 'secret' }] })
  ]
  return { projects, tags: [], projectOrder: projects.map(p => p.id), pinnedItems: [] }
}

function p1(result: ReturnType<typeof updateQueueInData>): Project {
  if (!result.ok) throw new Error(result.message)
  return result.data.projects[0]
}

describe('updateQueueInData (SPEC.md §8.16)', () => {
  it('adds at the end, keeping streamId only off main', () => {
    const toMain = updateQueueInData(data(), { projectId: 'p1', action: 'add', text: 'third', streamId: mainStreamId('p1') }, () => 'q3')
    expect(toMain).toMatchObject({ ok: true, changed: true, itemId: 'q3' })
    expect(p1(toMain).promptQueue?.at(-1)).toEqual({ id: 'q3', text: 'third' })
    const toBugs = updateQueueInData(data(), { projectId: 'p1', action: 'add', text: 'fourth', streamId: 's-bugs' }, () => 'q4')
    expect(p1(toBugs).promptQueue?.at(-1)).toEqual({ id: 'q4', text: 'fourth', streamId: 's-bugs' })
  })

  it('edits, removes and moves a queued prompt', () => {
    expect(p1(updateQueueInData(data(), { projectId: 'p1', action: 'edit', itemId: 'q1', text: 'first, reworded' })).promptQueue?.[0].text).toBe('first, reworded')
    expect(p1(updateQueueInData(data(), { projectId: 'p1', action: 'remove', itemId: 'q1' })).promptQueue?.map(i => i.id)).toEqual(['q2'])
    expect(p1(updateQueueInData(data(), { projectId: 'p1', action: 'move', itemId: 'q2', toIndex: 0 })).promptQueue?.map(i => i.id)).toEqual(['q2', 'q1'])
  })

  it('switches a stream\'s auto-run, and reports no change when it already is', () => {
    const on = updateQueueInData(data(), { projectId: 'p1', action: 'auto-run', streamId: 's-bugs', on: true })
    expect(on).toMatchObject({ ok: true, changed: true })
    expect(p1(on).streams.find(s => s.id === 's-bugs')?.promptQueueAutoRun).toBe(true)
    const start = data()
    expect(updateQueueInData(start, { projectId: 'p1', action: 'auto-run', streamId: 's-bugs', on: false })).toEqual({ ok: true, data: start, changed: false })
    expect(updateQueueInData(start, { projectId: 'p1', action: 'move', itemId: 'q1', toIndex: 0 })).toEqual({ ok: true, data: start, changed: false })
  })

  it('answers not-found for what the phone cannot see, and unsupported on a shell-command project', () => {
    expect(updateQueueInData(data(), { projectId: 'nope', action: 'remove', itemId: 'q1' })).toMatchObject({ ok: false, code: 'not-found' })
    expect(updateQueueInData(data(), { projectId: 'hidden', action: 'remove', itemId: 'h1' })).toMatchObject({ ok: false, code: 'not-found' })
    expect(updateQueueInData(data(), { projectId: 'p1', action: 'edit', itemId: 'gone', text: 'x' })).toMatchObject({ ok: false, code: 'not-found' })
    expect(updateQueueInData(data(), { projectId: 'p1', action: 'add', text: 'x', streamId: 'gone' })).toMatchObject({ ok: false, code: 'not-found' })
    expect(updateQueueInData(data(), { projectId: 'p1', action: 'auto-run', streamId: 'gone', on: true })).toMatchObject({ ok: false, code: 'not-found' })
    const shell = data({ shellCommand: { command: 'make' } as Project['shellCommand'] })
    expect(updateQueueInData(shell, { projectId: 'p1', action: 'add', text: 'x' })).toMatchObject({ ok: false, code: 'unsupported' })
  })
})

describe('queuedPromptForRun (SPEC.md §8.16)', () => {
  it('passes a queued prompt of a visible project and refuses the rest', () => {
    expect(queuedPromptForRun(data(), { projectId: 'p1', itemId: 'q2' })).toEqual({ ok: true })
    expect(queuedPromptForRun(data(), { projectId: 'p1', itemId: 'gone' })).toMatchObject({ ok: false, code: 'not-found' })
    expect(queuedPromptForRun(data(), { projectId: 'hidden', itemId: 'h1' })).toMatchObject({ ok: false, code: 'not-found' })
  })
})
