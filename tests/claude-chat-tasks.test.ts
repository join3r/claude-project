import { describe, expect, it } from 'vitest'
import { emptyChatState, reduceChat, TASK_LINGER_MS, type ChatEvent, type ChatState } from '../src/shared/claude-chat'
import { validateArgs } from '../src/main/ipc/validate'
import { chatTaskArgs } from '../src/main/ipc/schemas'

function fold(events: ChatEvent[], state: ChatState = emptyChatState()): ChatState {
  return events.reduce(reduceChat, state)
}

const sdk = (m: Record<string, unknown>, at = 1000): ChatEvent => ({ t: 'sdk', m, at })
const system = (subtype: string, fields: Record<string, unknown>, at?: number): ChatEvent =>
  sdk({ type: 'system', subtype, uuid: `${subtype}-${at ?? 0}`, session_id: 's', ...fields }, at)

const agentCall = (id: string, input: Record<string, unknown> = { description: 'Look around', prompt: 'go', subagent_type: 'Explore' }): ChatEvent =>
  sdk({ type: 'assistant', message: { id: `m-${id}`, content: [{ type: 'tool_use', id, name: 'Agent', input }] } })
const bashCall = (id: string, command: string, extra: Record<string, unknown> = {}): ChatEvent =>
  sdk({ type: 'assistant', message: { id: `m-${id}`, content: [{ type: 'tool_use', id, name: 'Bash', input: { command, ...extra } }] } })

describe('chat tasks', () => {
  it('follows a subagent from start through progress, backgrounding and its notification', () => {
    let state = fold([
      agentCall('tu1'),
      system('task_started', { task_id: 't1', tool_use_id: 'tu1', description: 'Look around', task_type: 'local_agent', is_backgrounded: false }, 1000)
    ])
    expect(state.tasks.t1).toMatchObject({
      id: 't1', toolUseId: 'tu1', kind: 'subagent', agentType: 'Explore', description: 'Look around',
      background: false, status: 'running', startedAt: 1000
    })

    state = fold([
      system('task_progress', { task_id: 't1', description: 'Look around', usage: { total_tokens: 1200, tool_uses: 3, duration_ms: 500 }, last_tool_name: 'Grep', summary: 'Reading the router' }, 2000),
      system('task_updated', { task_id: 't1', patch: { is_backgrounded: true } }, 3000)
    ], state)
    expect(state.tasks.t1).toMatchObject({ toolUses: 3, tokens: 1200, lastTool: 'Grep', summary: 'Reading the router', background: true, status: 'running' })

    state = fold([
      system('task_notification', { task_id: 't1', tool_use_id: 'tu1', status: 'completed', summary: 'Found it', output_file: '', usage: { total_tokens: 5000, tool_uses: 9, duration_ms: 9000 } }, 9000)
    ], state)
    expect(state.tasks.t1).toMatchObject({ status: 'completed', endedAt: 9000, tokens: 5000, toolUses: 9, summary: 'Found it' })
    // The notification's timeline notice is kept.
    expect(state.items.some((item) => item.kind === 'notice' && item.text === 'Found it')).toBe(true)
  })

  it("shows a background subagent's multi-line report as one line naming the task", () => {
    const report = 'The API is reusable.\n\n## 1. Endpoints\n\n| Method | Path |\n|---|---|'
    let state = fold([
      agentCall('tu1'),
      system('task_started', { task_id: 't1', tool_use_id: 'tu1', description: 'Map the API', task_type: 'local_agent', is_backgrounded: true }, 1000),
      system('task_notification', { task_id: 't1', tool_use_id: 'tu1', status: 'completed', summary: report, output_file: '' }, 2000)
    ])
    const notices = (s: ChatState): string[] => s.items.flatMap((item) => item.kind === 'notice' ? [item.text] : [])
    expect(notices(state)).toEqual(['Map the API finished'])
    expect(state.tasks.t1.summary).toBe(report)

    // A task it never saw start falls back to the report's first line.
    state = fold([system('task_notification', { task_id: 't9', status: 'failed', summary: report, output_file: '' }, 3000)], state)
    expect(notices(state)).toEqual(['Map the API finished', 'The API is reusable.'])
  })

  it("keeps a subagent's own shells and foreground tasks out of the timeline and the task list", () => {
    // What the CLI sends when a background subagent runs a slow command without a description.
    const heredoc = "python3 - <<'EOF'\nprint(1)\nEOF"
    const state = fold([
      agentCall('tu1', { description: 'Integrate', prompt: 'go', subagent_type: 'general-purpose', run_in_background: true }),
      system('task_started', { task_id: 'a1', tool_use_id: 'tu1', description: 'Integrate', task_type: 'local_agent', is_backgrounded: true }, 1000),
      system('task_started', { task_id: 'b1', owned_by_subagent: true, tool_use_id: 'sub-tu', description: heredoc, is_backgrounded: false, task_type: 'local_bash' }, 1100),
      system('task_notification', { task_id: 'b1', tool_use_id: 'sub-tu', status: 'completed', output_file: '', summary: heredoc }, 1200),
      bashCall('tu2', 'npm test'),
      system('task_started', { task_id: 'b2', tool_use_id: 'tu2', description: 'npm test', is_backgrounded: false, task_type: 'local_bash' }, 1300),
      system('task_notification', { task_id: 'b2', tool_use_id: 'tu2', status: 'completed', output_file: '', summary: 'npm test' }, 1400),
      system('task_notification', { task_id: 'a1', tool_use_id: 'tu1', status: 'completed', output_file: '', summary: 'Integrated' }, 1500)
    ])
    const notices = state.items.filter((item) => item.kind === 'notice').map((item) => item.kind === 'notice' ? item.text : '')
    expect(notices).toEqual(['Integrated'])
    expect(state.tasks.b1).toMatchObject({ nested: true, status: 'completed' })
    expect(state.tasks.b2.nested).toBeUndefined()
  })

  it('runs a finished subagent again when it registers anew (resumed)', () => {
    const state = fold([
      system('task_started', { task_id: 't1', description: 'Agent', task_type: 'local_agent', is_backgrounded: true }, 1000),
      system('task_notification', { task_id: 't1', status: 'completed', summary: '', output_file: '' }, 2000),
      system('task_started', { task_id: 't1', description: 'Agent', task_type: 'local_agent', is_backgrounded: true }, 3000)
    ])
    expect(state.tasks.t1).toMatchObject({ status: 'running', startedAt: 3000 })
    expect(state.tasks.t1.endedAt).toBeUndefined()
  })

  it('takes a shell command from its Bash call', () => {
    const state = fold([
      bashCall('tu2', 'sleep 120', { run_in_background: true }),
      system('task_started', { task_id: 'b1', tool_use_id: 'tu2', description: 'Wait two minutes', task_type: 'local_bash', is_backgrounded: true }, 1000)
    ])
    expect(state.tasks.b1).toMatchObject({ kind: 'shell', command: 'sleep 120', background: true, description: 'Wait two minutes' })
  })

  it('maps task_updated killed to stopped', () => {
    const state = fold([
      system('task_started', { task_id: 'w1', description: 'Workflow', task_type: 'local_workflow', is_backgrounded: true }, 1000),
      system('task_updated', { task_id: 'w1', patch: { status: 'killed', end_time: 1500 } }, 1600)
    ])
    expect(state.tasks.w1).toMatchObject({ kind: 'workflow', status: 'stopped', endedAt: 1500 })
  })

  it('lets background_tasks_changed end a background task whose bookend never came', () => {
    let state = fold([
      system('task_started', { task_id: 'b1', description: 'Server', task_type: 'local_bash', is_backgrounded: true }, 1000),
      system('task_started', { task_id: 'b2', description: 'Watcher', task_type: 'local_bash', is_backgrounded: true }, 1000),
      system('background_tasks_changed', { tasks: [{ task_id: 'b1', task_type: 'local_bash', description: 'Server' }, { task_id: 'b2', task_type: 'local_bash', description: 'Watcher' }] }, 1100)
    ])
    expect(state.tasks.b1.status).toBe('running')
    expect(state.tasks.b2.status).toBe('running')

    state = fold([system('background_tasks_changed', { tasks: [{ task_id: 'b2', task_type: 'local_bash', description: 'Watcher' }] }, 2000)], state)
    expect(state.tasks.b1).toMatchObject({ status: 'completed', endedAt: 2000 })
    expect(state.tasks.b2.status).toBe('running')

    // A late bookend still names the real outcome.
    state = fold([system('task_notification', { task_id: 'b1', status: 'failed', summary: 'exit 1', output_file: '' }, 2100)], state)
    expect(state.tasks.b1).toMatchObject({ status: 'failed', endedAt: 2000 })
  })

  it('marks a foreground task backgrounded when the level lists it, and adds tasks it never saw start', () => {
    const state = fold([
      agentCall('tu1'),
      system('task_started', { task_id: 't1', tool_use_id: 'tu1', description: 'Look', task_type: 'local_agent', is_backgrounded: false }, 1000),
      system('background_tasks_changed', { tasks: [
        { task_id: 't1', task_type: 'local_agent', description: 'Look' },
        { task_id: 'x9', task_type: 'local_bash', description: 'Unseen' }
      ] }, 1500)
    ])
    expect(state.tasks.t1.background).toBe(true)
    expect(state.tasks.x9).toMatchObject({ kind: 'shell', background: true, status: 'running', startedAt: 1500 })
  })

  it('leaves ambient tasks out', () => {
    let state = fold([
      system('task_started', { task_id: 'a1', description: 'Housekeeping', task_type: 'local_bash', ambient: true, skip_transcript: true }, 1000),
      system('background_tasks_changed', { tasks: [{ task_id: 'a2', task_type: 'monitor', description: 'Watcher', ambient: true }] }, 1000)
    ])
    expect(state.tasks).toEqual({})
    // A task whose ambient flag flips on drops out.
    state = fold([
      system('task_started', { task_id: 'b1', description: 'Server', task_type: 'local_bash', is_backgrounded: true }, 1000),
      system('background_tasks_changed', { tasks: [{ task_id: 'b1', task_type: 'local_bash', description: 'Server', ambient: true }] }, 1100)
    ], state)
    expect(state.tasks.b1).toBeUndefined()
  })

  it('never shows tasks from replayed history as running', () => {
    const state = reduceChat(emptyChatState(), {
      t: 'history',
      messages: [
        { type: 'assistant', message: { id: 'm1', content: [{ type: 'tool_use', id: 'tu1', name: 'Agent', input: { prompt: 'x' } }] } },
        { type: 'system', subtype: 'task_started', task_id: 't1', tool_use_id: 'tu1', description: 'Old', task_type: 'local_agent' },
        { type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 't1', task_type: 'local_agent', description: 'Old' }] }
      ]
    })
    expect(state.tasks).toEqual({})
  })

  it('resets tasks when the CLI process restarts, and stops them when it exits', () => {
    let state = fold([
      system('task_started', { task_id: 'b1', description: 'Server', task_type: 'local_bash', is_backgrounded: true }, 1000)
    ])
    state = reduceChat(state, { t: 'process', state: 'exited', at: 5000 })
    expect(state.tasks.b1).toMatchObject({ status: 'stopped', endedAt: 5000 })
    state = reduceChat(state, { t: 'process', state: 'starting' })
    expect(state.tasks).toEqual({})
  })

  it('ends foreground main-thread tasks with the turn but spares background and nested ones', () => {
    const state = fold([
      agentCall('tu1'),
      bashCall('tu2', 'npm test'),
      system('task_started', { task_id: 'fg', tool_use_id: 'tu1', description: 'Blocking agent', task_type: 'local_agent', is_backgrounded: false }, 1000),
      system('task_started', { task_id: 'bg', tool_use_id: 'tu2', description: 'Tests', task_type: 'local_bash', is_backgrounded: true }, 1000),
      // A shell a subagent started: its tool call isn't a main-thread row.
      system('task_started', { task_id: 'nested', tool_use_id: 'sub-tu', description: 'Inner', task_type: 'local_bash', is_backgrounded: false }, 1000),
      { t: 'interrupting' },
      sdk({ type: 'result', subtype: 'error_during_execution', errors: [] }, 4000)
    ])
    expect(state.tasks.fg).toMatchObject({ status: 'stopped', endedAt: 4000 })
    expect(state.tasks.bg.status).toBe('running')
    expect(state.tasks.nested.status).toBe('running')
  })

  it('keeps tasks across /clear and ages finished ones out of the map', () => {
    let state = fold([
      system('task_started', { task_id: 'b1', description: 'Server', task_type: 'local_bash', is_backgrounded: true }, 1000),
      system('task_started', { task_id: 'b2', description: 'Build', task_type: 'local_bash', is_backgrounded: true }, 1000),
      system('task_notification', { task_id: 'b2', status: 'completed', summary: '', output_file: '' }, 2000),
      sdk({ type: 'conversation_reset' })
    ])
    expect(Object.keys(state.tasks).sort()).toEqual(['b1', 'b2'])
    state = fold([system('task_progress', { task_id: 'b1', description: 'Server', usage: { total_tokens: 0, tool_uses: 0, duration_ms: 1 } }, 2000 + TASK_LINGER_MS + 1)], state)
    expect(Object.keys(state.tasks)).toEqual(['b1'])
  })
})

describe('chat task IPC arguments', () => {
  it('accepts a tab and a task id', () => {
    expect(validateArgs('chat-stop-task', chatTaskArgs, ['tab-1', 'task-abc'])).toEqual(['tab-1', 'task-abc'])
    expect(validateArgs('chat-background-task', chatTaskArgs, ['tab-1', 'toolu_01ABC'])).toEqual(['tab-1', 'toolu_01ABC'])
  })

  it('refuses missing, empty, oversized or extra arguments and unsafe tab ids', () => {
    expect(() => validateArgs('chat-stop-task', chatTaskArgs, ['tab-1'])).toThrow('chat-stop-task#1')
    expect(() => validateArgs('chat-stop-task', chatTaskArgs, ['tab-1', ''])).toThrow(/non-empty/)
    expect(() => validateArgs('chat-stop-task', chatTaskArgs, ['tab-1', 'x'.repeat(300)])).toThrow('chat-stop-task#1')
    expect(() => validateArgs('chat-stop-task', chatTaskArgs, ['tab-1', 42])).toThrow('chat-stop-task#1')
    expect(() => validateArgs('chat-stop-task', chatTaskArgs, ['../etc', 't'])).toThrow('chat-stop-task#0')
    expect(() => validateArgs('chat-background-task', chatTaskArgs, ['tab-1', 't', 'extra'])).toThrow(/at most 2/)
  })
})

describe('chat workflow progress', () => {
  const script = [
    "export const meta = {",
    "  name: 'review',",
    "  description: 'Review the diff',",
    "  phases: [{ title: 'Review', detail: 'one agent per dimension' }, { title: \"Verify\" }, { title: 'Report' }],",
    "}",
    "const results = await agent('Look', { phase: 'Review' })"
  ].join('\n')
  const agentEntry = (index: number, phaseIndex: number, phaseTitle: string, state: string, extra: Record<string, unknown> = {}): Record<string, unknown> =>
    ({ type: 'workflow_agent', index, label: `agent-${index}`, phaseIndex, phaseTitle, agentId: `a${index}`, state, queuedAt: 1000, ...extra })

  it('reads the declared phases from the script, then folds progress snapshots over them', () => {
    let state = fold([
      system('task_started', { task_id: 'w1', tool_use_id: 'tu1', description: 'Review the diff', task_type: 'local_workflow', workflow_name: 'review', prompt: script }, 1000)
    ])
    expect(state.tasks.w1.kind).toBe('workflow')
    expect(state.tasks.w1.workflow).toEqual({
      phases: [
        { index: 1, title: 'Review', detail: 'one agent per dimension', started: false },
        { index: 2, title: 'Verify', started: false },
        { index: 3, title: 'Report', started: false }
      ],
      agents: []
    })

    state = fold([
      system('task_progress', {
        task_id: 'w1', description: 'Review: agent-1', usage: { total_tokens: 900, tool_uses: 4, duration_ms: 10 }, last_tool_name: 'agent-1',
        workflow_progress: [
          { type: 'workflow_phase', index: 1, title: 'Review' },
          agentEntry(1, 1, 'Review', 'progress', { startedAt: 1100, lastToolName: 'Bash', lastToolSummary: 'git diff', tokens: 500 }),
          agentEntry(2, 1, 'Review', 'start'),
          agentEntry(3, 1, 'Review', 'done', { startedAt: 1100, durationMs: 4000, attempt: 2 }),
          agentEntry(4, 1, 'Review', 'error', { startedAt: 1100 }),
          { type: 'workflow_log', message: 'ignored' }
        ]
      }, 2000)
    ], state)
    const workflow = state.tasks.w1.workflow
    expect(workflow?.phases.map((phase) => [phase.index, phase.title, phase.started])).toEqual([[1, 'Review', true], [2, 'Verify', false], [3, 'Report', false]])
    expect(workflow?.phases[0].detail).toBe('one agent per dimension')
    expect(workflow?.agents).toEqual([
      { index: 1, label: 'agent-1', phaseIndex: 1, state: 'running', startedAt: 1100, tokens: 500, lastTool: 'git diff' },
      { index: 2, label: 'agent-2', phaseIndex: 1, state: 'queued' },
      { index: 3, label: 'agent-3', phaseIndex: 1, state: 'done', startedAt: 1100, durationMs: 4000, attempt: 2 },
      { index: 4, label: 'agent-4', phaseIndex: 1, state: 'failed', startedAt: 1100 }
    ])

    // A frame without the snapshot keeps the last one.
    state = fold([system('task_progress', { task_id: 'w1', description: 'x', usage: { total_tokens: 1000, tool_uses: 5, duration_ms: 20 } }, 3000)], state)
    expect(state.tasks.w1.workflow).toBe(workflow)
    expect(state.tasks.w1.tokens).toBe(1000)
  })

  it('builds phases from progress alone when the script declares none', () => {
    const state = fold([
      system('task_started', { task_id: 'w2', description: 'Ad hoc', task_type: 'local_workflow', prompt: 'await agent("x")' }, 1000),
      system('task_progress', {
        task_id: 'w2', description: 'x', usage: { total_tokens: 1, tool_uses: 1, duration_ms: 1 },
        workflow_progress: [agentEntry(1, 2, 'Second', 'done'), agentEntry(2, 1, 'First', 'cancelled'), { type: 'workflow_agent', state: 'done' }]
      }, 2000)
    ])
    expect(state.tasks.w2.workflow?.phases).toEqual([{ index: 1, title: 'First', started: true }, { index: 2, title: 'Second', started: true }])
    expect(state.tasks.w2.workflow?.agents.map((agent) => agent.state)).toEqual(['done', 'skipped'])
  })
})
