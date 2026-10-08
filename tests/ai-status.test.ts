import { describe, it, expect } from 'vitest'
import { classifyNotification, nextAiStatus, type AiStatusCtx } from '../src/shared/ai-status'

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

    // A turn ending with a benchmark still running in a background shell read as
    // "Your turn" for as long as the shell ran.
    it('stays working while background tasks run past the turn', () => {
      expect(nextAiStatus('working', 'hook-stopped', hookTab({ backgroundTasks: 1 }))).toBe('working')
      expect(nextAiStatus('attention', 'hook-stopped', hookTab({ backgroundTasks: 2 }))).toBe('working')
      expect(nextAiStatus('working', 'hook-stopped', hookTab({ backgroundTasks: 0 }))).toBeNull()
    })
  })

  describe('background tasks', () => {
    it('settles working once the last background task ends', () => {
      expect(nextAiStatus('working', 'background-done', hookTab())).toBeNull()
      expect(nextAiStatus('attention', 'background-done', hookTab())).toBe('keep')
      expect(nextAiStatus('exited', 'background-done', hookTab())).toBe('keep')
    })

    it('marks an idle tab working when background work goes live', () => {
      expect(nextAiStatus(null, 'background-started', hookTab())).toBe('working')
      expect(nextAiStatus('attention', 'background-started', hookTab())).toBe('keep')
    })
  })

  describe('hook-notification', () => {
    // Cause C: every Notification became 'attention', including the 60s idle nudge
    // fired while the user was already looking at the tab.
    it('suppresses the idle nudge when you are already looking at the tab', () => {
      const ctx = hookTab({ visible: true, windowFocused: true, notificationKind: 'idle' })
      expect(nextAiStatus(null, 'hook-notification', ctx)).toBe('keep')
    })

    // The inbox bug: Claude sends the idle nudge 60s after every Stop, and it used to
    // pull a finished (even settled) task back into "Needs you".
    it('never raises the idle nudge, wherever the tab is', () => {
      expect(nextAiStatus(null, 'hook-notification', hookTab({ visible: false, windowFocused: false, notificationKind: 'idle' }))).toBe('keep')
      expect(nextAiStatus(null, 'hook-notification', hookTab({ visible: true, windowFocused: false, notificationKind: 'idle' }))).toBe('keep')
      expect(nextAiStatus('attention', 'hook-notification', hookTab({ notificationKind: 'idle' }))).toBe('keep')
    })

    it('treats the idle nudge as a late Stop when the tab still thinks it is working', () => {
      expect(nextAiStatus('working', 'hook-notification', hookTab({ notificationKind: 'idle' }))).toBeNull()
    })

    it('ignores informational notifications', () => {
      expect(nextAiStatus(null, 'hook-notification', hookTab({ notificationKind: 'info' }))).toBe('keep')
      expect(nextAiStatus('working', 'hook-notification', hookTab({ notificationKind: 'info' }))).toBe('keep')
    })

    it('marks an auto-resumed turn as working', () => {
      expect(nextAiStatus(null, 'hook-notification', hookTab({ notificationKind: 'resumed' }))).toBe('working')
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

  describe('hook-needs-input / hook-input-resolved', () => {
    it('raises attention for a permission dialog, question or failed turn', () => {
      expect(nextAiStatus('working', 'hook-needs-input', hookTab({ visible: true, windowFocused: true }))).toBe('attention')
      expect(nextAiStatus(null, 'hook-needs-input', hookTab())).toBe('attention')
      expect(nextAiStatus('exited', 'hook-needs-input', hookTab())).toBe('keep')
    })

    it('goes back to working once you answer', () => {
      expect(nextAiStatus('attention', 'hook-input-resolved', hookTab())).toBe('working')
    })

    it('does not restart a finished turn', () => {
      expect(nextAiStatus(null, 'hook-input-resolved', hookTab())).toBe('keep')
      expect(nextAiStatus('working', 'hook-input-resolved', hookTab())).toBe('keep')
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
      const status = nextAiStatus(null, 'pty-data', ctx) as 'working'
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

  it('prefers the structured notification_type over the message', () => {
    expect(classifyNotification({ notification_type: 'idle_prompt', message: 'needs your permission' })).toBe('idle')
    expect(classifyNotification({ notification_type: 'permission_prompt' })).toBe('permission')
    expect(classifyNotification({ notification_type: 'elicitation_dialog' })).toBe('permission')
    expect(classifyNotification({ notification_type: 'auth_success' })).toBe('info')
    expect(classifyNotification({ notification_type: 'quota_auto_resume_fired' })).toBe('resumed')
  })

  it('falls back to the message for an unrecognised notification_type', () => {
    expect(classifyNotification({ notification_type: 'something_new', message: 'Claude needs your permission' })).toBe('permission')
  })

  it('recognises the messages older builds send without a type', () => {
    expect(classifyNotification({ message: 'Claude Code login successful' })).toBe('info')
    expect(classifyNotification({ message: 'Usage limit reset — Claude is continuing your task' })).toBe('resumed')
  })

  it('falls back to unknown for anything unmatched, empty or absent', () => {
    expect(classifyNotification({ message: 'Something entirely new' })).toBe('unknown')
    expect(classifyNotification({})).toBe('unknown')
    expect(classifyNotification(undefined)).toBe('unknown')
    // pi posts an empty body for agent_end — unknown keeps its existing "attention" behaviour.
    expect(classifyNotification({ message: 42 } as unknown as Record<string, unknown>)).toBe('unknown')
  })
})
