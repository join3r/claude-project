import { describe, it, expect } from 'vitest'
import {
  describeActivity,
  firstLine,
  reduceAgentActivity,
  summarizeTool,
  type AgentActivity
} from '../src/shared/agent-activity'
import { TabActivityRegistry } from '../src/main/tab-activity-registry'

/** Fold a sequence of hook bodies, returning the final activity and every status event. */
function fold(bodies: Record<string, unknown>[]): { activity: AgentActivity | undefined; events: (string | null)[] } {
  let activity: AgentActivity | undefined
  const events: (string | null)[] = []
  bodies.forEach((body, index) => {
    const update = reduceAgentActivity(activity, body, 1000 + index)
    activity = update.activity
    events.push(update.statusEvent)
  })
  return { activity, events }
}

describe('summarizeTool', () => {
  it('labels the common tools', () => {
    expect(summarizeTool('Bash', { command: 'npm test\necho done' })).toBe('Bash · npm test')
    expect(summarizeTool('Edit', { file_path: '/repo/src/styles.css' })).toBe('Editing styles.css')
    expect(summarizeTool('Read', { file_path: 'C:\\repo\\a.ts' })).toBe('Reading a.ts')
    expect(summarizeTool('Grep', { pattern: 'TODO' })).toBe('Searching "TODO"')
    expect(summarizeTool('WebFetch', { url: 'https://code.claude.com/docs' })).toBe('Fetching code.claude.com')
    expect(summarizeTool('Agent', { description: 'Find callers' })).toBe('Agent · Find callers')
    expect(summarizeTool('mcp__github__create_pr', {})).toBe('github · create_pr')
    expect(summarizeTool('SomethingNew', {})).toBe('SomethingNew')
  })

  it('survives missing or malformed input', () => {
    expect(summarizeTool('Bash', undefined)).toBe('Bash')
    expect(summarizeTool('Edit', { file_path: 42 })).toBe('Editing')
    expect(summarizeTool('AskUserQuestion', {})).toBe('Question for you')
  })
})

describe('firstLine', () => {
  it('takes the first non-empty line and strips markdown noise', () => {
    expect(firstLine('\n\n## **Done.** All tests pass\nmore')).toBe('Done. All tests pass')
  })

  it('truncates long lines', () => {
    expect(firstLine('x'.repeat(300), 10)).toBe('xxxxxxxxx…')
  })
})

describe('reduceAgentActivity', () => {
  it('tracks a turn from prompt to reply', () => {
    const { activity } = fold([
      { hook_event_name: 'UserPromptSubmit', prompt: 'Fix the inbox\nplease', session_title: 'Inbox fix' },
      { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 't1', tool_input: { command: 'npm test' } }
    ])
    expect(activity?.title).toBe('Inbox fix')
    expect(activity?.lastPrompt).toBe('Fix the inbox')
    expect(describeActivity(activity, 'working')).toBe('Bash · npm test')

    const done = fold([
      { hook_event_name: 'UserPromptSubmit', prompt: 'Fix it' },
      { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 't1', tool_input: { command: 'npm test' } },
      { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 't1' },
      { hook_event_name: 'Stop', last_assistant_message: 'Fixed the idle nudge.\n\nDetails…' }
    ]).activity
    expect(done?.tool).toBeUndefined()
    expect(describeActivity(done, null)).toBe('Fixed the idle nudge.')
  })

  it('shows "Thinking" between tools', () => {
    const { activity } = fold([{ hook_event_name: 'UserPromptSubmit', prompt: 'Go' }])
    expect(describeActivity(activity, 'working')).toBe('Thinking · Go')
  })

  it('keeps the real prompt when the harness injects a tagged turn', () => {
    const { activity } = fold([
      { hook_event_name: 'UserPromptSubmit', prompt: 'Check the new mail' },
      { hook_event_name: 'Stop', last_assistant_message: 'Started.' },
      { hook_event_name: 'UserPromptSubmit', prompt: '<task-notification>\n<task-id>a1</task-id>\n</task-notification>' }
    ])
    expect(describeActivity(activity, 'working')).toBe('Thinking · Check the new mail')

    const command = fold([
      { hook_event_name: 'UserPromptSubmit', prompt: '<command-message>review</command-message>\n<command-name>/review</command-name>\n<command-args>42</command-args>' }
    ]).activity
    expect(command?.lastPrompt).toBe('/review 42')
  })

  it('raises and resolves a permission dialog', () => {
    const { activity, events } = fold([
      { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 't1', tool_input: { command: 'rm -rf dist' } },
      { hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_use_id: 't1', tool_input: { command: 'rm -rf dist' } }
    ])
    expect(events).toEqual([null, 'hook-needs-input'])
    expect(describeActivity(activity, 'attention')).toBe('Permission: Bash · rm -rf dist')

    const resolved = reduceAgentActivity(activity, { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 't1' }, 2000)
    expect(resolved.statusEvent).toBe('hook-input-resolved')
    expect(resolved.activity.waiting).toBeUndefined()
  })

  it('does not lift a permission wait when a different parallel tool finishes', () => {
    const { activity } = fold([
      { hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_use_id: 't2', tool_input: { command: 'deploy' } }
    ])
    const other = reduceAgentActivity(activity, { hook_event_name: 'PostToolUse', tool_name: 'Read', tool_use_id: 't1' }, 2000)
    expect(other.statusEvent).toBeNull()
    expect(other.activity.waiting?.kind).toBe('permission')
  })

  it('treats AskUserQuestion and ExitPlanMode as waiting on you', () => {
    const question = fold([{
      hook_event_name: 'PreToolUse',
      tool_name: 'AskUserQuestion',
      tool_use_id: 'q1',
      tool_input: { questions: [{ question: 'Which database?' }] }
    }])
    expect(question.events).toEqual(['hook-needs-input'])
    expect(describeActivity(question.activity, 'attention')).toBe('Which database?')

    const plan = fold([{ hook_event_name: 'PreToolUse', tool_name: 'ExitPlanMode', tool_use_id: 'p1', tool_input: {} }])
    expect(describeActivity(plan.activity, 'attention')).toBe('Plan ready for review')
  })

  it('keeps the question label when a PermissionRequest follows for the same tool', () => {
    const { activity, events } = fold([
      { hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_use_id: 'q1', tool_input: { questions: [{ question: 'Which DB?' }] } },
      { hook_event_name: 'PermissionRequest', tool_name: 'AskUserQuestion', tool_use_id: 'q1', tool_input: {} }
    ])
    expect(events).toEqual(['hook-needs-input', null])
    expect(activity?.waiting?.label).toBe('Which DB?')
  })

  it('reports a turn that died on an API error', () => {
    const { activity, events } = fold([
      { hook_event_name: 'UserPromptSubmit', prompt: 'Go' },
      { hook_event_name: 'StopFailure', error: 'rate_limit' }
    ])
    expect(events).toEqual([null, 'hook-needs-input'])
    expect(describeActivity(activity, 'attention')).toBe('Rate limited')
    expect(activity?.turnStartedAt).toBeUndefined()
  })

  it('counts subagents and ignores their tool calls for the label', () => {
    const { activity } = fold([
      { hook_event_name: 'UserPromptSubmit', prompt: 'Research' },
      { hook_event_name: 'SubagentStart', agent_id: 'a1', agent_type: 'Explore' },
      { hook_event_name: 'SubagentStart', agent_id: 'a2', agent_type: 'Explore' },
      { hook_event_name: 'PreToolUse', agent_id: 'a1', tool_name: 'Grep', tool_input: { pattern: 'x' } }
    ])
    expect(describeActivity(activity, 'working')).toBe('2 agents')
    const one = reduceAgentActivity(activity, { hook_event_name: 'SubagentStop', agent_id: 'a1' }, 5000).activity
    expect(describeActivity(one, 'working')).toBe('1 agent')
  })

  it('shows compaction', () => {
    const { activity } = fold([{ hook_event_name: 'PreCompact', trigger: 'auto' }])
    expect(describeActivity(activity, 'working')).toBe('Compacting context')
    const after = reduceAgentActivity(activity, { hook_event_name: 'PostCompact', trigger: 'auto' }, 5000).activity
    expect(after.compacting).toBe(false)
  })

  it('Stop clears everything tool-shaped, so a late async event cannot linger', () => {
    const { activity } = fold([
      { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 't1', tool_input: { command: 'x' } },
      { hook_event_name: 'SubagentStart', agent_id: 'a1' },
      { hook_event_name: 'Stop', last_assistant_message: 'ok' }
    ])
    expect(activity?.tool).toBeUndefined()
    expect(activity?.subagents).toBe(0)
    expect(activity?.waiting).toBeUndefined()
  })

  it('leaves pi-shaped and unknown bodies untouched', () => {
    expect(reduceAgentActivity(undefined, {}, 1).changed).toBe(false)
    expect(reduceAgentActivity(undefined, undefined, 1).changed).toBe(false)
    expect(reduceAgentActivity(undefined, { hook_event_name: 'FileChanged' }, 1).changed).toBe(false)
  })

  it('lifts a wait when a chat tab\'s prompt is answered, without clearing the tool', () => {
    const { activity } = fold([
      { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 't1', tool_input: { command: 'deploy' } },
      { hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_use_id: 't1', tool_input: { command: 'deploy' } }
    ])
    const other = reduceAgentActivity(activity, { hook_event_name: 'DevtoolPromptResolved', tool_use_id: 't9' }, 2000)
    expect(other.statusEvent).toBeNull()
    const answered = reduceAgentActivity(activity, { hook_event_name: 'DevtoolPromptResolved', tool_use_id: 't1' }, 2000)
    expect(answered.statusEvent).toBe('hook-input-resolved')
    expect(answered.activity.waiting).toBeUndefined()
    expect(answered.activity.tool?.label).toBe('Bash · deploy')
  })

  it('the idle nudge changes nothing', () => {
    const { activity } = fold([{ hook_event_name: 'Stop', last_assistant_message: 'Done' }])
    const idle = reduceAgentActivity(activity, { hook_event_name: 'Notification', notification_type: 'idle_prompt' }, 9000)
    expect(idle.statusEvent).toBeNull()
    expect(idle.activity.waiting).toBeUndefined()
  })
})

describe('TabActivityRegistry', () => {
  it('ends the in-flight turn on exit but keeps the conversation summary', () => {
    const registry = new TabActivityRegistry(() => 1)
    registry.applyHook('tab', { hook_event_name: 'UserPromptSubmit', prompt: 'Go' })
    registry.applyHook('tab', { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'x' } })
    registry.exited('tab')
    expect(registry.getActivity('tab')?.tool).toBeUndefined()
    expect(registry.getActivity('tab')?.lastPrompt).toBe('Go')
    registry.remove('tab')
    expect(registry.getActivity('tab')).toBeNull()
  })

  it('applies activity status events through the shared state machine', () => {
    const registry = new TabActivityRegistry(() => 1)
    registry.working('tab')
    registry.statusEvent('tab', 'hook-needs-input')
    expect(registry.getStatus('tab')).toBe('attention')
    registry.statusEvent('tab', 'hook-input-resolved')
    expect(registry.getStatus('tab')).toBe('working')
  })

  it('keeps a turn that leaves background tasks running working until they end', () => {
    const registry = new TabActivityRegistry(() => 1)
    const hook = (body: Record<string, unknown>): void => {
      const update = registry.applyHook('tab', body)
      if (update?.statusEvent) registry.statusEvent('tab', update.statusEvent)
    }
    hook({ hook_event_name: 'UserPromptSubmit', prompt: 'Run the eval' })
    registry.working('tab')
    hook({ hook_event_name: 'DevtoolBackgroundTasks', count: 1 })
    hook({ hook_event_name: 'Stop' })
    registry.stopped('tab')
    expect(registry.getStatus('tab')).toBe('working')
    expect(describeActivity(registry.getActivity('tab') ?? undefined, 'working')).toBe('1 background task')

    hook({ hook_event_name: 'DevtoolBackgroundTasks', count: 0 })
    expect(registry.getStatus('tab')).toBeNull()
  })

  it('leaves a running turn alone when its background tasks end', () => {
    const { events } = fold([
      { hook_event_name: 'UserPromptSubmit', prompt: 'Go' },
      { hook_event_name: 'DevtoolBackgroundTasks', count: 1 },
      { hook_event_name: 'DevtoolBackgroundTasks', count: 0 }
    ])
    expect(events).toEqual([null, null, null])
  })

  it('forgets background tasks when the process goes away', () => {
    const registry = new TabActivityRegistry(() => 1)
    registry.applyHook('tab', { hook_event_name: 'DevtoolBackgroundTasks', count: 2 })
    registry.reset('tab')
    expect(registry.backgroundTasks('tab')).toBe(0)
  })

  it('returns null for bodies that change nothing', () => {
    const registry = new TabActivityRegistry(() => 1)
    expect(registry.applyHook('tab', {})).toBeNull()
    expect(registry.getActivity('tab')).toBeNull()
  })
})
