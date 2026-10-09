import { describe, expect, it } from 'vitest'
import { chatArtifacts, emptyChatState, reduceChat, type ChatEvent } from '../src/shared/claude-chat'

const sdk = (m: unknown): ChatEvent => ({ t: 'sdk', m, at: 1000 })

function call(id: string, input: Record<string, unknown>, name = 'Artifact'): ChatEvent {
  return sdk({ type: 'assistant', message: { id: `m_${id}`, content: [{ type: 'tool_use', id, name, input }] }, parent_tool_use_id: null })
}

function result(id: string, content: string, extra: Record<string, unknown> = {}): ChatEvent {
  return sdk({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] }, parent_tool_use_id: null, ...extra })
}

const published = (path: string, url: string): string =>
  `Published ${path} at ${url} (Version 1, version id 1790840721-bb2c) Icon: "chart".\n\nLive subscription: arming in the background`

const URL_A = 'https://claude.ai/artifact/KjShbAL5S4KekE71xQhQTE'
const URL_B = 'https://claude.ai/artifact/GpNPuwVzAL3mA45kWRdruL'

describe('chatArtifacts', () => {
  it('lists published pages latest first, titled from the structured result', () => {
    const state = [
      call('a1', { file_path: '/tmp/usage-bars.html', description: 'Limit bars mockup' }),
      result('a1', published('/tmp/usage-bars.html', URL_A), { tool_use_result: { url: URL_A, title: 'Composer Limit Bars' } }),
      call('b1', { file_path: '/tmp/inbox-grouping.html' }),
      // A transcript line carries the structured result as toolUseResult.
      result('b1', published('/tmp/inbox-grouping.html', URL_B), { toolUseResult: { url: URL_B, title: 'Inbox Grouping' } })
    ].reduce(reduceChat, emptyChatState())

    expect(chatArtifacts(state.items)).toEqual([
      { url: URL_B, title: 'Inbox Grouping', description: undefined, toolUseId: 'b1', publishes: 1 },
      { url: URL_A, title: 'Composer Limit Bars', description: 'Limit bars mockup', toolUseId: 'a1', publishes: 1 }
    ])
  })

  it('folds republishes into one entry and falls back to the file name', () => {
    const state = [
      call('a1', { file_path: '/tmp/usage-bars.html' }),
      result('a1', published('/tmp/usage-bars.html', URL_A)),
      call('b1', { file_path: '/tmp/other.html' }),
      result('b1', published('/tmp/other.html', URL_B)),
      call('a2', { file_path: '/tmp/usage-bars.html', description: 'v2' }),
      result('a2', published('/tmp/usage-bars.html', URL_A))
    ].reduce(reduceChat, emptyChatState())

    expect(chatArtifacts(state.items).map((a) => [a.title, a.toolUseId, a.publishes, a.description])).toEqual([
      ['usage-bars', 'a2', 2, 'v2'],
      ['other', 'b1', 1, undefined]
    ])
  })

  it('ignores reads, errors and other tools', () => {
    const state = [
      call('r1', { action: 'read', url: URL_A }),
      result('r1', `<html>…</html> from ${URL_A}`),
      call('e1', { file_path: '/tmp/x.html' }),
      sdk({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'e1', content: published('/tmp/x.html', URL_A), is_error: true }] }, parent_tool_use_id: null }),
      call('w1', { command: 'echo' }, 'Bash'),
      result('w1', published('/tmp/x.html', URL_A))
    ].reduce(reduceChat, emptyChatState())

    expect(chatArtifacts(state.items)).toEqual([])
  })
})
