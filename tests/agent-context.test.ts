import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { agentContextForTab, buildAgentContext, sharedLinksIn } from '../src/main/agent-context'
import { fixtureProject } from './helpers/streams-fixtures'
import type { Project, Stream, WorkspaceConfig } from '../src/shared/types'

const streamWs: WorkspaceConfig = { worktreePath: '/repo/.worktrees/0.7.0', branchName: '0.7.0', baseBranch: 'main', relativeProjectPath: '' }
const ownWs: WorkspaceConfig = { worktreePath: '/repo/.worktrees/0.7.0--fix', branchName: '0.7.0--fix', baseBranch: '0.7.0', relativeProjectPath: '' }
const project = { name: 'Stem', directory: '/repo' }
const hook = { port: 4321, token: 'tok', tabId: 'tab-1' }

describe('buildAgentContext', () => {
  it('tells a task in its own worktree that DevTool lands it, and how to ask', () => {
    const note = buildAgentContext({
      project,
      stream: { name: '0.7.0', workspace: streamWs },
      task: { name: 'Fix', workspace: ownWs },
      dir: ownWs.worktreePath,
      hook
    })
    expect(note).toContain('`0.7.0--fix`, cut from `0.7.0`')
    expect(note).toContain('merges `0.7.0` into `main`')
    expect(note).toContain('Do not merge, rebase onto, cherry-pick, pull or switch branches yourself')
    expect(note).toContain("http://127.0.0.1:4321/hook/land -H 'X-Tab-Id: tab-1' -H 'X-Devtool-Token: tok'")
    expect(note).toContain('/hook/update')
    expect(note).toContain('"Merge to main"')
  })

  it('lands a main task into the project folder and offers no stream close', () => {
    const note = buildAgentContext({
      project,
      stream: { name: 'main', isMain: true },
      task: { name: 'Fix', workspace: { ...ownWs, branchName: 'master--fix', baseBranch: 'master' } },
      dir: ownWs.worktreePath
    })
    expect(note).toContain('cut from `master` (checked out in the project folder `/repo`)')
    expect(note).not.toContain('Closing the stream')
    expect(note).not.toContain('/hook/land')
  })

  it('tells a task sharing the stream worktree that it commits onto the stream', () => {
    const note = buildAgentContext({ project, stream: { name: '0.7.0', workspace: streamWs }, task: { name: 'Old' }, dir: streamWs.worktreePath, hook })
    expect(note).toContain('your commits go straight onto `0.7.0`')
    expect(note).not.toContain('/hook/land')
  })

  it('warns about the project folder and shared links', () => {
    const note = buildAgentContext({
      project,
      stream: { name: 'main', isMain: true },
      task: { name: 'Quick' },
      dir: '/repo',
      links: [{ entry: 'node_modules', target: '/repo/node_modules' }]
    })
    expect(note).toContain('This is the project folder itself')
    expect(note).toContain('`node_modules` here is a symlink to `/repo/node_modules`')
    expect(note).toContain('stop only processes you started')
  })
})

describe('sharedLinksIn', () => {
  let dir: string
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-context-')) })
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

  it('lists configured symlinks that are links, skipping real folders and missing ones', () => {
    const shared = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-context-shared-'))
    try {
      fs.mkdirSync(path.join(dir, '.devtool'))
      fs.writeFileSync(path.join(dir, '.devtool', 'worktree.json'), JSON.stringify({ symlink: ['node_modules', 'vendor', 'gone'] }))
      fs.symlinkSync(shared, path.join(dir, 'node_modules'))
      fs.mkdirSync(path.join(dir, 'vendor'))
      expect(sharedLinksIn(dir)).toEqual([{ entry: 'node_modules', target: fs.realpathSync(shared) }])
    } finally {
      fs.rmSync(shared, { recursive: true, force: true })
    }
  })
})

describe('agentContextForTab', () => {
  const tab = { id: 'tab-1', type: 'claude' as const, title: 'Claude' }

  it('finds the task owning the tab, and gives the land call only to an own worktree', () => {
    const stream: Stream = { id: 's1', name: '0.7.0', workspace: streamWs, taskWorktrees: true, tasks: [{ id: 't1', name: 'Fix', workspace: ownWs, panes: [{ tabs: [tab], activeTabId: 'tab-1', width: 1 }] }] }
    const p: Project = { ...fixtureProject({ id: 'p1', name: 'Stem', directory: '/repo' }), streams: [stream] }
    const note = agentContextForTab([p], 'tab-1', { port: 1, token: 't' })
    expect(note).toContain('task "Fix"')
    expect(note).toContain('/hook/land')
    expect(agentContextForTab([p], 'nope', { port: 1, token: 't' })).toBeNull()
    expect(agentContextForTab([{ ...p, ssh: { host: 'h', username: 'u', port: 22, remoteDir: '/r' } as Project['ssh'] }], 'tab-1')).toBeNull()
  })
})
