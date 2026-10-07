import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { Stream, TabStatusValue } from '../src/shared/types'
import {
  isTaskWorking,
  streamCloseQuestion,
  taskCloseQuestion,
  worktreePreflight,
  worktreeRemovalFor
} from '../src/renderer/components/sidebar/closeRules'
import {
  buildRemoteSessionCopyScript,
  copyLocalSession,
  localPiSessionsRoot,
  piSessionDirName
} from '../src/main/agent-session-move'
import { claudeProjectSlug } from '../src/main/ipc/agents'
import { fixtureTask } from './helpers/streams-fixtures'
import { Storage } from '../src/main/storage'

const agentTask = (id: string, name = id) => fixtureTask({
  id,
  name,
  tabs: { left: [{ id: `${id}-agent`, type: 'claude', title: 'Claude Code' }, { id: `${id}-sh`, type: 'terminal', title: 'zsh' }] }
})
const statuses = (map: Record<string, TabStatusValue>) => (tabId: string) => map[tabId]
const workspace = { worktreePath: '/repo/.worktrees/rel', branchName: 'rel-0.5', baseBranch: 'main', relativeProjectPath: '' }

describe('close confirm rules', () => {
  it('asks before closing a task only while its agent works', () => {
    const task = agentTask('t', 'Fix it')
    expect(taskCloseQuestion(task, statuses({}))).toBeNull()
    expect(taskCloseQuestion(task, statuses({ 't-agent': 'attention' }))).toBeNull()
    // A busy terminal is not a working agent.
    expect(taskCloseQuestion(task, statuses({ 't-sh': 'working' }))).toBeNull()
    expect(isTaskWorking(task, statuses({ 't-agent': 'working' }))).toBe(true)
    expect(taskCloseQuestion(task, statuses({ 't-agent': 'working' }))).toMatch(/^"Fix it" is still working/)
  })

  it('asks before closing a stream while any of its tasks works, never for main', () => {
    const stream: Stream = { id: 's', name: '0.5.0', workspace, tasks: [agentTask('a', 'A'), agentTask('b', 'B')] }
    expect(streamCloseQuestion(stream, statuses({}))).toBeNull()
    expect(streamCloseQuestion(stream, statuses({ 'b-agent': 'working' }))).toMatch(/^"B" is still working[\s\S]*Close stream "0\.5\.0"/)
    expect(streamCloseQuestion(stream, statuses({ 'a-agent': 'working', 'b-agent': 'working' }))).toMatch(/^"A", "B" are still working/)
    expect(streamCloseQuestion({ ...stream, isMain: true }, statuses({ 'a-agent': 'working' }))).toBeNull()
  })

  it('maps the worktree pre-flight to remove quietly, force, or ask', () => {
    expect(worktreePreflight({ status: 'ok' }, workspace)).toEqual({ kind: 'removed' })
    expect(worktreePreflight({ status: 'invalid-worktree', reason: 'x' }, workspace)).toEqual({ kind: 'force' })
    expect(worktreePreflight({ status: 'uncommitted' }, workspace)).toMatchObject({ kind: 'ask', message: expect.stringMatching(/uncommitted/) })
    expect(worktreePreflight({ status: 'unmerged', baseBranch: 'develop' }, workspace))
      .toMatchObject({ kind: 'ask', message: expect.stringMatching(/"rel-0\.5" has commits not merged into "develop"/) })
    expect(worktreePreflight({ status: 'uncommitted-and-unmerged' }, workspace)).toMatchObject({ kind: 'ask' })
    expect(worktreePreflight({ status: 'check-failed', reason: 'ssh down' }, workspace))
      .toMatchObject({ kind: 'ask', message: expect.stringMatching(/ssh down/) })
  })

  it('turns the choice into the forced removal', () => {
    expect(worktreeRemovalFor('keep-branch')).toEqual({ keepBranch: true })
    expect(worktreeRemovalFor('discard')).toEqual({ keepBranch: false })
    expect(worktreeRemovalFor('cancel')).toBeNull()
  })
})

describe('session copy on a task move', () => {
  let home: string
  const id = '0123abcd-0000-4000-8000-00000000beef'
  const roots = () => ({ claudeProjects: path.join(home, '.claude', 'projects'), piSessions: path.join(home, '.pi', 'agent', 'sessions') })

  beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'devtool-move-')) })
  afterEach(() => { fs.rmSync(home, { recursive: true, force: true }) })

  it('copies a Claude session (and its sidecar folder) into the new directory’s project folder', () => {
    const from = path.join(roots().claudeProjects, claudeProjectSlug('/repo'))
    fs.mkdirSync(path.join(from, id, 'subagents'), { recursive: true })
    fs.writeFileSync(path.join(from, `${id}.jsonl`), '{"a":1}\n')
    fs.writeFileSync(path.join(from, id, 'subagents', 'x.jsonl'), 'sub')

    expect(copyLocalSession({ kind: 'claude', sessionId: id }, '/repo', '/repo/.worktrees/rel', roots())).toBe('copied')
    const to = path.join(roots().claudeProjects, claudeProjectSlug('/repo/.worktrees/rel'))
    expect(fs.readFileSync(path.join(to, `${id}.jsonl`), 'utf8')).toBe('{"a":1}\n')
    expect(fs.readFileSync(path.join(to, id, 'subagents', 'x.jsonl'), 'utf8')).toBe('sub')
    // The source stays, and a second move never overwrites.
    expect(fs.existsSync(path.join(from, `${id}.jsonl`))).toBe(true)
    fs.writeFileSync(path.join(to, `${id}.jsonl`), 'newer')
    expect(copyLocalSession({ kind: 'claude', sessionId: id }, '/repo', '/repo/.worktrees/rel', roots())).toBe('exists')
    expect(fs.readFileSync(path.join(to, `${id}.jsonl`), 'utf8')).toBe('newer')
  })

  it('finds a Claude session filed under another folder', () => {
    const elsewhere = path.join(roots().claudeProjects, '-somewhere-else')
    fs.mkdirSync(elsewhere, { recursive: true })
    fs.writeFileSync(path.join(elsewhere, `${id}.jsonl`), 'x')
    expect(copyLocalSession({ kind: 'claude', sessionId: id }, '/repo', '/wt', roots())).toBe('copied')
    expect(copyLocalSession({ kind: 'claude', sessionId: 'feedface-0000' }, '/repo', '/wt', roots())).toBe('missing')
    expect(copyLocalSession({ kind: 'claude', sessionId: '../../etc' }, '/repo', '/wt', roots())).toBe('missing')
  })

  it('copies a Pi session into the new directory’s session folder', () => {
    expect(piSessionDirName('/Users/me/repo')).toBe('--Users-me-repo--')
    const from = path.join(roots().piSessions, piSessionDirName('/repo'))
    fs.mkdirSync(from, { recursive: true })
    fs.writeFileSync(path.join(from, `2026-10-07T10-00-00-000Z_${id}.jsonl`), 'pi')
    expect(copyLocalSession({ kind: 'pi', sessionId: id }, '/repo', '/wt', roots())).toBe('copied')
    const to = path.join(roots().piSessions, piSessionDirName('/wt'))
    expect(fs.readdirSync(to)).toEqual([`2026-10-07T10-00-00-000Z_${id}.jsonl`])
    expect(copyLocalSession({ kind: 'pi', sessionId: id }, '/repo', '/wt', roots())).toBe('exists')
  })

  it('honours Pi’s agent and session dir overrides', () => {
    expect(localPiSessionsRoot({}, '/h')).toBe(path.join('/h', '.pi', 'agent', 'sessions'))
    expect(localPiSessionsRoot({ PI_CODING_AGENT_DIR: '/x/agent' }, '/h')).toBe(path.join('/x/agent', 'sessions'))
    expect(localPiSessionsRoot({ PI_CODING_AGENT_SESSION_DIR: '/s' }, '/h')).toBe('/s')
  })

  it('builds a remote copy script that quotes paths and checks directories', () => {
    const script = buildRemoteSessionCopyScript(
      [{ kind: 'claude', sessionId: id }, { kind: 'pi', sessionId: id }, { kind: 'claude', sessionId: '$(rm -rf)' }],
      "/srv/it's",
      '/srv/wt',
      ['/srv/wt/src']
    )
    expect(script).toContain(`${id}.jsonl`)
    expect(script).toContain(`'--srv-it'\\''s--'`)
    expect(script).not.toContain('rm -rf')
    expect(script).toContain("if [ -d '/srv/wt/src' ]; then echo 1; else echo 0; fi")
  })
})

describe('retired workspaceDraft', () => {
  it('is dropped from stored tasks on load, idempotently', () => {
    const task = { ...fixtureTask({ id: 't' }), workspaceDraft: { baseBranch: 'main' } }
    const raw = {
      projects: [{ id: 'p', name: 'p', directory: '/p', streams: [{ id: 'main-p', name: 'main', isMain: true, tasks: [task] }] }],
      tags: [], projectOrder: ['p'], pinnedItems: []
    }
    const once = Storage.normalizeProjectsData(raw as unknown as Record<string, unknown>)
    expect(once.projects[0].streams[0].tasks[0]).not.toHaveProperty('workspaceDraft')
    const twice = Storage.normalizeProjectsData(once as unknown as Record<string, unknown>)
    expect(twice).toEqual(once)
  })
})
