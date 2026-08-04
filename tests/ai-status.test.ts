import { describe, it, expect } from 'vitest'
import { classifyNotification, nextAiStatus, type AiStatusCtx } from '../src/renderer/components/aiStatus'

const hookTab = (over: Partial<AiStatusCtx> = {}): AiStatusCtx => ({
  isHookTab: true,
  visible: false,
  windowFocused: false,
  ...over
})

const bellTab = (over: Partial<AiStatusCtx> = {}): AiStatusCtx => ({
  isHookTab: false,
  visible: false,
  windowFocused: false,
  ...over
})

describe('nextAiStatus', () => {
  describe('pty-data', () => {
    it('reports activity as working', () => {
      expect(nextAiStatus(null, 'pty-data', hookTab())).toBe('working')
      expect(nextAiStatus('working', 'pty-data', hookTab())).toBe('working')
    })

    it('never overwrites attention — output is not an answer to the question', () => {
      expect(nextAiStatus('attention', 'pty-data', hookTab())).toBe('keep')
    })

    it('leaves an exited tab exited', () => {
      expect(nextAiStatus('exited', 'pty-data', hookTab())).toBe('keep')
    })
  })

  describe('pty-quiet', () => {
    // Cause A: the heuristic fabricated 'attention' for Claude/pi purely because the
    // tab was off screen when its output settled (scrollback replay, TUI redraws,
    // status line, echo of typing).
    it('never turns silence into attention for a hook tab', () => {
      expect(nextAiStatus('working', 'pty-quiet', hookTab({ visible: false }))).toBe('keep')
      expect(nextAiStatus('working', 'pty-quiet', hookTab({ visible: true }))).toBe('keep')
      expect(nextAiStatus(null, 'pty-quiet', hookTab())).toBe('keep')
    })

    it('keeps the settle-down signal for bell-only tools', () => {
      expect(nextAiStatus('working', 'pty-quiet', bellTab({ visible: false }))).toBe('attention')
      expect(nextAiStatus('working', 'pty-quiet', bellTab({ visible: true }))).toBeNull()
    })

    it('only acts on a tab that was working', () => {
      expect(nextAiStatus(null, 'pty-quiet', bellTab())).toBe('keep')
      expect(nextAiStatus('attention', 'pty-quiet', bellTab())).toBe('keep')
      expect(nextAiStatus('exited', 'pty-quiet', bellTab())).toBe('keep')
    })
  })

  describe('hook-stopped', () => {
    // Cause B: Stop could only clear 'working', so any stale 'attention' survived
    // the agent finishing and the tab stayed amber until clicked.
    it('clears attention, not just working', () => {
      expect(nextAiStatus('attention', 'hook-stopped', hookTab())).toBeNull()
      expect(nextAiStatus('working', 'hook-stopped', hookTab())).toBeNull()
      expect(nextAiStatus(null, 'hook-stopped', hookTab())).toBeNull()
    })

    it('does not resurrect an exited tab', () => {
      expect(nextAiStatus('exited', 'hook-stopped', hookTab())).toBe('keep')
    })
  })

  describe('hook-notification', () => {
    // Cause C: every Notification became 'attention', including the 60s idle nudge
    // fired while the user was already looking at the tab.
    it('suppresses the idle nudge when you are already looking at the tab', () => {
      const ctx = hookTab({ visible: true, windowFocused: true, notificationKind: 'idle' })
      expect(nextAiStatus(null, 'hook-notification', ctx)).toBe('keep')
    })

    it('still raises the idle nudge when the tab is hidden or the window is not focused', () => {
      expect(nextAiStatus(null, 'hook-notification', hookTab({ visible: false, windowFocused: true, notificationKind: 'idle' }))).toBe('attention')
      expect(nextAiStatus(null, 'hook-notification', hookTab({ visible: true, windowFocused: false, notificationKind: 'idle' }))).toBe('attention')
    })

    it('always raises a permission prompt, even on the visible focused tab', () => {
      const ctx = hookTab({ visible: true, windowFocused: true, notificationKind: 'permission' })
      expect(nextAiStatus(null, 'hook-notification', ctx)).toBe('attention')
    })

    it('treats an unclassified notification as attention', () => {
      const ctx = hookTab({ visible: true, windowFocused: true, notificationKind: 'unknown' })
      expect(nextAiStatus(null, 'hook-notification', ctx)).toBe('attention')
    })
  })

  describe('stale-working', () => {
    // Cause E: nothing decayed a hook-driven 'working', so a crash, /clear, killed
    // session or dropped SSH left the tab working forever.
    it('drops a stuck working back to idle', () => {
      expect(nextAiStatus('working', 'stale-working', hookTab())).toBeNull()
    })

    it('leaves every other status alone', () => {
      expect(nextAiStatus('attention', 'stale-working', hookTab())).toBe('keep')
      expect(nextAiStatus(null, 'stale-working', hookTab())).toBe('keep')
      expect(nextAiStatus('exited', 'stale-working', hookTab())).toBe('keep')
    })
  })

  describe('visit', () => {
    // Cause F: the clear-on-visit used to be skipped when the xterm didn't exist yet;
    // the decision itself must not care about the terminal at all.
    it('clears attention', () => {
      expect(nextAiStatus('attention', 'visit', hookTab({ visible: true }))).toBeNull()
    })

    it('leaves working and exited alone', () => {
      expect(nextAiStatus('working', 'visit', hookTab({ visible: true }))).toBe('keep')
      expect(nextAiStatus('exited', 'visit', hookTab({ visible: true }))).toBe('keep')
      expect(nextAiStatus(null, 'visit', hookTab({ visible: true }))).toBe('keep')
    })
  })

  describe('hook-working, bell and exit', () => {
    it('marks working from the UserPromptSubmit hook', () => {
      expect(nextAiStatus(null, 'hook-working', hookTab())).toBe('working')
      expect(nextAiStatus('attention', 'hook-working', hookTab())).toBe('working')
      expect(nextAiStatus('exited', 'hook-working', hookTab())).toBe('keep')
    })

    it('treats a bell as attention unless the process is gone', () => {
      expect(nextAiStatus(null, 'bell', bellTab())).toBe('attention')
      expect(nextAiStatus('working', 'bell', bellTab())).toBe('attention')
      expect(nextAiStatus('exited', 'bell', bellTab())).toBe('keep')
    })

    it('always wins on exit', () => {
      expect(nextAiStatus('working', 'exit', hookTab())).toBe('exited')
      expect(nextAiStatus('attention', 'exit', hookTab())).toBe('exited')
      expect(nextAiStatus('exited', 'exit', hookTab())).toBe('exited')
    })
  })

  describe('sequences', () => {
    it('a hidden Claude tab that merely prints never goes amber', () => {
      const ctx = hookTab({ visible: false })
      let status = nextAiStatus(null, 'pty-data', ctx) as 'working'
      expect(status).toBe('working')
      expect(nextAiStatus(status, 'pty-quiet', ctx)).toBe('keep')
      expect(nextAiStatus(status, 'stale-working', ctx)).toBeNull()
    })

    it('a permission prompt answered by Claude finishing clears without a click', () => {
      const ctx = hookTab({ visible: false, notificationKind: 'permission' })
      const raised = nextAiStatus('working', 'hook-notification', ctx)
      expect(raised).toBe('attention')
      expect(nextAiStatus('attention', 'hook-stopped', ctx)).toBeNull()
    })
  })
})

describe('classifyNotification', () => {
  it('recognises permission prompts', () => {
    expect(classifyNotification({ message: 'Claude needs your permission to use Bash' })).toBe('permission')
    expect(classifyNotification({ message: 'Permission to use Edit' })).toBe('permission')
    expect(classifyNotification({ message: 'Claude is waiting for your approval' })).toBe('permission')
  })

  it('recognises the idle nudge', () => {
    expect(classifyNotification({ message: 'Claude is waiting for your input' })).toBe('idle')
    expect(classifyNotification({ message: 'Claude Code has been idle for 60 seconds' })).toBe('idle')
  })

  it('prefers permission over idle when a message mentions both', () => {
    expect(classifyNotification({ message: 'Claude is idle, waiting for your permission to use Bash' })).toBe('permission')
  })

  it('falls back to unknown for anything unmatched, empty or absent', () => {
    expect(classifyNotification({ message: 'Something entirely new' })).toBe('unknown')
    expect(classifyNotification({})).toBe('unknown')
    expect(classifyNotification(undefined)).toBe('unknown')
    // pi posts an empty body for agent_end — unknown keeps its existing "attention" behaviour.
    expect(classifyNotification({ message: 42 } as unknown as Record<string, unknown>)).toBe('unknown')
  })
})
