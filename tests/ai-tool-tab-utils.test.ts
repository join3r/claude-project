import { describe, expect, it } from 'vitest'
import { buildAiToolArgs, parseExtraArgs, resolveCodexResumeSessionId } from '../src/renderer/components/aiToolTabUtils'

describe('aiToolTabUtils', () => {
  it('parses extra args into argv tokens', () => {
    expect(parseExtraArgs('  --model gpt-5   --search  ')).toEqual(['--model', 'gpt-5', '--search'])
    expect(parseExtraArgs()).toEqual([])
  })

  it('prefers persisted Codex session ids over isolated home discovery', () => {
    expect(resolveCodexResumeSessionId('sess-saved', 'sess-isolated')).toBe('sess-saved')
    expect(resolveCodexResumeSessionId(undefined, 'sess-isolated')).toBe('sess-isolated')
    expect(resolveCodexResumeSessionId(undefined, null)).toBeUndefined()
  })

  it('builds Codex args with native bell notifications and resume', () => {
    expect(buildAiToolArgs('codex', ['--model', 'gpt-5'], 'sess-123')).toEqual([
      '-c',
      'tui.notifications=true',
      '-c',
      'tui.notification_method="bel"',
      '--model',
      'gpt-5',
      'resume',
      'sess-123'
    ])
  })

  it('builds Claude args with --resume suffix', () => {
    expect(buildAiToolArgs('claude', ['--verbose'], 'sess-abc')).toEqual([
      '--verbose',
      '--resume',
      'sess-abc'
    ])
  })
})
