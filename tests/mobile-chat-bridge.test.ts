import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatBridge, CHAT_EVENT_INTERVAL_MS, type ChatPhone } from '../src/main/mobile/chat-bridge'
import { createHomeTask, type ProjectsData, type Tab } from '../src/shared/types'
import type { ChatItem, ChatPrompt, ChatState } from '../src/shared/claude-chat'
import type { AppMessage, ChatParams, ChatViewEvent } from '../protocol/ts/index.ts'
import { FakeChats } from './helpers/fake-chats'

const chatTab: Tab = { id: 'tab-chat', type: 'claude-chat', title: 'Claude', sessionId: 'sess-1' }

function projects(overrides: { hide?: boolean; tabs?: Tab[] } = {}): ProjectsData {
  return {
    projects: [{
      id: 'p1', name: 'api', directory: '/src/api', hideFromMobile: overrides.hide, aiToolArgs: { claude: '--verbose  --x' },
      tasks: [
        { ...createHomeTask('p1').task, tabs: { left: [{ id: 'tab-home-chat', type: 'claude-chat', title: 'Home', sessionId: 's' }], right: [] } },
        {
          id: 't1', name: 'fix', workspace: { worktreePath: '/wt/fix', relativeProjectPath: 'pkg' },
          tabs: { left: overrides.tabs ?? [chatTab, { id: 'tab-term', type: 'terminal', title: 'zsh' }, { id: 'tab-new', type: 'claude-chat', title: 'New' }], right: [] },
          activeTab: { left: 'tab-chat', right: null }, splitOpen: false, splitRatio: 0.5
        }
      ]
    }],
    tags: [],
    projectOrder: ['p1'],
    pinnedItems: []
  } as ProjectsData
}

function text(id: string, value: string, streaming = false): ChatItem {
  return streaming ? { kind: 'text', id, text: value, streaming: true } : { kind: 'text', id, text: value }
}

const bashPrompt: ChatPrompt = { id: 'pr1', kind: 'permission', toolName: 'Bash', input: { command: 'npm test' }, suggestions: [{ type: 'addRules' }] }
const questionPrompt: ChatPrompt = {
  id: 'pr2', kind: 'question', toolName: 'AskUserQuestion',
  input: { questions: [{ question: 'Which DB?', options: [{ label: 'Postgres' }, { label: 'SQLite' }] }, { question: 'Tests?', multiSelect: true, options: [{ label: 'unit' }, { label: 'e2e' }] }] }
}
const planPrompt: ChatPrompt = { id: 'pr3', kind: 'plan', toolName: 'ExitPlanMode', input: { plan: '1. do it' } }

describe('ChatBridge', () => {
  let chats: FakeChats
  let data: ProjectsData
  let bridge: ChatBridge
  let phone: ChatPhone & { messages: AppMessage[] }
  let logs: string[]

  beforeEach(() => {
    vi.useFakeTimers()
    chats = new FakeChats()
    data = projects()
    logs = []
    bridge = new ChatBridge({
      chats,
      projects: { peek: () => data },
      timers: { now: () => Date.now(), setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) },
      log: (m) => logs.push(m)
    })
    phone = makePhone('phone-1')
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  function makePhone(id: string): ChatPhone & { messages: AppMessage[] } {
    const messages: AppMessage[] = []
    return { id, messages, send: (m) => { messages.push(m); return true } }
  }

  let nextId = 1
  async function req(op: string, params: ChatParams, who = phone): Promise<AppMessage> {
    const id = nextId++
    bridge.request(who, id, op, params)
    await vi.advanceTimersByTimeAsync(0)
    const res = who.messages.find((m) => m.t === 'res' && m.id === id)
    if (!res) throw new Error(`no response to ${op}`)
    return res
  }

  function events(who = phone): ChatViewEvent[] {
    return who.messages.filter((m): m is ChatViewEvent => m.t === 'evt' && m.e === 'chat')
  }

  it('answers not-found for unknown, hidden, home, non-chat and never-mounted tabs', async () => {
    for (const tabId of ['nope', 'tab-term', 'tab-home-chat', 'tab-new']) {
      expect(await req('chat.open', { tabId })).toMatchObject({ ok: false, error: { code: 'not-found' } })
    }
    data = projects({ hide: true })
    expect(await req('chat.open', { tabId: 'tab-chat' })).toMatchObject({ ok: false, error: { code: 'not-found' } })
    expect(chats.runtimes.size).toBe(0)
  })

  it('opens with the config a window would attach, windowed to the last 60 items', async () => {
    const items = Array.from({ length: 70 }, (_, i) => text(`i${i}`, `line ${i}`))
    chats.update('tab-chat', (s) => ({ ...s, items, pending: [bashPrompt], busy: true, turnStartedAt: 5, info: { model: 'opus' } }))
    const res = await req('chat.open', { tabId: 'tab-chat' })
    expect(res).toMatchObject({ ok: true, result: { seq: 0 } })
    const view = (res as { result: { view: { items: { id: string }[]; hasEarlier: boolean; title: string; busy: boolean; model: string; prompts: unknown[] } } }).result.view
    expect(view.items.map((i) => i.id)).toEqual(items.slice(10).map((i) => i.id))
    expect(view).toMatchObject({ hasEarlier: true, title: 'Claude', busy: true, model: 'opus' })
    expect(view.prompts).toEqual([expect.objectContaining({ kind: 'permission', id: 'pr1', summary: 'Bash · npm test', detail: 'npm test', canAlwaysAllow: true })])
    expect(events()).toEqual([])

    // A never-live chat is attached from the stored tab config.
    await req('chat.open', { tabId: 'tab-chat' })
    chats.runtimes.clear()
    data = projects({ tabs: [chatTab] })
    await req('chat.open', { tabId: 'tab-chat' })
    expect(chats.runtimes.get('tab-chat')?.config).toEqual({ cwd: '/wt/fix/pkg', sessionId: 'sess-1', projectId: undefined, sshConfig: undefined, extraArgs: ['--verbose', '--x'] })
  })

  it('streams diffs: throttled to 4/s, prompts and status at once, seq from the open', async () => {
    chats.update('tab-chat', (s) => ({ ...s, items: [text('a', 'hi')] }))
    await req('chat.open', { tabId: 'tab-chat' })

    // Streaming text: several changes in one interval become one trailing event.
    chats.update('tab-chat', (s) => ({ ...s, items: [...s.items, text('b', 'H', true)] }))
    await vi.advanceTimersByTimeAsync(0)
    chats.update('tab-chat', (s) => ({ ...s, items: [s.items[0], text('b', 'Hello', true)] }))
    chats.update('tab-chat', (s) => ({ ...s, items: [s.items[0], text('b', 'Hello there', true)] }))
    expect(events()).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(CHAT_EVENT_INTERVAL_MS)
    expect(events()).toHaveLength(1)
    expect(events()[0]).toMatchObject({ seq: 1, tabId: 'tab-chat', removes: [], upserts: [{ kind: 'text', id: 'b', markdown: 'Hello there', streaming: true }], prompts: [], busy: false, process: 'idle' })

    // A prompt goes out immediately, carrying any item changes with it.
    chats.update('tab-chat', (s) => ({ ...s, items: [s.items[0], text('b', 'Hello there!')], pending: [bashPrompt], busy: true }))
    expect(events()).toHaveLength(2)
    expect(events()[1]).toMatchObject({ seq: 2, upserts: [{ id: 'b', markdown: 'Hello there!' }], busy: true, prompts: [{ id: 'pr1' }] })
    expect(events()[1].upserts[0]).not.toHaveProperty('streaming')

    // No change, no event.
    chats.update('tab-chat', (s) => ({ ...s }))
    await vi.advanceTimersByTimeAsync(1000)
    expect(events()).toHaveLength(2)

    // /clear: everything sent is removed, the new window upserted.
    chats.update('tab-chat', (s) => ({ ...s, items: [text('z', 'fresh')] }))
    await vi.advanceTimersByTimeAsync(1000)
    expect(events()[2]).toMatchObject({ seq: 3, removes: ['a', 'b'], upserts: [{ id: 'z' }] })

    // Re-opening continues the counter for this session.
    const res = await req('chat.open', { tabId: 'tab-chat' })
    expect(res).toMatchObject({ result: { seq: 3 } })
  })

  it('holds events that arrive while chat.open loads until after its result', async () => {
    let release!: () => void
    chats.holdListen = new Promise((resolve) => { release = resolve })
    bridge.request(phone, 99, 'chat.open', { tabId: 'tab-chat' })
    await vi.advanceTimersByTimeAsync(0)
    chats.update('tab-chat', (s) => ({ ...s, items: [text('a', 'during load')] }))
    chats.update('tab-chat', (s) => ({ ...s, pending: [bashPrompt] }))
    expect(phone.messages).toEqual([])
    chats.holdListen = null
    release()
    await vi.advanceTimersByTimeAsync(1000)
    expect(phone.messages[0]).toMatchObject({ t: 'res', id: 99, ok: true, result: { view: { items: [{ id: 'a' }], prompts: [{ id: 'pr1' }] } } })
    // The view already had everything, so nothing more to send.
    expect(events()).toEqual([])
    chats.update('tab-chat', (s) => ({ ...s, pending: [] }))
    expect(events()).toMatchObject([{ seq: 1, prompts: [] }])
  })

  it('one open chat per phone; close, drop and hiding the project stop streaming', async () => {
    data = projects({ tabs: [chatTab, { id: 'tab-2', type: 'claude-chat', title: 'Two', sessionId: 's2' }] })
    await req('chat.open', { tabId: 'tab-chat' })
    expect(chats.listenerCount('tab-chat')).toBe(1)
    await req('chat.open', { tabId: 'tab-2' })
    expect(chats.listenerCount('tab-chat')).toBe(0)
    expect(chats.listenerCount('tab-2')).toBe(1)
    chats.update('tab-chat', (s) => ({ ...s, pending: [bashPrompt] }))
    expect(events()).toEqual([])

    expect(await req('chat.close', { tabId: 'tab-2' })).toMatchObject({ ok: true, result: {} })
    expect(chats.listenerCount('tab-2')).toBe(0)

    await req('chat.open', { tabId: 'tab-2' })
    bridge.dropPhone(phone.id)
    expect(chats.listenerCount('tab-2')).toBe(0)

    await req('chat.open', { tabId: 'tab-2' })
    data = projects({ hide: true })
    bridge.projectsChanged()
    expect(chats.listenerCount('tab-2')).toBe(0)
  })

  it('a phone whose session ended gets no late result', async () => {
    let release!: () => void
    chats.holdListen = new Promise((resolve) => { release = resolve })
    bridge.request(phone, 7, 'chat.open', { tabId: 'tab-chat' })
    await vi.advanceTimersByTimeAsync(0)
    bridge.dropPhone(phone.id)
    chats.holdListen = null
    release()
    await vi.advanceTimersByTimeAsync(0)
    expect(phone.messages).toEqual([])
    expect(chats.listenerCount('tab-chat')).toBe(0)
  })

  it('maps answers exactly as the desktop cards do, and a repeat is gone', async () => {
    chats.update('tab-chat', (s) => ({ ...s, pending: [bashPrompt, questionPrompt, planPrompt] }))

    expect(await req('chat.answer', { tabId: 'tab-chat', promptId: 'pr1', answer: { behavior: 'allow', always: true } })).toMatchObject({ ok: true })
    expect(await req('chat.answer', { tabId: 'tab-chat', promptId: 'pr1', answer: { behavior: 'allow' } })).toMatchObject({ ok: false, error: { code: 'gone' } })

    expect(await req('chat.answer', { tabId: 'tab-chat', promptId: 'pr2', answer: { behavior: 'answers', answers: { 'Which DB?': 'SQLite' } } }))
      .toMatchObject({ ok: false, error: { code: 'bad-request' } })
    expect(await req('chat.answer', { tabId: 'tab-chat', promptId: 'pr2', answer: { behavior: 'allow' } })).toMatchObject({ ok: false, error: { code: 'bad-request' } })
    expect(await req('chat.answer', { tabId: 'tab-chat', promptId: 'pr2', answer: { behavior: 'answers', answers: { 'Which DB?': 'SQLite', 'Tests?': 'unit, e2e' } } }))
      .toMatchObject({ ok: true })

    expect(await req('chat.answer', { tabId: 'tab-chat', promptId: 'pr3', answer: { behavior: 'allow' } })).toMatchObject({ ok: false, error: { code: 'bad-request' } })
    expect(await req('chat.answer', { tabId: 'tab-chat', promptId: 'pr3', answer: { behavior: 'deny' } })).toMatchObject({ ok: true })

    expect(chats.responses.map((r) => r.response)).toEqual([
      { behavior: 'allow', always: true },
      { behavior: 'allow', updatedInput: { ...questionPrompt.input, answers: { 'Which DB?': 'SQLite', 'Tests?': 'unit, e2e' } } },
      { behavior: 'deny', message: 'Keep planning.' }
    ])

    chats.update('tab-chat', (s) => ({ ...s, pending: [{ ...bashPrompt, id: 'pr4', suggestions: undefined }, planPrompt] }))
    expect(await req('chat.answer', { tabId: 'tab-chat', promptId: 'pr4', answer: { behavior: 'allow', always: true } })).toMatchObject({ error: { code: 'bad-request' } })
    expect(await req('chat.answer', { tabId: 'tab-chat', promptId: 'pr4', answer: { behavior: 'deny', message: 'use pnpm' } })).toMatchObject({ ok: true })
    expect(await req('chat.answer', { tabId: 'tab-chat', promptId: 'pr3', answer: { behavior: 'approvePlan' } })).toMatchObject({ ok: true })
    expect(chats.responses.slice(3).map((r) => r.response)).toEqual([
      { behavior: 'deny', message: 'use pnpm' },
      { behavior: 'allow', always: false, updatedInput: planPrompt.input }
    ])
  })

  it('send, interrupt, earlier and detail work without the chat open, attaching first', async () => {
    expect(await req('chat.send', { tabId: 'tab-chat', text: 'say hi' })).toMatchObject({ ok: true, result: {} })
    expect(chats.sent).toEqual([{ tabId: 'tab-chat', text: 'say hi' }])
    expect(chats.runtimes.get('tab-chat')?.config.sessionId).toBe('sess-1')
    expect(chats.listenerCount('tab-chat')).toBe(0)

    expect(await req('chat.interrupt', { tabId: 'tab-chat' })).toMatchObject({ ok: true })
    expect(chats.interrupts).toEqual(['tab-chat'])

    const long = 'x'.repeat(20000)
    chats.update('tab-chat', (s: ChatState) => ({
      ...s,
      items: [
        ...Array.from({ length: 150 }, (_, i) => text(`i${i}`, `t${i}`)),
        { kind: 'tool', id: 'tool1', name: 'Bash', label: 'npm test', input: { command: 'npm test' }, status: 'done', result: 'ok' },
        text('long', long)
      ]
    }))
    expect(await req('chat.earlier', { tabId: 'tab-chat', before: 'i120', limit: 100 })).toMatchObject({ ok: true, result: { hasEarlier: true } })
    const earlier = await req('chat.earlier', { tabId: 'tab-chat', before: 'i50' })
    expect((earlier as { result: { items: { id: string }[]; hasEarlier: boolean } }).result).toMatchObject({ hasEarlier: false })
    expect((earlier as { result: { items: unknown[] } }).result.items).toHaveLength(50)
    expect(await req('chat.earlier', { tabId: 'tab-chat', before: 'nope' })).toMatchObject({ ok: false, error: { code: 'not-found' } })

    expect(await req('chat.detail', { tabId: 'tab-chat', itemId: 'tool1' })).toMatchObject({ ok: true, result: { kind: 'tool', input: '{\n  "command": "npm test"\n}', result: 'ok' } })
    expect(await req('chat.detail', { tabId: 'tab-chat', itemId: 'long' })).toMatchObject({ ok: true, result: { kind: 'text', markdown: long } })
    expect(await req('chat.detail', { tabId: 'tab-chat', itemId: 'nope' })).toMatchObject({ ok: false, error: { code: 'not-found' } })
  })

  it('chat.earlier extends the open window, so changes to those items stream too', async () => {
    chats.update('tab-chat', (s) => ({ ...s, items: Array.from({ length: 80 }, (_, i) => text(`i${i}`, `t${i}`)) }))
    await req('chat.open', { tabId: 'tab-chat' })
    // i5 is outside the window: its change is not sent.
    chats.update('tab-chat', (s) => ({ ...s, items: s.items.map((it) => (it.id === 'i5' ? text('i5', 'edited') : it)) }))
    await vi.advanceTimersByTimeAsync(1000)
    expect(events()).toEqual([])
    await req('chat.earlier', { tabId: 'tab-chat', before: 'i20' })
    chats.update('tab-chat', (s) => ({ ...s, items: s.items.map((it) => (it.id === 'i5' ? text('i5', 'edited again') : it)) }))
    await vi.advanceTimersByTimeAsync(1000)
    expect(events()).toMatchObject([{ upserts: [{ id: 'i5', markdown: 'edited again' }], removes: [] }])
  })

  it('reports the open tab per phone and announces phone sends before they happen (push, §7.6)', async () => {
    const sends: string[] = []
    bridge = new ChatBridge({
      chats,
      projects: { peek: () => data },
      timers: { now: () => Date.now(), setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) },
      log: () => {},
      onPhoneSend: (phoneId, tabId) => sends.push(`${phoneId}:${tabId}:${chats.sent.length}`)
    })
    expect(bridge.openTab('phone-1')).toBeNull()
    await req('chat.open', { tabId: 'tab-chat' })
    expect(bridge.openTab('phone-1')).toBe('tab-chat')
    await req('chat.send', { tabId: 'tab-chat', text: 'hi' })
    expect(sends).toEqual(['phone-1:tab-chat:0'])
    bridge.dropPhone('phone-1')
    expect(bridge.openTab('phone-1')).toBeNull()
  })

  it('starts a task.new chat: attaches, applies the mode, then sends as the phone (§8.4)', async () => {
    const sends: string[] = []
    bridge = new ChatBridge({
      chats,
      projects: { peek: () => data },
      timers: { now: () => Date.now(), setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) },
      log: () => {},
      onPhoneSend: (phoneId, tabId) => sends.push(`${phoneId}:${tabId}:${chats.modes.length}`)
    })
    await bridge.startTask('phone-1', 'tab-chat', 'Fix the login', 'plan')
    expect(chats.runtimes.get('tab-chat')?.config.sessionId).toBe('sess-1')
    expect(chats.modes).toEqual([{ tabId: 'tab-chat', mode: 'plan' }])
    expect(chats.sent).toEqual([{ tabId: 'tab-chat', text: 'Fix the login' }])
    expect(sends).toEqual(['phone-1:tab-chat:1'])

    await bridge.startTask('phone-1', 'tab-chat', 'Again')
    expect(chats.modes).toHaveLength(1)
    await expect(bridge.startTask('phone-1', 'nope', 'x')).rejects.toMatchObject({ code: 'not-found' })
  })

  it('sends the pickers and meter the composer shows, labelled the same way', async () => {
    const models = [
      { value: 'default', displayName: 'Default (recommended)' },
      { value: 'opus', resolvedModel: 'claude-opus-5-5', displayName: 'Opus 5.5', description: 'Most capable', supportedEffortLevels: ['low', 'high'] },
      { value: 'haiku', resolvedModel: 'claude-haiku-4-5', displayName: 'Haiku 4.5' }
    ]
    chats.update('tab-chat', (s) => ({
      ...s,
      models,
      info: { model: 'claude-opus-5-5', applied: { model: 'claude-opus-5-5', effort: 'high' } },
      usage: { contextTokens: 48_123.4, contextMax: 200_000, costUsd: 1.374, fiveHour: { utilization: 41.6, resetsAt: '2026-10-03T14:30:00Z' }, sevenDay: { utilization: 7 } }
    }))
    const res = await req('chat.open', { tabId: 'tab-chat' })
    const view = (res as { result: { view: Record<string, unknown> } }).result.view
    expect(view.settings).toEqual({
      modelName: 'Opus 5.5',
      models: [{ value: 'opus', label: 'Opus 5.5', description: 'Most capable' }, { value: 'haiku', label: 'Haiku 4.5' }],
      defaultEffort: 'high',
      efforts: ['low', 'high']
    })
    expect(view.usage).toEqual({
      contextTokens: 48_123, contextMax: 200_000, costCents: 137,
      fiveHour: { used: 42, resetsAt: Date.parse('2026-10-03T14:30:00Z') }, sevenDay: { used: 7 }
    })

    // A picked model reports its wire id once the session starts; the phone gets the row's value.
    chats.update('tab-chat', (s) => ({ ...s, info: { model: 'claude-haiku-4-5-20251001', modelPicked: true, effort: 'low', applied: { model: 'claude-haiku-4-5-20251001', effort: 'low' } } }))
    expect(events().at(-1)?.settings).toEqual(expect.objectContaining({ model: 'haiku', modelName: 'Haiku 4.5', effort: 'low', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] }))
    expect(events().at(-1)?.settings).not.toHaveProperty('defaultEffort')
  })

  it('chat.settings applies mode, model and effort in the composer order; "" is the default', async () => {
    chats.update('tab-chat', (s) => ({ ...s, models: [{ value: 'opus', displayName: 'Opus', supportedEffortLevels: ['low', 'high'] }, { value: 'haiku', displayName: 'Haiku' }] }))
    expect(await req('chat.settings', { tabId: 'tab-chat', mode: 'plan', model: 'opus', effort: 'high' })).toMatchObject({ ok: true, result: {} })
    expect(chats.modes).toEqual([{ tabId: 'tab-chat', mode: 'plan' }])
    expect(chats.settings).toEqual([{ tabId: 'tab-chat', model: 'opus' }, { tabId: 'tab-chat', effort: 'high' }])

    expect(await req('chat.settings', { tabId: 'tab-chat', model: '', effort: '' })).toMatchObject({ ok: true })
    expect(chats.settings.slice(2)).toEqual([{ tabId: 'tab-chat', model: undefined }, { tabId: 'tab-chat', effort: undefined }])

    expect(await req('chat.settings', { tabId: 'tab-chat', model: 'gpt' })).toMatchObject({ ok: false, error: { code: 'bad-request' } })
    // Haiku lists no levels, so the fallback list applies; Opus takes only low and high.
    expect(await req('chat.settings', { tabId: 'tab-chat', model: 'opus', effort: 'max' })).toMatchObject({ ok: false, error: { code: 'bad-request' } })
    expect(await req('chat.settings', { tabId: 'nope', mode: 'plan' })).toMatchObject({ ok: false, error: { code: 'not-found' } })
  })

  it('reports a failing manager call as internal', async () => {
    chats.send = async () => { throw new Error('boom') }
    expect(await req('chat.send', { tabId: 'tab-chat', text: 'x' })).toMatchObject({ ok: false, error: { code: 'internal', message: 'boom' } })
    expect(logs.some((l) => l.includes('boom'))).toBe(true)
  })
})
