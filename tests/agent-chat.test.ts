import { afterEach, describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { emptyChatState, reduceChat, type ChatEvent, type ChatState } from '../src/shared/claude-chat'
import { ClaudeChatManager, type ChatManagerDeps, type ChatTabConfig } from '../src/main/claude-chat/chat-manager'
import { codexContextUsage, codexHistoryRows, codexItemRows, codexModels, codexRateLimits, unifiedDiffEdits, unwrapShellCommand } from '../src/main/agent-chat/codex-translate'
import { codexConfigArgs } from '../src/main/agent-chat/codex-session'
import { piHistoryRows, piModels, piTool, piUsage } from '../src/main/agent-chat/pi-translate'
import { piExtraArgs } from '../src/main/agent-chat/pi-session'
import { JsonlReader } from '../src/main/agent-chat/session'

function fold(events: ChatEvent[], start: ChatState = emptyChatState()): ChatState {
  return events.reduce(reduceChat, start)
}

describe('agent-neutral chat events', () => {
  it('streams deltas into one row and settles it when the turn ends', () => {
    const state = fold([
      { t: 'sent', uuid: 'u1', text: 'hi', images: 0, at: 1 },
      { t: 'turn', state: 'start', at: 2 },
      { t: 'delivered', uuid: 'u1' },
      { t: 'delta', id: 'm1', kind: 'text', text: 'Hel', at: 3 },
      { t: 'delta', id: 'm1', kind: 'text', text: 'lo', at: 4 },
      { t: 'turn', state: 'end', at: 5 }
    ])
    expect(state.busy).toBe(false)
    expect(state.items).toEqual([
      { kind: 'user', id: 'u1', text: 'hi', images: 0, queued: false, at: 1 },
      { kind: 'text', id: 'm1', text: 'Hello', streaming: false, at: 3 }
    ])
  })

  it('upserts tool rows by id, keeping a prompt-held row waiting', () => {
    const tool = { kind: 'tool' as const, id: 't1', name: 'Bash', label: 'Bash · ls', input: { command: 'ls' }, status: 'running' as const }
    let state = fold([
      { t: 'turn', state: 'start', at: 1 },
      { t: 'item', item: tool, at: 1 },
      { t: 'prompt', prompt: { id: 'p1', kind: 'permission', toolName: 'Bash', toolUseId: 't1', input: { command: 'ls' } } },
      { t: 'item', item: { ...tool, result: 'partial' }, at: 2 }
    ])
    expect(state.items).toHaveLength(1)
    expect(state.items[0]).toMatchObject({ status: 'waiting', result: 'partial', at: 1 })
    state = fold([
      { t: 'prompt-done', id: 'p1', allowed: true },
      { t: 'item', item: { ...tool, status: 'done', result: 'a.txt' } }
    ], state)
    expect(state.items[0]).toMatchObject({ status: 'done', result: 'a.txt' })
  })

  it('ends an interrupted turn with a muted notice, a failed one with its error', () => {
    const interrupted = fold([{ t: 'turn', state: 'start' }, { t: 'interrupting' }, { t: 'turn', state: 'end' }])
    expect(interrupted.items[interrupted.items.length - 1]).toMatchObject({ kind: 'notice', text: 'Interrupted', tone: 'muted' })
    const failed = fold([{ t: 'turn', state: 'start' }, { t: 'turn', state: 'end', error: 'quota' }])
    expect(failed.items[failed.items.length - 1]).toMatchObject({ kind: 'notice', text: 'quota', tone: 'error' })
  })

  it('restores history only into an empty timeline', () => {
    const rows = [{ kind: 'text' as const, id: 'h', text: 'old' }]
    expect(fold([{ t: 'restore', items: rows }]).items).toEqual(rows)
    const busy = fold([{ t: 'notice', text: 'x', tone: 'muted' }, { t: 'restore', items: rows }])
    expect(busy.items).toHaveLength(1)
  })
})

describe('codex translation', () => {
  it('unwraps the login shell Codex runs commands in', () => {
    expect(unwrapShellCommand('/opt/homebrew/bin/zsh -lc ls')).toBe('ls')
    expect(unwrapShellCommand('/bin/zsh -lc "printf \'hi\' > hello.txt"')).toBe("printf 'hi' > hello.txt")
    expect(unwrapShellCommand("bash -lc 'echo \"x\"'")).toBe('echo "x"')
    expect(unwrapShellCommand('git status')).toBe('git status')
    // Approval cards show this: a lookalike shell or a second argument stays visible.
    expect(unwrapShellCommand('/tmp/fake-sh -lc ls')).toBe('/tmp/fake-sh -lc ls')
    expect(unwrapShellCommand('/tmp/x/sh -lc ls')).toBe('/tmp/x/sh -lc ls')
    expect(unwrapShellCommand('/bin/zsh -lc "ls" ; rm -rf x "y"')).toBe('/bin/zsh -lc "ls" ; rm -rf x "y"')
    expect(unwrapShellCommand("/bin/zsh -lc 'ls' ; rm 'y'")).toBe("/bin/zsh -lc 'ls' ; rm 'y'")
    expect(unwrapShellCommand('/bin/zsh -lc ls;rm')).toBe('/bin/zsh -lc ls;rm')
  })

  it('splits a unified diff into hunks', () => {
    const diff = '--- a/f.ts\n+++ b/f.ts\n@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n@@ -9,1 +9,2 @@\n x\n+y\n'
    expect(unifiedDiffEdits(diff)).toEqual([
      { old_string: 'a\nb\nc', new_string: 'a\nB\nc' },
      { old_string: 'x', new_string: 'x\ny' }
    ])
  })

  it('draws items with Claude tool names', () => {
    expect(codexItemRows({ type: 'commandExecution', id: 'e', command: '/bin/zsh -lc ls', status: 'completed', aggregatedOutput: 'a\n', exitCode: 0 }))
      .toMatchObject([{ kind: 'tool', id: 'e', name: 'Bash', input: { command: 'ls' }, status: 'done', result: 'a' }])
    const rows = codexItemRows({ type: 'fileChange', id: 'f', status: 'inProgress', changes: [
      { path: '/p/new.txt', kind: { type: 'add' }, diff: '@@ -0,0 +1 @@\n+hi\n' },
      { path: '/p/old.txt', kind: { type: 'update', move_path: null }, diff: '@@ -1 +1 @@\n-a\n+b\n' }
    ] })
    expect(rows).toMatchObject([
      { id: 'f', name: 'Write', input: { file_path: '/p/new.txt', content: 'hi' }, status: 'running' },
      { id: 'f:1', name: 'MultiEdit', input: { file_path: '/p/old.txt', edits: [{ old_string: 'a', new_string: 'b' }] } }
    ])
    expect(codexItemRows({ type: 'reasoning', id: 'r', summary: ['one', 'two'], content: [] })).toEqual([{ kind: 'thinking', id: 'r', text: 'one\n\ntwo' }])
    expect(codexItemRows({ type: 'agentMessage', id: 'm', text: '' })).toEqual([])
  })

  it('reads history, models and usage', () => {
    expect(codexHistoryRows([{ id: 't', status: 'interrupted', items: [{ type: 'userMessage', id: 'u', content: [{ type: 'text', text: 'q' }, { type: 'localImage', path: '/x.png' }] }] }]))
      .toEqual([{ kind: 'user', id: 'u', text: 'q', images: 1 }, { kind: 'notice', id: 't:end', text: 'Interrupted', tone: 'muted' }])
    expect(codexModels([{ id: 'a', displayName: 'A', hidden: false, supportedReasoningEfforts: [{ reasoningEffort: 'low' }] }, { id: 'b', hidden: true }]))
      .toEqual([{ value: 'a', displayName: 'A', supportedEffortLevels: ['low'] }])
    expect(codexContextUsage({ last: { inputTokens: 100, outputTokens: 5 }, modelContextWindow: 1000 })).toEqual({ contextTokens: 105, contextMax: 1000 })
    expect(codexRateLimits({ primary: { usedPercent: 49, windowDurationMins: 10080, resetsAt: 0 }, secondary: null }))
      .toEqual({ sevenDay: { utilization: 49, resetsAt: '1970-01-01T00:00:00.000Z' } })
  })

  it('passes only config overrides to app-server', () => {
    expect(codexConfigArgs(['--search', '-c', 'model="x"', '--config=a=1', 'prompt'])).toEqual(['-c', 'model="x"', '-c', 'a=1'])
  })
})

describe('pi translation', () => {
  it('maps Pi tools to Claude ones', () => {
    expect(piTool('edit', { path: 'a.ts', edits: [{ oldText: 'x', newText: 'y' }] })).toEqual({ name: 'MultiEdit', input: { file_path: 'a.ts', edits: [{ old_string: 'x', new_string: 'y' }] } })
    expect(piTool('read', { path: 'a.ts' })).toEqual({ name: 'Read', input: { file_path: 'a.ts' } })
    expect(piTool('custom', { q: 1 })).toEqual({ name: 'custom', input: { q: 1 } })
  })

  it('reads history with tool results and errors', () => {
    const rows = piHistoryRows([
      { role: 'user', content: 'q' },
      { role: 'assistant', content: [{ type: 'toolCall', id: 'c', name: 'bash', arguments: { command: 'ls' } }] },
      { role: 'toolResult', toolCallId: 'c', content: [{ type: 'text', text: 'out' }], isError: true },
      { role: 'assistant', content: [], stopReason: 'error', errorMessage: 'OAuth refresh failed' }
    ])
    expect(rows).toMatchObject([
      { kind: 'user', text: 'q' },
      { kind: 'tool', id: 'c', name: 'Bash', status: 'error', result: 'out' },
      { kind: 'notice', text: 'OAuth refresh failed', tone: 'error' }
    ])
  })

  it('reads models and usage', () => {
    expect(piModels([{ id: 'm', name: 'M', provider: 'p', reasoning: true, thinkingLevelMap: { max: 'max' } }]))
      .toEqual([{ value: 'p/m', displayName: 'M', description: 'p', supportedEffortLevels: ['off', 'minimal', 'low', 'medium', 'high', 'max'] }])
    expect(piUsage({ contextUsage: { tokens: 10, contextWindow: 100 }, cost: 0.5 })).toEqual({ contextTokens: 10, contextMax: 100, costUsd: 0.5 })
  })

  it('keeps the project args that do not fight RPC mode', () => {
    expect(piExtraArgs(['--mode', 'text', '--model', 'x', '--no-session', '--session-id', 's', '-e', 'ext.ts'])).toEqual(['--model', 'x', '-e', 'ext.ts'])
  })

  it('splits JSON records on LF only', () => {
    const records: unknown[] = []
    const reader = new JsonlReader((r) => records.push(r))
    reader.push('{"a":"x y"}\r\n{"b"')
    reader.push(':1}\n')
    expect(records).toEqual([{ a: 'x y' }, { b: 1 }])
  })
})

const dirs: string[] = []
const managers: ClaudeChatManager[] = []
afterEach(() => {
  for (const chats of managers.splice(0)) chats.closeAll()
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function manager() {
  const events: ChatEvent[] = []
  const hooks: string[] = []
  const fakes = { codex: path.resolve('tests/helpers/fake-codex.mjs'), pi: path.resolve('tests/helpers/fake-pi.mjs') }
  const deps: ChatManagerDeps = {
    sendToClient: (_clientId, channel, _tabId, _seq, event) => { if (channel === 'chat-event') events.push(event as ChatEvent) },
    resolveLocalClaude: () => 'claude',
    resolveLocalAgent: (agent) => fakes[agent],
    wrapSpawn: (file, args) => ({ file: process.execPath, args: [file, ...args] }),
    localEnv: () => process.env,
    ensureSsh: async () => {},
    remoteCommand: () => { throw new Error('no ssh here') },
    bashSpawn: (config, command) => ({ file: '/bin/sh', args: ['-c', command], cwd: config.cwd }),
    claudeSpawn: () => { throw new Error('no claude here') },
    remoteExec: async () => '',
    onHook: (_tabId, body) => { hooks.push(String(body.hook_event_name)) },
    onPromptResolved: () => {},
    onProcessChange: () => {},
    log: () => {}
  }
  const chats = new ClaudeChatManager(deps)
  managers.push(chats)
  return { chats, events, hooks }
}

function config(agent: 'codex' | 'pi', sessionId: string): ChatTabConfig {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'devtool-agent-chat-'))
  dirs.push(cwd)
  return { agent, cwd, sessionId, projectId: 'p' }
}

describe('codex chat session', () => {
  it('starts a thread, holds the approval as a card and folds the turn', async () => {
    const { chats, hooks } = manager()
    await chats.attach('win', 'tab', config('codex', 'fresh-id'))
    await expect.poll(() => chats.snapshot('tab')?.state.process).toBe('running')
    const ready = chats.snapshot('tab')?.state
    expect(ready?.info).toMatchObject({ agent: 'codex', sessionId: 'thread-new', permissionMode: 'ask' })
    expect(ready?.models).toEqual([{ value: 'gpt-x', displayName: 'GPT X', description: 'fast', supportedEffortLevels: ['low', 'high'] }])
    expect(hooks).toContain('SessionStart')

    await chats.send('tab', 'list files')
    await expect.poll(() => chats.snapshot('tab')?.state.pending.length).toBe(1)
    const waiting = chats.snapshot('tab')!.state
    expect(waiting.pending[0]).toMatchObject({ kind: 'permission', toolName: 'Bash', toolUseId: 'exec-1', input: { command: 'ls' }, reason: 'listing' })
    expect(waiting.items.find((item) => item.id === 'exec-1')).toMatchObject({ status: 'waiting' })

    expect(chats.respond('tab', waiting.pending[0].id, { behavior: 'allow' })).toBe(true)
    await expect.poll(() => chats.snapshot('tab')?.state.busy).toBe(false)
    const done = chats.snapshot('tab')!.state
    expect(done.items).toMatchObject([
      { kind: 'user', text: 'list files', queued: false },
      { kind: 'tool', id: 'exec-1', name: 'Bash', status: 'done', result: 'a.txt' },
      { kind: 'text', id: 'msg-1', text: 'Done.' }
    ])
    expect(done.usage).toMatchObject({ contextTokens: 1020, contextMax: 200000, fiveHour: { utilization: 12 }, sevenDay: { utilization: 40 } })
    expect(hooks).toEqual(expect.arrayContaining(['UserPromptSubmit', 'PermissionRequest', 'PreToolUse', 'PostToolUse', 'Stop']))
  }, 20_000)

  it('resumes a known thread with its history', async () => {
    const { chats } = manager()
    await chats.attach('win', 'tab', config('codex', 'known'))
    await expect.poll(() => chats.snapshot('tab')?.state.items.length).toBe(2)
    expect(chats.snapshot('tab')!.state.items).toMatchObject([
      { kind: 'user', text: 'earlier question' },
      { kind: 'text', text: 'earlier answer' }
    ])
  }, 20_000)

  it('turns down SSH projects', async () => {
    const { chats } = manager()
    await chats.attach('win', 'tab', { ...config('codex', 'x'), sshConfig: { host: 'h', username: 'u', remoteDir: '/r' } as ChatTabConfig['sshConfig'] })
    await expect.poll(() => chats.snapshot('tab')?.state.processError).toMatch(/SSH projects/)
  })
})

describe('pi chat session', () => {
  it('restores history, then streams a prompt with its tool call', async () => {
    const { chats, hooks } = manager()
    await chats.attach('win', 'tab', config('pi', 'known'))
    await expect.poll(() => chats.snapshot('tab')?.state.commands.length).toBe(1)
    const ready = chats.snapshot('tab')!.state
    expect(ready.items).toMatchObject([
      { kind: 'user', text: 'earlier question' },
      { kind: 'tool', id: 'h-call', name: 'Read', status: 'done', result: 'notes' },
      { kind: 'text', text: 'earlier answer' }
    ])
    expect(ready.info).toMatchObject({ agent: 'pi', applied: { model: 'prov/m1', effort: 'medium' } })
    expect(ready.usage).toMatchObject({ contextTokens: 5000, contextMax: 100000, costUsd: 0.12 })

    await chats.send('tab', 'what is here?')
    await expect.poll(() => hooks.includes('Stop')).toBe(true)
    await expect.poll(() => chats.snapshot('tab')?.state.busy).toBe(false)
    expect(chats.snapshot('tab')!.state.items.slice(3)).toMatchObject([
      { kind: 'user', text: 'what is here?', queued: false },
      { kind: 'thinking', text: 'Let me look' },
      { kind: 'tool', id: 'call-1', name: 'Bash', input: { command: 'ls' }, status: 'done', result: 'a.txt' },
      { kind: 'text', text: 'Found a.txt' }
    ])
    expect(chats.snapshot('tab')!.state.items.some((item) => 'streaming' in item && item.streaming)).toBe(false)
    expect(hooks).toEqual(expect.arrayContaining(['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop']))
  }, 20_000)
})

describe('phone view of Codex and Pi chats', () => {
  it('names the agent and its own pickers', async () => {
    const { viewSettings, toChatView } = await import('../src/main/mobile/chat-view')
    const codex = { ...emptyChatState(), info: { agent: 'codex' as const, permissionMode: 'ask' } }
    expect(toChatView(codex, { tabId: 't', title: 'Codex' })).toMatchObject({ agent: 'codex', permissionMode: 'ask' })
    expect(viewSettings(codex.info, []).modes?.map((m) => m.value)).toEqual(['read-only', 'ask', 'auto', 'full-access'])
    expect(viewSettings({ agent: 'pi' }, [])).toMatchObject({ efforts: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'], effortLabel: 'Thinking', modes: [] })
    const claude = viewSettings({}, [])
    expect(claude.modes).toBeUndefined()
    expect(toChatView(emptyChatState(), { tabId: 't', title: 'Claude' })).not.toHaveProperty('agent')
  })

  it('lists only the agent\'s own commands', async () => {
    const { chatCommands } = await import('../src/main/mobile/chat-bridge')
    const state = { ...emptyChatState(), commands: [{ name: 'fix-tests', description: 'Fix them' }, { name: 'config', description: '' }] }
    expect(chatCommands(state, 'pi').commands).toEqual([{ name: 'fix-tests', description: 'Fix them' }, { name: 'config' }])
    const claude = chatCommands(state).commands
    expect(claude.map((c) => c.name)).toContain('btw')
    expect(claude.find((c) => c.name === 'config')?.terminalOnly).toBe(true)
  })
})
