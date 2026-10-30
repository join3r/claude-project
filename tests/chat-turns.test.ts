import { describe, it, expect } from 'vitest'
import { emptyChatState, reduceChat, type ChatItem, type ChatToolItem } from '../src/shared/claude-chat'
import { buildConversation, foldedLine, progressSteps, summarizeWork, workedFor } from '../src/renderer/components/claude-chat/turns'

function tool(id: string, name: string, input: Record<string, unknown> = {}, extra: Partial<ChatToolItem> = {}): ChatToolItem {
  return { kind: 'tool', id, name, label: `${name} label`, input, status: 'done', ...extra }
}

const user = (id: string, text: string, at?: number): ChatItem => ({ kind: 'user', id, text, images: 0, at })
const text = (id: string, body: string, at?: number): ChatItem => ({ kind: 'text', id, text: body, at })
const thinking = (id: string, body: string, at?: number): ChatItem => ({ kind: 'thinking', id, text: body, at })

describe('buildConversation', () => {
  it('keeps the last turn open while its background work runs, then folds it', () => {
    const items: ChatItem[] = [
      user('u1', 'build it', 1000),
      tool('a', 'Bash', { command: 'xcodebuild', run_in_background: true }, { at: 2000 }),
      text('m1', 'The build runs in the background.', 3000)
    ]
    const open = buildConversation(items, false, true)
    const turn = open[0].type === 'turn' ? open[0].turn : null
    expect(turn?.live).toBe(true)
    expect(turn?.background).toBe(true)
    expect(turn?.answer.map((i) => i.id)).toEqual(['m1'])
    // Claude picks the turn back up: the same turn, live and no longer background-only.
    const resumed = buildConversation([...items, tool('b', 'Read', { file_path: '/log' }, { at: 9000 })], true, true)
    const live = resumed[0].type === 'turn' ? resumed[0].turn : null
    expect(resumed).toHaveLength(1)
    expect(live?.live).toBe(true)
    expect(live?.background).toBeUndefined()
    const done = buildConversation(items, false, false)
    expect(done[0].type === 'turn' && done[0].turn.live).toBe(false)
  })

  it('splits turns at your messages and keeps only the text after the last call as the answer', () => {
    const items: ChatItem[] = [
      user('u1', 'fix it', 1000),
      thinking('t1', 'Looking at the keyboard code', 2000),
      tool('a', 'Read', { file_path: '/x.ts' }, { at: 3000 }),
      text('m1', 'Interim note', 4000),
      tool('b', 'Edit', { file_path: '/x.ts', old_string: 'a', new_string: 'b' }, { at: 5000 }),
      text('m2', 'Fixed.', 361_000),
      user('u2', 'thanks', 400_000),
      text('m3', 'Any time.', 401_000)
    ]
    const blocks = buildConversation(items, false)
    expect(blocks.map((b) => b.key)).toEqual(['u1', 'u2'])
    const first = blocks[0].type === 'turn' ? blocks[0].turn : null
    expect(first?.answer.map((i) => i.id)).toEqual(['m2'])
    expect(first?.work.map((i) => i.id)).toEqual(['t1', 'a', 'm1', 'b'])
    expect(first?.live).toBe(false)
    expect(first && foldedLine(first)).toBe('Worked 6m · read 1 file, edited 1 file')
    const second = blocks[1].type === 'turn' ? blocks[1].turn : null
    expect(second?.work).toEqual([])
  })

  it('marks the last turn live while busy and keeps trailing notices visible', () => {
    const items: ChatItem[] = [
      user('u1', 'go'),
      tool('a', 'Bash', { command: 'ls' }, { status: 'running' }),
      { kind: 'notice', id: 'n', text: 'Interrupted', tone: 'muted' }
    ]
    const [block] = buildConversation(items, true)
    expect(block.type === 'turn' && block.turn.live).toBe(true)
    expect(block.type === 'turn' && block.turn.tail.map((n) => n.text)).toEqual(['Interrupted'])
  })

  it('adds an empty live turn when busy after a !command', () => {
    const items: ChatItem[] = [{ kind: 'bash', id: 'b1', command: 'ls' }]
    const blocks = buildConversation(items, true)
    expect(blocks.map((b) => b.type)).toEqual(['bash', 'turn'])
    expect(blocks[1].type === 'turn' && blocks[1].turn.live).toBe(true)
  })

  it('skips empty thinking blocks', () => {
    const [block] = buildConversation([user('u', 'q'), thinking('t', '  '), text('a', 'A')], false)
    expect(block.type === 'turn' && block.turn.work).toEqual([])
  })
})

describe('progressSteps', () => {
  it('turns notes into steps and each run of calls into one line', () => {
    const steps = progressSteps([
      thinking('t1', 'Found the same handling in NewTaskSheet\nmore detail', 10),
      tool('a', 'Read', {}, { at: 11 }),
      tool('b', 'Read', {}, { at: 12 }),
      text('m', 'Moving the fix into a helper', 20),
      tool('c', 'Bash', { command: 'xcodebuild' }, { status: 'running', label: 'Bash · xcodebuild', at: 21 })
    ])
    expect(steps.map((s) => s.text)).toEqual([
      'Found the same handling in NewTaskSheet',
      'Read 2 files',
      'Moving the fix into a helper',
      'Bash · xcodebuild…'
    ])
    expect(steps[3].running).toBe(true)
    expect(steps[1].at).toBe(11)
  })
})

describe('summarizeWork', () => {
  it('tells builds and tests apart from other commands', () => {
    expect(summarizeWork([
      tool('a', 'Bash', { command: 'xcodebuild -scheme DevTool build' }),
      tool('b', 'Bash', { command: 'npm run build:mac' }),
      tool('c', 'Bash', { command: 'npm test' }),
      tool('d', 'Bash', { command: 'git status' }),
      tool('e', 'TodoWrite')
    ])).toBe('built twice, ran tests, ran 1 command')
  })
})

describe('workedFor', () => {
  it('rounds to seconds, minutes, hours', () => {
    expect(workedFor(40_000)).toBe('40s')
    expect(workedFor(6 * 60_000)).toBe('6m')
    expect(workedFor(65 * 60_000)).toBe('1h 5m')
  })
})

describe('reduceChat timestamps', () => {
  it('stamps live rows with the event time', () => {
    const state = reduceChat(emptyChatState(), { t: 'sent', uuid: 'u', text: 'hi', images: 0, at: 42 })
    expect(state.items[0].at).toBe(42)
  })
})
