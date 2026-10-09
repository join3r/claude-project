import { describe, expect, it, vi } from 'vitest'
import { TerminalStatusTracker } from '../src/main/terminal-status-tracker'
import { TabActivityRegistry } from '../src/main/tab-activity-registry'
import { PtySessions } from '../src/main/pty-sessions'
import type { PtyManager } from '../src/main/pty-manager'
import type { ScrollbackStorage } from '../src/main/scrollback-storage'
import { DEFAULT_CONFIG } from '../src/shared/types'

/** A server works out shells' and Codex's status from their output, as a window would. */
function setup() {
  let now = 1_000
  const timers: Array<{ at: number; fn: () => void; cleared: boolean }> = []
  const registry = new TabActivityRegistry(() => now)
  const tracker = new TerminalStatusTracker({
    getStatus: (tabId) => registry.getStatus(tabId),
    report: (tabId, status) => registry.reported(tabId, status),
    now: () => now,
    setTimer: (fn, ms) => {
      const timer = { at: now + ms, fn, cleared: false }
      timers.push(timer)
      return timer
    },
    clearTimer: (handle) => { (handle as { cleared: boolean }).cleared = true }
  })
  const advance = (ms: number) => {
    now += ms
    for (const timer of timers) {
      if (!timer.cleared && timer.at <= now) {
        timer.cleared = true
        timer.fn()
      }
    }
  }
  return { registry, tracker, advance }
}

describe('TerminalStatusTracker (host-side terminal status)', () => {
  it('output is working, a quiet tab goes idle again, a bell is attention until a ready line', () => {
    const { registry, tracker, advance } = setup()
    tracker.output('t1', 'building…\n')
    expect(registry.getStatus('t1')).toBe('working')
    advance(30_000)
    expect(registry.getStatus('t1')).toBeNull()

    tracker.output('t1', 'done\x07')
    expect(registry.getStatus('t1')).toBe('attention')
    advance(250)
    tracker.output('t1', 'more output\n')
    expect(registry.getStatus('t1')).toBe('attention')
    advance(250)
    tracker.output('t1', 'server listening on 3000\n')
    expect(registry.getStatus('t1')).toBeNull()
  })

  it('throttles chunks but never a bell, and ignores a title-only chunk', () => {
    const { registry, tracker, advance } = setup()
    const report = vi.spyOn(registry, 'reported')
    tracker.output('t1', 'a\n')
    tracker.output('t1', 'b\n')
    expect(report).toHaveBeenCalledTimes(1)
    tracker.output('t1', '\x07')
    expect(registry.getStatus('t1')).toBe('attention')
    advance(500)
    tracker.output('t1', '\x1b]0;title\x07')
    expect(registry.getStatus('t1')).toBe('attention')
  })

  it('leaves an exited tab alone and forgets a tab\'s timers', () => {
    const { registry, tracker, advance } = setup()
    tracker.output('t1', 'x\n')
    registry.exited('t1')
    tracker.forget('t1')
    advance(60_000)
    tracker.output('t1', 'late\n')
    expect(registry.getStatus('t1')).toBe('exited')
  })
})

describe('PtySessions with host-side status', () => {
  function sessions() {
    const callbacks = new Map<string, { onData?: (data: string) => void; onExit?: (code: number) => void }>()
    const output = vi.fn()
    const forget = vi.fn()
    const ptyManager = {
      spawn: vi.fn((id: string, _shell: string, _cwd: string, _cols: number, _rows: number, _args?: string[], _env?: unknown,
        cbs?: { onData?: (data: string) => void; onExit?: (code: number) => void }) => { callbacks.set(id, cbs ?? {}) }),
      write: vi.fn(), resize: vi.fn(), kill: vi.fn(), killAll: vi.fn(), pause: vi.fn(), resume: vi.fn()
    }
    const pty = new PtySessions({
      ptyManager: ptyManager as unknown as PtyManager,
      scrollbackStorage: { save: vi.fn(), load: () => null, delete: vi.fn() } as unknown as ScrollbackStorage,
      activityRegistry: new TabActivityRegistry(),
      sshManager: () => { throw new Error('no ssh') },
      hookInjector: () => ({ inject: vi.fn() }) as never,
      hookPort: () => 1,
      hookToken: () => 'tok',
      getConfig: () => DEFAULT_CONFIG,
      broadcastAgentActivity: () => {},
      sendToClient: () => {},
      log: () => {},
      piExtensionPath: () => '/app/pi.mjs',
      terminalStatus: { output, forget }
    })
    return { pty, callbacks, output, forget }
  }

  it('feeds a shell\'s and Codex\'s output to the heuristics, not a hooked Claude tab\'s', () => {
    const { pty, callbacks, output, forget } = sessions()
    pty.attachOrCreate('link:d:win:1', { id: 'shell', shell: '', cwd: '/tmp', cols: 80, rows: 24 })
    pty.attachOrCreate('link:d:win:1', { id: 'codex', shell: 'codex', cwd: '/tmp', cols: 80, rows: 24 })
    pty.attachOrCreate('link:d:win:1', { id: 'claude', shell: 'claude', cwd: '/tmp', cols: 80, rows: 24, extraEnv: { DEVTOOL_TAB_ID: 'claude' } })
    callbacks.get('shell')!.onData!('ls\n')
    callbacks.get('codex')!.onData!('thinking\n')
    callbacks.get('claude')!.onData!('hooked\n')
    expect(output.mock.calls).toEqual([['shell', 'ls\n'], ['codex', 'thinking\n']])
    callbacks.get('shell')!.onExit!(0)
    pty.kill('codex')
    expect(forget).toHaveBeenCalledWith('shell')
    expect(forget).toHaveBeenCalledWith('codex')
  })
})
