import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { AutopilotRunner, landingStopReason, type AutopilotDeps } from '../src/main/autopilot'
import { LocalGitRunner } from '../src/main/git-runner'
import { codexReviewPrompt, parseCodexVerdict, type CodexReview } from '../src/main/codex-review'
import { canonicalFilePath } from '../src/main/workspace-manager'
import type { AgentActivity } from '../src/shared/agent-activity'
import { autopilotBusy, autopilotLanded, autopilotNeedsYou, autopilotSupported } from '../src/shared/autopilot'
import { findTaskInProject, reopenedTask } from '../src/shared/streams'
import type { Project, ProjectsData, Stream, TabStatusValue, Task, TaskAutopilot, TaskLandingResult, WorkspaceConfig } from '../src/shared/types'
import { fixtureProject, fixtureTask } from './helpers/streams-fixtures'

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' })
}

const chatTab = (id: string) => ({ id, type: 'claude-chat' as const, title: 'Claude', sessionId: `s-${id}` })

/** The registry's statuses and activities, with its change feed. */
function fakeActivity() {
  const statuses = new Map<string, TabStatusValue>()
  const activities = new Map<string, AgentActivity>()
  const listeners = new Set<(tabId: string) => void>()
  return {
    statusOf: (tabId: string) => statuses.get(tabId) ?? null,
    activityOf: (tabId: string) => activities.get(tabId) ?? null,
    subscribe(listener: (tabId: string) => void) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    set(tabId: string, status: TabStatusValue, activity?: Partial<AgentActivity>) {
      statuses.set(tabId, status)
      if (activity) activities.set(tabId, { subagents: 0, compacting: false, updatedAt: 0, ...activity })
      listeners.forEach(listener => listener(tabId))
    }
  }
}

const tick = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms))

describe('AutopilotRunner', () => {
  let repo: string
  let own: WorkspaceConfig
  let data: ProjectsData
  let projectListeners: Set<() => void>
  let activity: ReturnType<typeof fakeActivity>
  let reviews: CodexReview[]
  let reviewCalls: { cwd: string; prompt: string }[]
  let sent: string[]
  let landCalls: { summary?: string }[]
  let landResult: TaskLandingResult
  let fixResult: TaskLandingResult
  let archived: string[]
  let runner: AutopilotRunner

  function setTask(autopilot: TaskAutopilot, options: { ownWorktree?: boolean } = {}): void {
    const task: Task = {
      ...fixtureTask({ id: 't1', name: 'Fix the login bug', tabs: { left: [chatTab('tab-1')] }, ...(options.ownWorktree === false ? {} : { ownWorkspace: own }) }),
      autopilot,
      lastInteractedAt: 1
    }
    // Without a worktree of its own the task works in the project folder, in a plain stream.
    const stream: Stream = options.ownWorktree === false
      ? { id: 'stream-r', name: 'Release', tasks: [task] }
      : {
          id: 'stream-r',
          name: 'Release',
          workspace: { worktreePath: repo, branchName: 'master', baseBranch: 'master', relativeProjectPath: '' },
          taskWorktrees: true,
          tasks: [task]
        }
    data = { projects: [fixtureProject({ id: 'p1', directory: repo, streams: [stream] })], tags: [], projectOrder: ['p1'], pinnedItems: [] }
  }

  function taskOf(): Task | undefined {
    return findTaskInProject(data.projects[0], 't1')
  }

  function make(overrides: Partial<AutopilotDeps> = {}): AutopilotRunner {
    runner = new AutopilotRunner({
      peek: () => data,
      commit: (next) => {
        data = next
        projectListeners.forEach(listener => listener())
      },
      subscribeProjects: (listener) => {
        projectListeners.add(listener)
        return () => { projectListeners.delete(listener) }
      },
      statusOf: activity.statusOf,
      activityOf: activity.activityOf,
      subscribe: activity.subscribe,
      runner: new LocalGitRunner(),
      review: async (cwd, prompt) => {
        reviewCalls.push({ cwd, prompt })
        return reviews.shift() ?? { status: 'clean' }
      },
      sendToAgent: async (_project, _task, _tab, text) => { sent.push(text) },
      landing: {
        landTask: async (_projectId, _taskId, options) => {
          landCalls.push({ summary: options?.summary })
          return landResult
        },
        fixWithAgent: async () => fixResult,
        isBusy: () => false
      },
      archiveTask: async (_project, task) => { archived.push(task.id) },
      log: () => {},
      now: () => 1000,
      settleMs: 5,
      ...overrides
    })
    return runner
  }

  /** Autopilot running, then the task fired with the chip (as a window files it). */
  function startWith(autopilot: TaskAutopilot, options: { ownWorktree?: boolean } = {}, overrides: Partial<AutopilotDeps> = {}): void {
    data = { projects: [], tags: [], projectOrder: [], pinnedItems: [] }
    make(overrides).start()
    setTask(autopilot, options)
    projectListeners.forEach(listener => listener())
  }

  /** One turn of Claude's: working, then idle, then the settle and whatever Autopilot does. */
  async function turn(answer = 'Fixed the login bug.'): Promise<void> {
    const before = { autopilot: taskOf()?.autopilot, lands: landCalls.length, sent: sent.length, archived: archived.length }
    activity.set('tab-1', 'working')
    activity.set('tab-1', null, { lastAnswer: answer })
    // Until Autopilot has acted on the turn (git and the fakes take a moment under load), or 2s.
    const deadline = Date.now() + 2000
    await tick(20)
    while (Date.now() < deadline) {
      const current = taskOf()?.autopilot
      const acted = landCalls.length !== before.lands || sent.length !== before.sent || archived.length !== before.archived
        || current?.phase === 'stopped' || (current !== before.autopilot && current?.phase !== 'reviewing')
      if (acted) break
      await tick(10)
    }
    await tick(10)
  }

  beforeEach(() => {
    repo = canonicalFilePath(fs.mkdtempSync(path.join(os.tmpdir(), 'autopilot-')))
    execFileSync('git', ['init', '-q', '-b', 'master', repo])
    git(repo, 'config', 'user.email', 'test@example.com')
    git(repo, 'config', 'user.name', 'Test')
    git(repo, 'config', 'commit.gpgsign', 'false')
    fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n')
    fs.writeFileSync(path.join(repo, '.gitignore'), '.worktrees/\n')
    git(repo, 'add', '-A')
    git(repo, 'commit', '-q', '-m', 'init')
    const worktree = path.join(repo, '.worktrees', 'task')
    git(repo, 'worktree', 'add', '-q', worktree, '-b', 'master--t1', 'master')
    own = { worktreePath: canonicalFilePath(worktree), branchName: 'master--t1', baseBranch: 'master', relativeProjectPath: '' }
    projectListeners = new Set()
    activity = fakeActivity()
    reviews = []
    reviewCalls = []
    sent = []
    landCalls = []
    landResult = { status: 'landed' }
    fixResult = { status: 'fixing' }
    archived = []
  })

  afterEach(() => {
    runner?.dispose()
    fs.rmSync(repo, { recursive: true, force: true })
  })

  it('lands the task when the turn ends with files changed, with Claude\'s answer as the commit body', async () => {
    startWith({ phase: 'working' })
    fs.writeFileSync(path.join(own.worktreePath, 'b.txt'), 'new\n')
    await turn()
    expect(landCalls).toEqual([{ summary: 'Fixed the login bug.' }])
    expect(taskOf()?.autopilot?.phase).toBe('landing')
    expect(reviewCalls).toHaveLength(0)
  })

  it('counts the task\'s commits too, not only what is uncommitted', async () => {
    startWith({ phase: 'working' })
    fs.writeFileSync(path.join(own.worktreePath, 'b.txt'), 'new\n')
    git(own.worktreePath, 'add', '-A')
    git(own.worktreePath, 'commit', '-q', '-m', 'agent')
    await turn()
    expect(landCalls).toHaveLength(1)
  })

  it('hands the task back when no files changed', async () => {
    startWith({ phase: 'working' })
    // DevTool's hooks file is not the task's work.
    fs.mkdirSync(path.join(own.worktreePath, '.claude'))
    fs.writeFileSync(path.join(own.worktreePath, '.claude', 'settings.local.json'), '{}')
    await turn()
    expect(landCalls).toHaveLength(0)
    expect(taskOf()?.autopilot).toMatchObject({ phase: 'stopped', reason: 'No files changed', stoppedAt: 1000 })
    expect(autopilotNeedsYou(taskOf()!)).toBe(true)
  })

  it('sends Codex\'s findings to Claude once, reviews again, then lands', async () => {
    reviews = [{ status: 'findings', text: '- a.txt:1 is wrong' }, { status: 'clean' }]
    startWith({ phase: 'working', review: true })
    fs.writeFileSync(path.join(own.worktreePath, 'a.txt'), 'two\n')
    await turn()
    expect(reviewCalls).toHaveLength(1)
    expect(reviewCalls[0].cwd).toBe(own.worktreePath)
    expect(reviewCalls[0].prompt).toContain('git diff ')
    expect(sent).toHaveLength(1)
    expect(sent[0]).toContain('- a.txt:1 is wrong')
    expect(taskOf()?.autopilot).toMatchObject({ phase: 'fixing', reviews: 1 })
    expect(landCalls).toHaveLength(0)

    await turn('Fixed it.')
    expect(reviewCalls).toHaveLength(2)
    expect(landCalls).toEqual([{ summary: 'Fixed it.' }])
  })

  it('stops when Codex is still unhappy after the fix round', async () => {
    reviews = [{ status: 'findings', text: 'one' }, { status: 'findings', text: 'still broken' }]
    startWith({ phase: 'working', review: true })
    fs.writeFileSync(path.join(own.worktreePath, 'a.txt'), 'two\n')
    await turn()
    await turn()
    expect(sent).toHaveLength(1)
    expect(landCalls).toHaveLength(0)
    expect(taskOf()?.autopilot).toMatchObject({ phase: 'stopped', reason: 'Codex still has findings: still broken' })
  })

  it('stops when Codex can\'t run', async () => {
    reviews = [{ status: 'failed', error: 'Codex isn\'t installed' }]
    startWith({ phase: 'working', review: true })
    fs.writeFileSync(path.join(own.worktreePath, 'a.txt'), 'two\n')
    await turn()
    expect(taskOf()?.autopilot?.reason).toBe('Codex couldn\'t review: Codex isn\'t installed')
  })

  it('a question, a permission or a failed turn hands the task back', async () => {
    startWith({ phase: 'working' })
    activity.set('tab-1', 'working')
    activity.set('tab-1', 'attention', { waiting: { kind: 'error', label: 'API overloaded', since: 1 } })
    expect(taskOf()?.autopilot).toMatchObject({ phase: 'stopped', reason: 'The turn failed: API overloaded' })
  })

  it('Stop in the chat hands the task back', () => {
    startWith({ phase: 'working' })
    runner.interrupted('tab-1')
    expect(taskOf()?.autopilot?.reason).toBe('You stopped it')
  })

  it('a conflict goes to the agent; a landing that still fails after its fix stops the run', async () => {
    landResult = { status: 'conflict', files: ['a.txt'] }
    startWith({ phase: 'working' })
    fs.writeFileSync(path.join(own.worktreePath, 'b.txt'), 'new\n')
    await turn()
    expect(taskOf()?.autopilot?.phase).toBe('landing')
    // The fixing agent's own turn doesn't move Autopilot on.
    await turn()
    expect(landCalls).toHaveLength(1)
    runner.landingResumed('p1', 't1', 'close', { status: 'conflict', files: ['a.txt'] })
    expect(taskOf()?.autopilot).toMatchObject({ phase: 'stopped', reason: 'Conflicts with Release the agent couldn\'t resolve' })
  })

  it('a blocked landing stops the run', async () => {
    landResult = { status: 'blocked', files: ['a.txt'], message: 'x' }
    startWith({ phase: 'working' })
    fs.writeFileSync(path.join(own.worktreePath, 'b.txt'), 'new\n')
    await turn()
    expect(taskOf()?.autopilot?.reason).toBe('Release has local changes in the way')
  })

  it('a task with no worktree of its own diffs against where its folder was, then just closes', async () => {
    startWith({ phase: 'working' }, { ownWorktree: false })
    await tick(20)
    const head = git(repo, 'rev-parse', 'HEAD').trim()
    expect(taskOf()?.autopilot?.base).toBe(head)
    // The agent commits in the folder: still the task's work.
    fs.writeFileSync(path.join(repo, 'b.txt'), 'new\n')
    git(repo, 'add', '-A')
    git(repo, 'commit', '-q', '-m', 'agent')
    await turn()
    expect(landCalls).toHaveLength(0)
    expect(archived).toEqual(['t1'])
  })

  it('a run still going at startup is handed back', () => {
    setTask({ phase: 'reviewing', review: true, reviews: 1 })
    make().start()
    expect(taskOf()?.autopilot).toMatchObject({ phase: 'stopped', reason: 'DevTool restarted before Autopilot finished' })
  })

  it('leaves a run alone once Autopilot is off, or the task is landing by other hands', async () => {
    startWith({ phase: 'working' }, {}, { landing: { landTask: async () => { landCalls.push({}); return landResult }, fixWithAgent: async () => fixResult, isBusy: () => true } })
    fs.writeFileSync(path.join(own.worktreePath, 'b.txt'), 'new\n')
    await turn()
    expect(landCalls).toHaveLength(0)
    expect(taskOf()?.autopilot?.phase).toBe('working')
  })
})

describe('Autopilot in the inbox', () => {
  const base = (autopilot: TaskAutopilot, lastInteractedAt = 0): Task => ({ ...fixtureTask({ id: 't' }), autopilot, lastInteractedAt })

  it('a stopped run needs you until you write to the task', () => {
    expect(autopilotNeedsYou(base({ phase: 'stopped', stoppedAt: 10 }, 5))).toBe(true)
    expect(autopilotNeedsYou(base({ phase: 'stopped', stoppedAt: 10 }, 11))).toBe(false)
    expect(autopilotNeedsYou(base({ phase: 'working' }))).toBe(false)
  })

  it('reviewing and landing are work without an agent turn', () => {
    expect(autopilotBusy(base({ phase: 'reviewing' }))).toBe(true)
    expect(autopilotBusy(base({ phase: 'landing' }))).toBe(true)
    expect(autopilotBusy(base({ phase: 'fixing' }))).toBe(false)
  })

  it('an archived landed run carries the mark; a reopened task is off Autopilot', () => {
    const landed = base({ phase: 'landing' })
    expect(autopilotLanded(landed)).toBe(true)
    expect(reopenedTask(landed, false).autopilot).toBeUndefined()
  })

  it('runs on this Mac only', () => {
    const project = (extra: Partial<Project>): Project => ({ ...fixtureProject({ id: 'p' }), ...extra })
    expect(autopilotSupported(project({}))).toBe(true)
    expect(autopilotSupported(project({ host: 'server-1' }))).toBe(false)
    expect(autopilotSupported(project({ ssh: { host: 'h', username: 'u', port: 22, remoteDir: '/x' } as Project['ssh'] }))).toBe(false)
  })
})

describe('Codex review', () => {
  it('reads the schema\'s verdict', () => {
    expect(parseCodexVerdict('{"clean":true,"findings":""}')).toEqual({ status: 'clean' })
    expect(parseCodexVerdict('{"clean":false,"findings":"- bug"}')).toEqual({ status: 'findings', text: '- bug' })
    // Unhappy but nothing said: nothing to send back.
    expect(parseCodexVerdict('{"clean":false,"findings":"  "}')).toEqual({ status: 'clean' })
    expect(parseCodexVerdict('not json, a bug in a.ts')).toEqual({ status: 'findings', text: 'not json, a bug in a.ts' })
    expect(parseCodexVerdict('')).toEqual({ status: 'failed', error: 'Codex gave no answer' })
  })

  it('the prompt names the base, the target and the task', () => {
    const prompt = codexReviewPrompt({ base: 'abc123', target: 'the stream branch `0.7.0`', taskName: 'Fix login', summary: 'Done.' })
    expect(prompt).toContain('git diff abc123')
    expect(prompt).toContain('the stream branch `0.7.0`')
    expect(prompt).toContain('"Fix login"')
    expect(prompt).toContain('The agent\'s summary: Done.')
  })

  it('names why a landing stops a run', () => {
    expect(landingStopReason({ status: 'landed' }, 'main')).toBeNull()
    expect(landingStopReason({ status: 'fixing' }, 'main')).toBeNull()
    expect(landingStopReason({ status: 'failed', error: 'boom' }, 'main')).toBe('Couldn\'t land: boom')
  })
})
