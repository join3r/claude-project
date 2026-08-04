import { describe, it, expect } from 'vitest'
import { hasBell, terminalStatusFromOutput } from '../src/renderer/components/terminalStatus'

describe('hasBell', () => {
  it('detects a bare bell', () => {
    expect(hasBell('build finished\x07')).toBe(true)
  })

  it('ignores the BEL that terminates an OSC title sequence', () => {
    expect(hasBell('\x1b]0;join3r@mac: ~/proj\x07$ ')).toBe(false)
    expect(hasBell('\x1b]2;window title\x07')).toBe(false)
  })

  it('sees a real bell alongside an OSC title', () => {
    expect(hasBell('\x1b]0;title\x07done\x07')).toBe(true)
  })

  it('is false for ordinary output', () => {
    expect(hasBell('Error: failed to fetch\n')).toBe(false)
  })
})

describe('terminalStatusFromOutput', () => {
  it('raises attention on a bell', () => {
    expect(terminalStatusFromOutput('waiting for you\x07', null)).toBe('attention')
    expect(terminalStatusFromOutput('\x07', 'working')).toBe('attention')
  })

  // The old regex flagged any line containing error/failed/fail, so `npm test`
  // output, a grep hit or a stack trace pushed the whole task into "Needs you".
  it('does not treat error text as attention', () => {
    expect(terminalStatusFromOutput('Error: failed to fetch', null)).toBe('working')
    expect(terminalStatusFromOutput('Tests:  1 failed, 42 passed', null)).toBe('working')
    expect(terminalStatusFromOutput('ERROR boom', null)).toBe('working')
  })

  it('returns null on ready keywords', () => {
    expect(terminalStatusFromOutput('vite ready in 412ms', 'working')).toBeNull()
    expect(terminalStatusFromOutput('listening on :3000', 'working')).toBeNull()
    expect(terminalStatusFromOutput('compiled successfully', 'attention')).toBeNull()
  })

  it('keeps attention sticky through neutral output', () => {
    expect(terminalStatusFromOutput('some unrelated line', 'attention')).toBe('attention')
  })

  it('returns working for neutral output when not in attention', () => {
    expect(terminalStatusFromOutput('GET /api/x 200', null)).toBe('working')
    expect(terminalStatusFromOutput('GET /api/x 200', 'working')).toBe('working')
    expect(terminalStatusFromOutput('GET /api/x 200', 'exited')).toBe('working')
  })

  it('reads the last non-empty line of a multi-line chunk', () => {
    expect(terminalStatusFromOutput('building...\ncompiled successfully\n', 'working')).toBeNull()
    expect(terminalStatusFromOutput('compiled successfully\nGET /api/x 200\n', null)).toBe('working')
  })

  it('leaves the status untouched when a chunk has nothing printable', () => {
    expect(terminalStatusFromOutput('\x1b]0;title\x07', null)).toBeNull()
    expect(terminalStatusFromOutput('\x1b]0;title\x07', 'attention')).toBe('attention')
    expect(terminalStatusFromOutput('   \n', 'working')).toBe('working')
  })

  it('matches ready case-insensitively', () => {
    expect(terminalStatusFromOutput('READY in 50ms', null)).toBeNull()
  })
})
