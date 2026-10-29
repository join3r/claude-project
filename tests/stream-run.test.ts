import { describe, expect, it } from 'vitest'
import { parseStreamRunTabId, plainRunLog, streamRunCommands, streamRunTabId } from '../src/shared/stream-run'
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

describe('streamRunCommands', () => {
  const project = (extra: Partial<Project> = {}): Project => ({ id: 'p1', name: 'p', directory: '/x', streams: [], ...extra }) as Project
  const stream = (extra: Partial<Stream> = {}): Stream => ({ id: 's1', name: 's', tasks: [], ...extra })
  const list = [
    { id: 'c-install', name: 'install', command: 'npm ci' },
    { id: 'c-run', name: 'run', command: ' npm run dev ' },
    { id: 'c-blank', name: 'blank', command: '  ' }
  ]

  it('reads older data’s single command as one named run', () => {
    expect(streamRunCommands(project({ runCommand: ' npm run dev ' }), stream())).toEqual([{ id: 'run', name: 'run', command: 'npm run dev' }])
    // A stream's old command took the place of the project's.
    expect(streamRunCommands(project({ runCommand: 'npm run dev' }), stream({ runCommand: ' make serve ' })))
      .toEqual([{ id: 'run', name: 'run', command: 'make serve' }])
    expect(streamRunCommands(project({ runCommands: list }), stream({ runCommand: 'make serve' })).map(c => c.command))
      .toEqual(['make serve', 'npm run dev'])
  })

  it('lists the project’s commands, trimmed, without blank ones', () => {
    expect(streamRunCommands(project({ runCommands: list }), undefined)).toEqual([
      { id: 'c-install', name: 'install', command: 'npm ci' },
      { id: 'c-run', name: 'run', command: 'npm run dev' }
    ])
  })

  it('lets a stream replace one by name (any case) in its place, and add others after', () => {
    const own = [{ id: 'c-x', name: 'seed', command: 'npm run seed' }, { id: 'c-y', name: ' RUN ', command: 'npm run dev -- --port 4000' }]
    expect(streamRunCommands(project({ runCommands: list }), stream({ runCommands: own }))).toEqual([
      { id: 'c-install', name: 'install', command: 'npm ci' },
      { id: 'c-run', name: 'run', command: 'npm run dev -- --port 4000' },
      { id: 'c-x', name: 'seed', command: 'npm run seed' }
    ])
  })

  it('is empty with no command, or on a shell-command project', () => {
    expect(streamRunCommands(project(), stream())).toEqual([])
    expect(streamRunCommands(project({ runCommand: '   ' }), stream())).toEqual([])
    expect(streamRunCommands(project({ runCommands: list, shellCommand: { command: 'top' } }), stream({ runCommand: 'y' }))).toEqual([])
  })
})

describe('run tab ids', () => {
  it('round-trips a stream and command and rejects other tab ids', () => {
    expect(parseStreamRunTabId(streamRunTabId('s-1', 'c-run'))).toEqual({ streamId: 's-1', commandId: 'c-run' })
    expect(parseStreamRunTabId('run-')).toBeNull()
    expect(parseStreamRunTabId('run-s-1')).toBeNull()
    expect(parseStreamRunTabId('tab-1')).toBeNull()
  })
})
