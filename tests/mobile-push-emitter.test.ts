import { beforeEach, describe, expect, it } from 'vitest'
import { PushEmitter } from '../src/main/mobile/push-emitter'
import type { MobilePushRegistration } from '../src/main/mobile/pairings-store'
import type { PushOutcome } from '../src/main/mobile/mobile-service'
import type { ProjectsData } from '../src/shared/types'
import type { ChatPrompt } from '../src/shared/claude-chat'
import { b64uDecode, b64uEncode, openPushPayload, type PushPayload } from '../protocol/ts/index.ts'
import { FakeChats } from './helpers/fake-chats'
import { fixtureProject } from './helpers/streams-fixtures'

const DESKTOP = 'd'.repeat(32)

function registration(seed: number, kinds: MobilePushRegistration['kinds']): MobilePushRegistration {
  return { cap: `cap-${seed}`, key: b64uEncode(new Uint8Array(32).fill(seed)), keyId: b64uEncode(new Uint8Array(8).fill(seed)), kinds }
}

function projects(hide = false): ProjectsData {
  return {
    projects: [fixtureProject({
      id: 'p1', name: 'api', directory: '/src/api', hideFromMobile: hide || undefined,
      tasks: [{
        id: 't1', name: 'fix-auth',
        tabs: { left: [{ id: 'tab-chat', type: 'claude-chat', title: 'Claude', sessionId: 's' }, { id: 'tab-term', type: 'terminal', title: 'zsh' }] },
        activeTab: { left: 'tab-chat' }
      }]
    })],
    tags: [], projectOrder: ['p1'], pinnedItems: []
  }
}

const bash: ChatPrompt = { id: 'pr1', kind: 'permission', toolName: 'Bash', input: { command: 'npm test' } }
const question: ChatPrompt = { id: 'pr2', kind: 'question', toolName: 'AskUserQuestion', input: { questions: [{ question: 'Which DB?', options: [{ label: 'a' }] }] } }
const plan: ChatPrompt = { id: 'pr3', kind: 'plan', toolName: 'ExitPlanMode', input: { plan: '1. go' } }

describe('PushEmitter (SPEC.md §7.6)', () => {
  let chats: FakeChats
  let data: ProjectsData
  let targets: { phoneId: string; push: MobilePushRegistration }[]
  let open: Record<string, string | null>
  let sent: { phoneId: string; payload: PushPayload }[]
  let emitter: PushEmitter

  beforeEach(() => {
    chats = new FakeChats()
    data = projects()
    targets = [
      { phoneId: 'phone-a', push: registration(1, ['permission', 'question', 'done']) },
      { phoneId: 'phone-b', push: registration(2, ['done']) }
    ]
    open = {}
    sent = []
    emitter = new PushEmitter({
      chats,
      projects: { peek: () => data },
      targets: () => targets,
      openTab: (phoneId) => open[phoneId] ?? null,
      send: (phoneId, sealed): Promise<PushOutcome> => {
        const target = targets.find((t) => t.phoneId === phoneId)!
        const payload = openPushPayload(b64uDecode(target.push.key), sealed)
        expect(payload).not.toBeNull()
        sent.push({ phoneId, payload: payload! })
        return Promise.resolve('ok')
      },
      desktopId: () => DESKTOP,
      now: () => 42,
      log: () => {}
    })
    emitter.start()
  })

  it('pushes a new permission prompt once, sealed for each phone that wants it', () => {
    chats.update('tab-chat', (s) => ({ ...s, busy: true, pending: [bash] }))
    chats.update('tab-chat', (s) => ({ ...s, items: [] })) // same prompt still open
    expect(sent).toEqual([{
      phoneId: 'phone-a',
      payload: { v: 1, kind: 'permission', desktop: DESKTOP, tab: 'tab-chat', prompt: 'pr1', title: 'api / fix-auth', body: 'Bash · npm test', at: 42 }
    }])
  })

  it('pushes questions and plans under the question toggle', () => {
    chats.update('tab-chat', (s) => ({ ...s, pending: [question] }))
    chats.update('tab-chat', (s) => ({ ...s, pending: [question, plan] }))
    expect(sent.map((p) => [p.payload.kind, p.payload.body])).toEqual([['question', 'Which DB?'], ['plan', 'Plan ready for review']])
  })

  it('pushes a prompt again only after it was answered and asked anew', () => {
    chats.update('tab-chat', (s) => ({ ...s, pending: [bash] }))
    chats.update('tab-chat', (s) => ({ ...s, pending: [] }))
    chats.update('tab-chat', (s) => ({ ...s, pending: [bash] }))
    expect(sent).toHaveLength(2)
  })

  it('skips a phone that has the chat open, hidden projects and non-chat tabs', () => {
    open['phone-a'] = 'tab-chat'
    chats.update('tab-chat', (s) => ({ ...s, pending: [bash] }))
    expect(sent).toHaveLength(0)
    open['phone-a'] = null
    data = projects(true)
    chats.update('tab-chat', (s) => ({ ...s, pending: [question] }))
    chats.update('tab-term', (s) => ({ ...s, pending: [plan] }))
    expect(sent).toHaveLength(0)
  })

  it('pushes done only to the phone whose message started the turn', () => {
    emitter.phoneSent('phone-b', 'tab-chat')
    chats.update('tab-chat', (s) => ({ ...s, busy: true }))
    chats.update('tab-chat', (s) => ({ ...s, busy: false, items: [{ kind: 'user', id: 'u', text: 'go', images: 0 }, { kind: 'text', id: 'a', text: '\n  All 42 tests pass.\nDetails…' }] }))
    expect(sent).toEqual([{ phoneId: 'phone-b', payload: expect.objectContaining({ kind: 'done', body: 'All 42 tests pass.', title: 'api / fix-auth' }) }])
    expect(sent[0].payload.prompt).toBeUndefined()

    // The next turn was started at the desktop: nobody gets a push.
    chats.update('tab-chat', (s) => ({ ...s, busy: true }))
    chats.update('tab-chat', (s) => ({ ...s, busy: false }))
    expect(sent).toHaveLength(1)
  })

  it('says "Finished" when the turn left no text, and respects the done toggle', () => {
    emitter.phoneSent('phone-a', 'tab-chat')
    targets[0] = { ...targets[0], push: registration(1, ['permission']) }
    emitter.phoneSent('phone-b', 'tab-chat')
    chats.update('tab-chat', (s) => ({ ...s, busy: true }))
    chats.update('tab-chat', (s) => ({ ...s, busy: false, items: [{ kind: 'user', id: 'u', text: 'go', images: 0 }] }))
    expect(sent.map((p) => [p.phoneId, p.payload.body])).toEqual([['phone-b', 'Finished']])
  })

  it('stops watching on stop()', () => {
    emitter.stop()
    chats.update('tab-chat', (s) => ({ ...s, pending: [bash] }))
    expect(sent).toHaveLength(0)
    expect(chats.watchers.size).toBe(0)
  })
})
