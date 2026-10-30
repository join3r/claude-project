import { describe, expect, it } from 'vitest'
import { setStreamCommandsInData, streamCommandsInData } from '../src/main/mobile/stream-commands'
import { streamRunCommands } from '../src/shared/stream-run'
import { type Project, type ProjectsData, type Stream } from '../src/shared/types'
import { fixtureProject } from './helpers/streams-fixtures'

const STAGING: Stream = {
  id: 's-050', name: '0.5.0', tasks: [],
  runCommands: [{ id: 'c-own-run', name: 'run', command: 'npm run dev -- --port 3001' }]
}

function data(extra: Partial<Project> = {}): ProjectsData {
  const projects = [
    fixtureProject({
      id: 'p1', name: 'api', directory: '/src/api', streams: [STAGING],
      runCommands: [{ id: 'c-run', name: 'run', command: 'npm run dev' }, { id: 'c-install', name: 'install', command: 'npm ci' }],
      ...extra
    }),
    fixtureProject({ id: 'hidden', hideFromMobile: true }),
    fixtureProject({ id: 'legacy', runCommand: 'make serve' })
  ]
  return { projects, tags: [], projectOrder: projects.map(p => p.id), pinnedItems: [] }
}

function project(result: ReturnType<typeof setStreamCommandsInData>, id = 'p1'): Project {
  if (!result.ok) throw new Error(result.message)
  return result.data.projects.find(p => p.id === id)!
}

let n = 0
const ids = () => `new${++n}`

describe('streamCommandsInData (SPEC.md §8.21)', () => {
  it('answers the project\'s own list, or a stream\'s with the project\'s as inherited', () => {
    expect(streamCommandsInData(data(), { projectId: 'p1' })).toEqual({
      ok: true,
      result: { commands: [{ id: 'c-run', name: 'run', command: 'npm run dev' }, { id: 'c-install', name: 'install', command: 'npm ci' }] }
    })
    expect(streamCommandsInData(data(), { projectId: 'p1', streamId: 's-050' })).toEqual({
      ok: true,
      result: {
        commands: [{ id: 'c-own-run', name: 'run', command: 'npm run dev -- --port 3001' }],
        inherited: [{ id: 'c-run', name: 'run', command: 'npm run dev' }, { id: 'c-install', name: 'install', command: 'npm ci' }]
      }
    })
    // Older data's single command reads as `run`; a stream of a project without commands has no `inherited`.
    expect(streamCommandsInData(data(), { projectId: 'legacy' })).toEqual({ ok: true, result: { commands: [{ id: 'run', name: 'run', command: 'make serve' }] } })
    const bare = data({ runCommands: undefined })
    expect(streamCommandsInData(bare, { projectId: 'p1', streamId: 's-050' })).toMatchObject({ ok: true, result: { commands: [expect.anything()] } })
    expect('inherited' in (streamCommandsInData(bare, { projectId: 'p1', streamId: 's-050' }) as { result: object }).result).toBe(false)
  })

  it('answers not-found for what the phone cannot see, and unsupported on a shell-command project', () => {
    expect(streamCommandsInData(data(), { projectId: 'nope' })).toMatchObject({ ok: false, code: 'not-found' })
    expect(streamCommandsInData(data(), { projectId: 'hidden' })).toMatchObject({ ok: false, code: 'not-found' })
    expect(streamCommandsInData(data(), { projectId: 'p1', streamId: 'gone' })).toMatchObject({ ok: false, code: 'not-found' })
    const shell = data({ shellCommand: { command: 'make' } as Project['shellCommand'] })
    expect(streamCommandsInData(shell, { projectId: 'p1' })).toMatchObject({ ok: false, code: 'unsupported' })
    expect(setStreamCommandsInData(shell, { projectId: 'p1', commands: [] })).toMatchObject({ ok: false, code: 'unsupported' })
  })
})

describe('setStreamCommandsInData (SPEC.md §8.21)', () => {
  it('replaces the project\'s list, keeping known ids and minting the rest', () => {
    const out = setStreamCommandsInData(data(), {
      projectId: 'p1',
      commands: [{ name: 'test', command: 'npm test' }, { id: 'c-run', name: 'run', command: 'pnpm dev' }, { id: 'c-elsewhere', name: 'lint', command: 'npm run lint' }]
    }, ids)
    expect(out).toMatchObject({ ok: true, changed: true })
    const p = project(out)
    expect(p.runCommands).toEqual([
      { id: 'new1', name: 'test', command: 'npm test' },
      { id: 'c-run', name: 'run', command: 'pnpm dev' },
      { id: 'new2', name: 'lint', command: 'npm run lint' }
    ])
    // The stream's own `run` still replaces the project's; the merged list is what the inbox sends.
    expect(streamRunCommands(p, p.streams.find(s => s.id === 's-050')).map(c => c.command)).toEqual(['npm test', 'npm run dev -- --port 3001', 'npm run lint'])
  })

  it('replaces or clears a stream\'s own list', () => {
    const out = setStreamCommandsInData(data(), { projectId: 'p1', streamId: 's-050', commands: [{ id: 'c-own-run', name: 'run', command: 'make dev' }, { name: 'seed', command: 'make seed' }] }, ids)
    const stream = project(out).streams.find(s => s.id === 's-050')!
    expect(stream.runCommands).toEqual([{ id: 'c-own-run', name: 'run', command: 'make dev' }, { id: expect.stringMatching(/^new/), name: 'seed', command: 'make seed' }])
    const cleared = project(setStreamCommandsInData(data(), { projectId: 'p1', streamId: 's-050', commands: [] }))
    expect('runCommands' in cleared.streams.find(s => s.id === 's-050')!).toBe(false)
    expect(project(setStreamCommandsInData(data(), { projectId: 'p1', commands: [] })).runCommands).toBeUndefined()
  })

  it('drops older data\'s single command, and reports no change for the same list', () => {
    const legacy = project(setStreamCommandsInData(data(), { projectId: 'legacy', commands: [{ id: 'run', name: 'run', command: 'make dev' }] }), 'legacy')
    expect(legacy.runCommand).toBeUndefined()
    expect(legacy.runCommands).toEqual([{ id: 'run', name: 'run', command: 'make dev' }])
    const start = data()
    expect(setStreamCommandsInData(start, { projectId: 'p1', commands: [{ id: 'c-run', name: 'run', command: 'npm run dev' }, { id: 'c-install', name: 'install', command: 'npm ci' }] }))
      .toEqual({ ok: true, data: start, changed: false })
  })

  it('gives a repeated id to one command only', () => {
    const p = project(setStreamCommandsInData(data(), { projectId: 'p1', commands: [{ id: 'c-run', name: 'a', command: 'x' }, { id: 'c-run', name: 'b', command: 'y' }] }, ids))
    expect(p.runCommands?.map(c => c.id)).toEqual(['c-run', expect.stringMatching(/^new/)])
  })
})
