import { describe, it, expect } from 'vitest'
import { PassThrough } from 'stream'
import { emptyChatState, findModelOption, reduceChat, type ChatEvent, type ChatState } from '../src/shared/claude-chat'
import { buildTimeline, summarizeGroup } from '../src/renderer/components/claude-chat/timelineRows'
import { contextTone, formatCost, formatResetAt, formatResetIn, formatTokens, limitTone } from '../src/renderer/components/claude-chat/UsageMeter'
import { diffLines, diffStats, editPairs } from '../src/renderer/components/claude-chat/diff'
import { JsonLineGate, sdkAddedEnv } from '../src/main/claude-chat/remote-spawn'
import { coldCacheFrom, extraArgsRecord, isDisplayRelevant, sessionStartInput } from '../src/main/claude-chat/chat-session'
import { coldCacheText, formatIdle } from '../src/renderer/components/claude-chat/ColdCacheNotice'
import { parseTranscriptLines, remoteTranscriptScript } from '../src/main/claude-chat/transcript'
import { claudeTabType, createTab } from '../src/renderer/components/newTaskTabs'

const MSG = 'msg_1'

function fold(events: ChatEvent[], start: ChatState = emptyChatState()): ChatState {
  return events.reduce(reduceChat, start)
}

const sdk = (m: unknown): ChatEvent => ({ t: 'sdk', m, at: 1000 })

/** The shapes Claude Code 2.1.280 streams for one turn: thinking, a tool, a reply. */
function turn(): ChatEvent[] {
  return [
    { t: 'sent', uuid: 'u1', text: 'Read notes.txt', images: 0, at: 900 },
    sdk({ type: 'user', isReplay: true, uuid: 'u1', message: { role: 'user', content: 'Read notes.txt' }, parent_tool_use_id: null }),
    sdk({ type: 'system', subtype: 'init', session_id: 's1', model: 'claude-haiku-4-5', permissionMode: 'default', cwd: '/p' }),
    sdk({ type: 'stream_event', event: { type: 'message_start', message: { id: MSG } }, parent_tool_use_id: null }),
    sdk({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }, parent_tool_use_id: null }),
    sdk({ type: 'assistant', message: { id: MSG, content: [{ type: 'thinking', thinking: '' }] }, parent_tool_use_id: null }),
    sdk({ type: 'stream_event', event: { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 't1', name: 'Read', input: {} } }, parent_tool_use_id: null }),
    sdk({ type: 'assistant', message: { id: MSG, content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/p/notes.txt' } }] }, parent_tool_use_id: null }),
    sdk({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: '1\thello' }] }, parent_tool_use_id: null }),
    sdk({ type: 'stream_event', event: { type: 'message_start', message: { id: 'msg_2' } }, parent_tool_use_id: null }),
    sdk({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, parent_tool_use_id: null }),
    sdk({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'It says ' } }, parent_tool_use_id: null }),
    sdk({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hello.' } }, parent_tool_use_id: null }),
    sdk({ type: 'assistant', message: { id: 'msg_2', content: [{ type: 'text', text: 'It says hello.' }] }, parent_tool_use_id: null }),
    sdk({ type: 'result', subtype: 'success', is_error: false, result: 'It says hello.' })
  ]
}

describe('reduceChat', () => {
  it('folds a streamed turn into user, tool and reply items', () => {
    const state = fold(turn())
    expect(state.busy).toBe(false)
    expect(state.info.model).toBe('claude-haiku-4-5')
    const visible = state.items.filter((item) => !((item.kind === 'text' || item.kind === 'thinking') && !item.text))
    expect(visible.map((item) => item.kind)).toEqual(['user', 'tool', 'text'])
    const [user, tool, text] = visible
    expect(user.kind === 'user' && user.queued).toBe(false)
    expect(tool.kind === 'tool' && tool.status).toBe('done')
    expect(tool.kind === 'tool' && tool.label).toBe('Reading notes.txt')
    expect(tool.kind === 'tool' && tool.result).toBe('1\thello')
    expect(text.kind === 'text' && text.text).toBe('It says hello.')
    expect(text.kind === 'text' && text.streaming).toBe(false)
  })

  it('streams text before the final message lands', () => {
    const events = turn()
    const midway = fold(events.slice(0, 13))
    const text = midway.items.find((item) => item.kind === 'text')
    expect(text?.kind === 'text' && text.text).toBe('It says hello.')
    expect(text?.kind === 'text' && text.streaming).toBe(true)
    expect(midway.busy).toBe(true)
  })

  it('keeps a message queued until Claude echoes it back', () => {
    const queued = fold([{ t: 'sent', uuid: 'u2', text: 'also this', images: 0 }])
    expect(queued.items[0]).toMatchObject({ kind: 'user', queued: true })
    const taken = reduceChat(queued, sdk({ type: 'user', isReplay: true, uuid: 'u2', message: { role: 'user', content: 'also this' }, parent_tool_use_id: null }))
    expect(taken.items).toHaveLength(1)
    expect(taken.items[0]).toMatchObject({ kind: 'user', queued: false })
  })

  it('marks the tool waiting while a prompt is open, and denied when refused', () => {
    const base = fold(turn().slice(0, 7))
    const asked = reduceChat(base, { t: 'prompt', prompt: { id: 'p1', kind: 'permission', toolName: 'Read', toolUseId: 't1', input: {} } })
    expect(asked.pending).toHaveLength(1)
    expect(asked.items.find((item) => item.kind === 'tool')).toMatchObject({ status: 'waiting' })
    const refused = reduceChat(asked, { t: 'prompt-done', id: 'p1', allowed: false })
    expect(refused.pending).toHaveLength(0)
    expect(refused.items.find((item) => item.kind === 'tool')).toMatchObject({ status: 'denied' })
  })

  it('does not report an interrupt as an error', () => {
    const running = fold([{ t: 'sent', uuid: 'u1', text: 'go', images: 0 }, { t: 'interrupting' }])
    const done = reduceChat(running, sdk({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['[ede_diagnostic] result_type=user'] }))
    expect(done.busy).toBe(false)
    expect(done.items.some((item) => item.kind === 'notice')).toBe(false)
  })

  it('reports a real failure', () => {
    const running = fold([{ t: 'sent', uuid: 'u1', text: 'go', images: 0 }])
    const done = reduceChat(running, sdk({ type: 'result', subtype: 'error_max_turns', is_error: true, errors: ['Reached max turns'] }))
    expect(done.items[done.items.length - 1]).toMatchObject({ kind: 'notice', tone: 'error', text: 'Reached max turns' })
  })

  it('replays history without opening a turn, and recognises transcript pseudo-messages', () => {
    const state = reduceChat(emptyChatState(), {
      t: 'history',
      messages: [
        { type: 'user', uuid: 'h1', message: { role: 'user', content: '<command-name>/compact</command-name><command-args></command-args>' }, parent_tool_use_id: null },
        { type: 'user', uuid: 'h2', message: { role: 'user', content: '<local-command-stdout>Compacted</local-command-stdout>' }, parent_tool_use_id: null },
        { type: 'user', uuid: 'h3', message: { role: 'user', content: 'fix it' }, parent_tool_use_id: null },
        { type: 'assistant', uuid: 'h4', message: { id: 'm', content: [{ type: 'tool_use', id: 'x', name: 'Bash', input: { command: 'npm test' } }] }, parent_tool_use_id: null },
        { type: 'user', uuid: 'h5', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] }, parent_tool_use_id: null }
      ]
    })
    expect(state.busy).toBe(false)
    expect(state.items.map((item) => item.kind === 'user' || item.kind === 'notice' ? `${item.kind}:${item.text}` : item.kind)).toEqual([
      'user:/compact', 'notice:Compacted', 'user:fix it', 'tool', 'notice:Interrupted'
    ])
    expect(state.items[3]).toMatchObject({ kind: 'tool', status: 'done' })
  })

  it("drops hooks' success lines from slash command output, keeping failures", () => {
    const hook = 'PostCompact [if [ -z "${HOME-}" ]; then printf \'{}\\n\'; fi] completed successfully: {}'
    const stdout = `Compacted PreCompact [callback] completed successfully\n${hook}\nPostCompact [callback] completed successfully`
    const state = reduceChat(emptyChatState(), {
      t: 'history',
      messages: [
        { type: 'user', uuid: 'h1', message: { role: 'user', content: `<local-command-stdout>${stdout}</local-command-stdout>` }, parent_tool_use_id: null }
      ]
    })
    expect(state.items).toEqual([expect.objectContaining({ kind: 'notice', text: 'Compacted' })])

    const live = fold([
      sdk({ type: 'system', subtype: 'local_command_output', uuid: 'o1', content: `${stdout}\nPostCompact [./check.sh] failed with exit code 2` })
    ])
    expect(live.items).toEqual([expect.objectContaining({ kind: 'notice', text: 'Compacted\nPostCompact [./check.sh] failed with exit code 2' })])
  })

  it('counts a subagent\'s calls on its Agent row instead of listing them', () => {
    const state = fold([
      sdk({ type: 'assistant', message: { id: 'm', content: [{ type: 'tool_use', id: 'a1', name: 'Agent', input: { description: 'Find callers' } }] }, parent_tool_use_id: null }),
      sdk({ type: 'assistant', message: { id: 'sub', content: [{ type: 'tool_use', id: 's1', name: 'Grep', input: { pattern: 'foo' } }] }, parent_tool_use_id: 'a1' }),
      sdk({ type: 'assistant', message: { id: 'sub', content: [{ type: 'tool_use', id: 's2', name: 'Read', input: { file_path: '/x/y.ts' } }] }, parent_tool_use_id: 'a1' })
    ])
    expect(state.items).toHaveLength(1)
    expect(state.items[0]).toMatchObject({ kind: 'tool', label: 'Agent · Find callers', childCount: 2, lastChild: 'Reading y.ts' })
  })

  it('fails queued messages and open tools when the process dies', () => {
    const running = fold([
      { t: 'sent', uuid: 'u1', text: 'go', images: 0 },
      sdk({ type: 'assistant', message: { id: 'm', content: [{ type: 'tool_use', id: 't', name: 'Bash', input: { command: 'x' } }] }, parent_tool_use_id: null }),
      { t: 'prompt', prompt: { id: 'p', kind: 'permission', toolName: 'Bash', toolUseId: 't', input: {} } }
    ])
    const dead = reduceChat(running, { t: 'process', state: 'exited', error: 'ssh: connection closed' })
    expect(dead.busy).toBe(false)
    expect(dead.pending).toHaveLength(0)
    expect(dead.items[0]).toMatchObject({ kind: 'user', failed: true })
    expect(dead.items[1]).toMatchObject({ kind: 'tool', status: 'error' })
    expect(dead.items[dead.items.length - 1]).toMatchObject({ kind: 'notice', tone: 'error' })
  })

  it('shares unchanged items between states', () => {
    const before = fold(turn())
    const after = reduceChat(before, { t: 'notice', text: 'x', tone: 'muted' })
    expect(after.items[0]).toBe(before.items[0])
  })
})

describe('buildTimeline', () => {
  it('folds runs of reads and searches and hides empty blocks', () => {
    const state = fold([
      sdk({ type: 'assistant', message: { id: 'm', content: [{ type: 'tool_use', id: 'a', name: 'Read', input: { file_path: '/a.ts' } }] }, parent_tool_use_id: null }),
      sdk({ type: 'assistant', message: { id: 'm', content: [{ type: 'thinking', thinking: 'hmm' }] }, parent_tool_use_id: null }),
      sdk({ type: 'assistant', message: { id: 'm', content: [{ type: 'tool_use', id: 'b', name: 'Grep', input: { pattern: 'x' } }] }, parent_tool_use_id: null }),
      sdk({ type: 'assistant', message: { id: 'm', content: [{ type: 'tool_use', id: 'c', name: 'Read', input: { file_path: '/c.ts' } }] }, parent_tool_use_id: null }),
      sdk({ type: 'assistant', message: { id: 'm', content: [{ type: 'tool_use', id: 'd', name: 'Edit', input: { file_path: '/c.ts', old_string: 'a', new_string: 'b' } }] }, parent_tool_use_id: null })
    ])
    const rows = buildTimeline(state.items)
    expect(rows.map((row) => row.type)).toEqual(['group', 'item'])
    expect(rows[0].type === 'group' && summarizeGroup(rows[0].tools)).toBe('Read 2 files · searched 1 time')
  })
})

describe('tool result images', () => {
  const read = (id: string): ChatEvent => sdk({ type: 'assistant', message: { id: 'm', content: [{ type: 'tool_use', id, name: 'Read', input: { file_path: `/${id}.png` } }] }, parent_tool_use_id: null })
  const result = (id: string, content: unknown): ChatEvent => sdk({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] }, parent_tool_use_id: null })
  const png = (data: string, mediaType?: string): unknown => ({ type: 'image', source: { type: 'base64', data, ...(mediaType ? { media_type: mediaType } : {}) } })

  it('keeps a result image on its tool', () => {
    const state = fold([read('a'), read('b'), result('a', '1\tx'), result('b', [png('iVBOR')])])
    const shot = state.items.find((item) => item.kind === 'tool' && item.id === 'b')
    expect(shot?.kind === 'tool' && shot.images).toEqual([{ mediaType: 'image/png', data: 'iVBOR' }])
    expect(shot?.kind === 'tool' && shot.result).toBe('')
  })

  it('counts images it will not draw', () => {
    const state = fold([read('a'), result('a', [{ type: 'text', text: 'ok' }, png('x', 'image/svg+xml'), png('y', 'image/jpeg')])])
    const tool = state.items[0]
    expect(tool.kind === 'tool' && tool.images).toEqual([{ mediaType: 'image/jpeg', data: 'y' }])
    expect(tool.kind === 'tool' && tool.result).toBe('ok\n[image not shown]')
  })
})

describe('buildTimeline folding', () => {
  const call = (id: string, name: string, input: Record<string, unknown> = {}): ChatEvent =>
    sdk({ type: 'assistant', message: { id: 'm', content: [{ type: 'tool_use', id, name, input }] }, parent_tool_use_id: null })
  const done = (id: string): ChatEvent =>
    sdk({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] }, parent_tool_use_id: null })
  const reply = sdk({ type: 'assistant', message: { id: 'r', content: [{ type: 'text', text: 'Done.' }] }, parent_tool_use_id: null })

  it('shows calls one by one while the run is going', () => {
    const state = fold([call('a', 'Bash', { command: 'ls' }), done('a'), call('b', 'Edit', { file_path: '/x' }), call('c', 'Read'), call('d', 'Grep')])
    expect(buildTimeline(state.items, true).map((row) => row.type)).toEqual(['item', 'item', 'group'])
  })

  it('folds a finished run into one row once something follows it', () => {
    const events = [call('a', 'Bash', { command: 'ls' }), call('b', 'Edit', { file_path: '/x' }), call('c', 'Edit', { file_path: '/x' }), call('d', 'Read'), done('a'), done('b'), done('c'), done('d')]
    const state = fold([...events, reply])
    const rows = buildTimeline(state.items, true)
    expect(rows.map((row) => row.type)).toEqual(['group', 'item'])
    expect(rows[0].type === 'group' && summarizeGroup(rows[0].tools)).toBe('Read 1 file · edited 1 file · ran 1 command')
    // The turn ended with no reply after the calls: folded too.
    expect(buildTimeline(fold(events).items, false).map((row) => row.type)).toEqual(['group'])
  })

  it('leaves a run with a call still going unfolded, and todos standing alone', () => {
    const state = fold([call('a', 'Bash', { command: 'ls' }), call('b', 'Bash', { command: 'pwd' }), done('a'), call('t', 'TodoWrite', { todos: [] }), done('t'), reply])
    expect(buildTimeline(state.items, true).map((row) => row.type)).toEqual(['item', 'item', 'item', 'item'])
  })
})

describe('usage meter', () => {
  it('bands context by tokens, not percent', () => {
    expect(contextTone(149_999)).toBe('success')
    expect(contextTone(150_000)).toBe('warn')
    expect(contextTone(200_000)).toBe('warn')
    expect(contextTone(200_001)).toBe('danger')
  })

  it('formats tokens and cost compactly', () => {
    expect(formatTokens(16_959)).toBe('17k')
    expect(formatTokens(1_000_000)).toBe('1M')
    expect(formatTokens(1_250_000)).toBe('1.3M')
    expect(formatTokens(812)).toBe('812')
    expect(formatCost(0.4213)).toBe('$0.42')
    expect(formatCost(12.34)).toBe('$12.3')
  })

  it('counts down to a reset in hours and minutes', () => {
    const now = Date.parse('2026-09-23T10:00:00Z')
    expect(formatResetIn('2026-09-23T10:41:20Z', now)).toBe('42m')
    expect(formatResetIn('2026-09-23T13:12:00Z', now)).toBe('3h 12m')
    expect(formatResetIn('2026-09-25T15:00:00Z', now)).toBe('2d 5h')
    expect(formatResetIn('2026-09-23T09:59:00Z', now)).toBe('now')
  })

  it('names the reset on the clock, with the weekday when it is not today', () => {
    // Local times, so the check holds in any time zone.
    const now = new Date(2026, 8, 23, 10, 0).getTime()
    const time = (h: number, m: number): string => new Date(2026, 8, 23, h, m).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    expect(formatResetAt(new Date(2026, 8, 23, 14, 30).toISOString(), now)).toBe(time(14, 30))
    const later = new Date(2026, 8, 24, 9, 10)
    expect(formatResetAt(later.toISOString(), now)).toBe(`${later.toLocaleDateString([], { weekday: 'short' })} ${time(9, 10)}`)
    expect(formatResetAt('not a date', now)).toBe('')
  })

  it('colours a plan window by the share used', () => {
    expect(limitTone(38)).toBe('success')
    expect(limitTone(75)).toBe('success')
    expect(limitTone(81)).toBe('warn')
    expect(limitTone(96)).toBe('danger')
  })

  it('merges usage from meta events and keeps it across a reset', () => {
    const state = fold([
      { t: 'meta', usage: { contextTokens: 10, contextMax: 100 } },
      { t: 'meta', usage: { costUsd: 1.5 } },
      { t: 'reset' }
    ])
    expect(state.usage).toEqual({ contextTokens: 10, contextMax: 100, costUsd: 1.5 })
  })
})

describe('diff', () => {
  it('diffs an edit by lines', () => {
    const lines = diffLines('a\nb\nc', 'a\nB\nc')
    expect(lines.map((l) => `${l.kind}:${l.text}`)).toEqual(['same:a', 'del:b', 'add:B', 'same:c'])
    expect(diffStats(lines)).toEqual({ added: 1, removed: 1 })
  })

  it('reads edit pairs off the edit tools', () => {
    expect(editPairs('Write', { content: 'x\ny' })).toEqual([{ before: '', after: 'x\ny' }])
    expect(editPairs('MultiEdit', { edits: [{ old_string: 'a', new_string: 'b' }] })).toEqual([{ before: 'a', after: 'b' }])
    expect(editPairs('Bash', { command: 'ls' })).toBeNull()
  })
})

describe('remote spawn', () => {
  it('drops login-shell noise before the first JSON line', async () => {
    const dropped: string[] = []
    const gate = new JsonLineGate((line) => dropped.push(line))
    const source = new PassThrough()
    source.pipe(gate)
    const out: string[] = []
    gate.on('data', (chunk: Buffer) => out.push(chunk.toString()))
    source.write('Welcome to host\nbash: no job control in this shell\n{"type":"sys')
    source.write('tem"}\n{"type":"x"}\n')
    source.end()
    await new Promise((resolve) => gate.on('end', resolve))
    expect(out.join('')).toBe('{"type":"system"}\n{"type":"x"}\n')
    expect(dropped).toEqual(['Welcome to host', 'bash: no job control in this shell'])
  })

  it('forwards only the env the SDK added', () => {
    expect(sdkAddedEnv(
      { PATH: '/usr/bin', HOME: '/h', CLAUDE_CODE_ENTRYPOINT: 'sdk-ts', CLAUDE_AGENT_SDK_VERSION: '1', FOO: 'bar' },
      { PATH: '/usr/bin', HOME: '/h' }
    )).toEqual({ CLAUDE_CODE_ENTRYPOINT: 'sdk-ts', CLAUDE_AGENT_SDK_VERSION: '1' })
  })

  it('builds a transcript read that only accepts session ids', () => {
    expect(remoteTranscriptScript('0f8f2d7a-1b2c-4d5e-8f90-123456789abc')).toContain('0f8f2d7a-1b2c-4d5e-8f90-123456789abc.jsonl')
    expect(() => remoteTranscriptScript('x; rm -rf ~')).toThrow()
  })

  it('parses transcript JSONL and skips a torn last line', () => {
    expect(parseTranscriptLines('{"a":1}\n\n{"b":2}\n{"c":')).toEqual([{ a: 1 }, { b: 2 }])
  })
})

describe('findModelOption', () => {
  const models = [
    { value: 'default', displayName: 'Default' },
    { value: 'opus[1m]', resolvedModel: 'claude-opus-5-5[1m]', displayName: 'Opus (1M context)' },
    { value: 'haiku', resolvedModel: 'claude-haiku-4-5', displayName: 'Haiku' }
  ]
  it('matches aliases, resolved ids and dated ids', () => {
    expect(findModelOption(models, 'haiku')?.displayName).toBe('Haiku')
    expect(findModelOption(models, 'claude-haiku-4-5-20251001')?.displayName).toBe('Haiku')
    expect(findModelOption(models, 'claude-opus-5-5[1m]')?.displayName).toBe('Opus (1M context)')
    expect(findModelOption(models, 'claude-mystery-1')).toBeUndefined()
  })
})

describe('chat session helpers', () => {
  it('turns project CLI args into SDK extraArgs', () => {
    expect(extraArgsRecord(['--model', 'opus', '--verbose', '--add-dir=/x', 'stray'])).toEqual({ model: 'opus', verbose: null, 'add-dir': '/x' })
  })

  it('drops protocol chatter no window draws', () => {
    expect(isDisplayRelevant({ type: 'system', subtype: 'hook_started' })).toBe(false)
    expect(isDisplayRelevant({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'input_json_delta' } } })).toBe(false)
    expect(isDisplayRelevant({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta' } } })).toBe(true)
    expect(isDisplayRelevant({ type: 'rate_limit_event' })).toBe(false)
    expect(isDisplayRelevant({ type: 'assistant' })).toBe(true)
  })
})

describe('SessionStart and the cold cache', () => {
  const resumed = {
    session_id: 's1', hook_event_name: 'SessionStart', source: 'resume',
    seconds_since_last_response: 6888, context_tokens: 31753,
    prompt_cache_likely_expired: true, estimated_cache_write_usd: 0.0635
  }
  const response = (stderr: string, hookEvent = 'SessionStart'): unknown => ({
    type: 'system', subtype: 'hook_response', hook_event: hookEvent, hook_name: `${hookEvent}:resume`, stdout: '{}', stderr, outcome: 'success'
  })

  it('reads the input our hook echoed to stderr', () => {
    expect(sessionStartInput(response(JSON.stringify(resumed)))).toEqual(resumed)
  })

  it("ignores other hooks' output", () => {
    expect(sessionStartInput(response('warning: something'))).toBeNull()
    expect(sessionStartInput(response('{"not":"ours"}'))).toBeNull()
    expect(sessionStartInput(response('{broken'))).toBeNull()
    expect(sessionStartInput(response(JSON.stringify(resumed), 'Stop'))).toBeNull()
    expect(sessionStartInput({ type: 'system', subtype: 'hook_started', hook_event: 'SessionStart' })).toBeNull()
  })

  it('flags only a resume whose cache the CLI thinks expired', () => {
    expect(coldCacheFrom(resumed)).toEqual({ contextTokens: 31753, idleSeconds: 6888, estimatedUsd: 0.0635 })
    expect(coldCacheFrom({ ...resumed, prompt_cache_likely_expired: false })).toBeNull()
    expect(coldCacheFrom({ ...resumed, source: 'startup' })).toBeNull()
    expect(coldCacheFrom({ ...resumed, context_tokens: 0 })).toBeNull()
    // An older CLI without the fields says nothing.
    expect(coldCacheFrom({ session_id: 's1', hook_event_name: 'SessionStart', source: 'resume' })).toBeNull()
  })

  it('shows until the first send, and not for a send-triggered restart', () => {
    const cache = { contextTokens: 31753 }
    let state = reduceChat(emptyChatState(), { t: 'cold-cache', cache })
    expect(state.coldCache).toBe(cache)
    state = reduceChat(state, { t: 'sent', uuid: 'u1', text: 'hi', images: 0 })
    expect(state.coldCache).toBeUndefined()
    expect(reduceChat(state, { t: 'cold-cache', cache }).coldCache).toBeUndefined()
  })

  it('words the warning', () => {
    expect(coldCacheText({ contextTokens: 31753, idleSeconds: 6888, estimatedUsd: 0.0635 }))
      .toBe('Prompt cache expired (idle 1h 54m). Your next message re-caches ~32k tokens of context (≈ $0.06).')
    expect(coldCacheText({ contextTokens: 900, estimatedUsd: 0.002 }))
      .toBe('Prompt cache expired. Your next message re-caches ~900 tokens of context (≈ <$0.01).')
    expect(formatIdle(30)).toBe('1m')
    expect(formatIdle(3 * 86400 + 4 * 3600 + 60)).toBe('3d 4h')
  })
})

describe('chat tabs', () => {
  it('gives a chat tab its own session id up front', () => {
    const tab = createTab('claude-chat')
    expect(tab.title).toBe('Claude')
    expect(tab.sessionId).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('opens Claude as the configured view', () => {
    expect(claudeTabType('claude', 'chat')).toBe('claude-chat')
    expect(claudeTabType('claude', 'terminal')).toBe('claude')
    expect(claudeTabType('pi', 'chat')).toBe('pi')
  })
})
