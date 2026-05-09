import { describe, expect, it } from 'vitest'
import {
  sortTasksByRecency,
  computeTaskRecencyOpacity,
  buildRecencyStyle,
  createInteractionStampGate,
  INTERACTION_STAMP_INTERVAL_MS,
  MAX_OPACITY
} from '../src/renderer/components/taskRecency'
import type { AppConfig, Task } from '../src/shared/types'

function makeTask(id: string, lastInteractedAt?: number): Task {
  return {
    id,
    name: id,
    tabs: { left: [], right: [] },
    activeTab: { left: null, right: null },
    splitOpen: false,
    splitRatio: 0.5,
    ...(lastInteractedAt !== undefined ? { lastInteractedAt } : {})
  }
}

const rankSettings: AppConfig['taskRecencyHighlight'] = {
  enabled: true,
  mode: 'rank',
  rankCount: 5,
  timeWindowMinutes: 1440
}

const timeSettings: AppConfig['taskRecencyHighlight'] = {
  enabled: true,
  mode: 'time',
  rankCount: 5,
  timeWindowMinutes: 60
}

describe('MAX_OPACITY', () => {
  it('is capped low enough that recency does not out-shout selection', () => {
    expect(MAX_OPACITY).toBe(0.12)
  })
})

describe('buildRecencyStyle', () => {
  it('returns undefined for non-positive opacity', () => {
    expect(buildRecencyStyle(0, 'dark')).toBeUndefined()
    expect(buildRecencyStyle(-0.1, 'dark')).toBeUndefined()
  })

  it('returns only a backgroundColor (no inset bar) for positive opacity', () => {
    const style = buildRecencyStyle(0.1, 'dark')
    expect(style).toBeDefined()
    expect(style!.backgroundColor).toMatch(/^rgba\(100, 150, 230, 0\.100\)$/)
    expect(style!.boxShadow).toBeUndefined()
  })
})

describe('sortTasksByRecency', () => {
  it('excludes tasks without lastInteractedAt', () => {
    const sorted = sortTasksByRecency([makeTask('a', 100), makeTask('b'), makeTask('c', 200)])
    expect(sorted.map(t => t.id)).toEqual(['c', 'a'])
  })

  it('sorts descending by lastInteractedAt', () => {
    const sorted = sortTasksByRecency([
      makeTask('a', 100),
      makeTask('b', 300),
      makeTask('c', 200)
    ])
    expect(sorted.map(t => t.id)).toEqual(['b', 'c', 'a'])
  })

  it('returns empty array when no tasks have timestamps', () => {
    const sorted = sortTasksByRecency([makeTask('a'), makeTask('b')])
    expect(sorted).toEqual([])
  })
})

describe('computeTaskRecencyOpacity', () => {
  const now = 1_000_000_000_000

  it('returns 0 when settings are disabled', () => {
    const task = makeTask('a', now - 1000)
    const opacity = computeTaskRecencyOpacity(task, [task], { ...rankSettings, enabled: false }, now)
    expect(opacity).toBe(0)
  })

  it('returns 0 for a task without lastInteractedAt', () => {
    const task = makeTask('a')
    expect(computeTaskRecencyOpacity(task, [], rankSettings, now)).toBe(0)
  })

  describe('rank mode', () => {
    it('assigns MAX_OPACITY to the most recent task', () => {
      const top = makeTask('a', now)
      const sorted = [top, makeTask('b', now - 1), makeTask('c', now - 2)]
      expect(computeTaskRecencyOpacity(top, sorted, rankSettings, now)).toBeCloseTo(MAX_OPACITY, 5)
    })

    it('returns 0 for a task ranked at or beyond rankCount', () => {
      const tasks = Array.from({ length: 10 }, (_, i) => makeTask(`t${i}`, now - i))
      const sorted = sortTasksByRecency(tasks)
      const atCap = tasks[rankSettings.rankCount]
      const beyondCap = tasks[rankSettings.rankCount + 2]
      expect(computeTaskRecencyOpacity(atCap, sorted, rankSettings, now)).toBe(0)
      expect(computeTaskRecencyOpacity(beyondCap, sorted, rankSettings, now)).toBe(0)
    })

    it('gives the last ranked task a small positive opacity', () => {
      const tasks = Array.from({ length: 5 }, (_, i) => makeTask(`t${i}`, now - i))
      const sorted = sortTasksByRecency(tasks)
      const last = tasks[rankSettings.rankCount - 1]
      const opacity = computeTaskRecencyOpacity(last, sorted, rankSettings, now)
      expect(opacity).toBeGreaterThan(0)
      expect(opacity).toBeLessThan(MAX_OPACITY)
    })
  })

  describe('time mode', () => {
    it('returns MAX_OPACITY for an age of 0', () => {
      const task = makeTask('a', now)
      expect(computeTaskRecencyOpacity(task, [task], timeSettings, now)).toBeCloseTo(MAX_OPACITY, 5)
    })

    it('returns 0 when age equals the window', () => {
      const windowMs = timeSettings.timeWindowMinutes * 60_000
      const task = makeTask('a', now - windowMs)
      expect(computeTaskRecencyOpacity(task, [task], timeSettings, now)).toBe(0)
    })

    it('returns 0 when age is past the window', () => {
      const windowMs = timeSettings.timeWindowMinutes * 60_000
      const task = makeTask('a', now - windowMs - 1)
      expect(computeTaskRecencyOpacity(task, [task], timeSettings, now)).toBe(0)
    })

    it('returns roughly half MAX_OPACITY at half the window', () => {
      const windowMs = timeSettings.timeWindowMinutes * 60_000
      const task = makeTask('a', now - windowMs / 2)
      const opacity = computeTaskRecencyOpacity(task, [task], timeSettings, now)
      expect(opacity).toBeCloseTo(MAX_OPACITY / 2, 2)
    })
  })
})

describe('createInteractionStampGate', () => {
  it('exposes a 5 second window', () => {
    expect(INTERACTION_STAMP_INTERVAL_MS).toBe(5000)
  })

  it('allows the first call for a task', () => {
    const gate = createInteractionStampGate()
    expect(gate('task-a', 1000)).toBe(true)
  })

  it('throttles a second call inside the window', () => {
    const gate = createInteractionStampGate()
    expect(gate('task-a', 1000)).toBe(true)
    expect(gate('task-a', 1000 + INTERACTION_STAMP_INTERVAL_MS - 1)).toBe(false)
  })

  it('allows a call exactly at the window boundary', () => {
    const gate = createInteractionStampGate()
    expect(gate('task-a', 1000)).toBe(true)
    expect(gate('task-a', 1000 + INTERACTION_STAMP_INTERVAL_MS)).toBe(true)
  })

  it('tracks tasks independently', () => {
    const gate = createInteractionStampGate()
    expect(gate('task-a', 1000)).toBe(true)
    expect(gate('task-b', 1000)).toBe(true)
    expect(gate('task-a', 1500)).toBe(false)
    expect(gate('task-b', 1500)).toBe(false)
  })
})
