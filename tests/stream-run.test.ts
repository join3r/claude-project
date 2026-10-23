import { describe, expect, it } from 'vitest'
import { plainRunLog, streamIdOfRunTab, streamRunCommand, streamRunTabId } from '../src/shared/stream-run'
import type { Project, Stream } from '../src/shared/types'

describe('plainRunLog', () => {
  it('leaves plain text alone', () => {
    expect(plainRunLog('')).toBe('')
    expect(plainRunLog('one\ntwo\n')).toBe('one\ntwo\n')
  })

  it('turns \\r\\n into \\n', () => {
    expect(plainRunLog('one\r\ntwo\r\n')).toBe('one\ntwo\n')
    expect(plainRunLog('one\r\r\ntwo')).toBe('one\ntwo')
  })

  it('strips CSI sequences: colours, cursor moves, erases, private modes', () => {
    expect(plainRunLog('\x1b[32m✓\x1b[0m built in \x1b[1m120ms\x1b[22m')).toBe('✓ built in 120ms')
    expect(plainRunLog('\x1b[2K\x1b[1G\x1b[?25lready\x1b[?25h')).toBe('ready')
    expect(plainRunLog('\x1b[38;5;208morange\x1b[m')).toBe('orange')
  })

  it('strips OSC sequences ended by BEL or ST', () => {
    expect(plainRunLog('\x1b]0;vite\x07Local: http://localhost:5173/')).toBe('Local: http://localhost:5173/')
    expect(plainRunLog('\x1b]8;;http://x.test\x1b\\link\x1b]8;;\x1b\\ text')).toBe('link text')
  })

  it('strips charset picks and other two-byte escapes', () => {
    expect(plainRunLog('\x1b(Bplain\x1b=\x1b>')).toBe('plain')
  })

  it('keeps a line redrawn with \\r as it was last drawn', () => {
    expect(plainRunLog('10%\r50%\r100%\ndone')).toBe('100%\ndone')
    expect(plainRunLog('\x1b[2K\r[==   ] 2/5\r\x1b[2K[=====] 5/5\r\n')).toBe('[=====] 5/5\n')
    // A trailing \r alone (no redraw yet) keeps the line.
    expect(plainRunLog('waiting\r')).toBe('waiting')
  })

  it('drops other control characters but keeps tabs', () => {
    expect(plainRunLog('a\x07b\x08c\td\x7f')).toBe('abc\td')
  })
})

describe('streamRunCommand', () => {
  const project = (extra: Partial<Project> = {}): Project => ({ id: 'p1', name: 'p', directory: '/x', streams: [], ...extra }) as Project
  const stream = (extra: Partial<Stream> = {}): Stream => ({ id: 's1', name: 's', tasks: [], ...extra })

  it("prefers the stream's own command, trimmed, over the project's", () => {
    expect(streamRunCommand(project({ runCommand: ' npm run dev ' }), stream())).toBe('npm run dev')
    expect(streamRunCommand(project({ runCommand: 'npm run dev' }), stream({ runCommand: ' make serve ' }))).toBe('make serve')
    expect(streamRunCommand(project({ runCommand: 'npm run dev' }), stream({ runCommand: '  ' }))).toBe('npm run dev')
    expect(streamRunCommand(project({ runCommand: 'npm run dev' }), undefined)).toBe('npm run dev')
  })

  it('is undefined with no command, or on a shell-command project', () => {
    expect(streamRunCommand(project(), stream())).toBeUndefined()
    expect(streamRunCommand(project({ runCommand: '   ' }), stream())).toBeUndefined()
    expect(streamRunCommand(project({ runCommand: 'x', shellCommand: { command: 'top' } }), stream({ runCommand: 'y' }))).toBeUndefined()
  })
})

describe('run tab ids', () => {
  it('round-trips a stream id and rejects other tab ids', () => {
    expect(streamIdOfRunTab(streamRunTabId('s-1'))).toBe('s-1')
    expect(streamIdOfRunTab('run-')).toBeNull()
    expect(streamIdOfRunTab('tab-1')).toBeNull()
  })
})
