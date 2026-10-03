import { describe, it, expect } from 'vitest'
import {
  availablePromptAgents,
  initialPromptArgs,
  pickPromptAgent,
  setPendingPrompt,
  shouldNameTask,
  takePendingPrompt,
  taskNameFromPrompt,
  workspaceBranchName
} from '../src/renderer/components/promptBox'

const allOn = { enableClaude: true, enableCodex: true, enablePi: true }

describe('taskNameFromPrompt', () => {
  it('uses the first non-empty line with whitespace collapsed', () => {
    expect(taskNameFromPrompt('\n\n  Fix   the relay\nthen test it')).toBe('Fix the relay')
  })

  it('cuts long lines with an ellipsis', () => {
    const name = taskNameFromPrompt('a'.repeat(80), 20)
    expect(name).toHaveLength(20)
    expect(name.endsWith('…')).toBe(true)
  })
})

describe('shouldNameTask', () => {
  it('renames only the placeholder', () => {
    expect(shouldNameTask('New Task')).toBe(true)
    expect(shouldNameTask('')).toBe(true)
    expect(shouldNameTask('Fix the relay')).toBe(false)
  })
})

describe('availablePromptAgents', () => {
  it('offers enabled agents in a fixed order', () => {
    expect(availablePromptAgents(allOn, {})).toEqual(['claude-chat', 'claude', 'codex', 'pi'])
    expect(availablePromptAgents({ ...allOn, enableClaude: false }, {})).toEqual(['codex', 'pi'])
  })

  it('offers nothing in a shell-command project', () => {
    expect(availablePromptAgents(allOn, { shellCommand: { command: 'npm start' } as never })).toEqual([])
  })
})

describe('pickPromptAgent', () => {
  it('keeps the remembered agent while it is on offer', () => {
    expect(pickPromptAgent('pi', ['claude-chat', 'pi'])).toBe('pi')
    expect(pickPromptAgent('pi', ['claude-chat'])).toBe('claude-chat')
    expect(pickPromptAgent(undefined, [])).toBeNull()
  })
})

describe('initialPromptArgs', () => {
  it('appends the prompt as one argument', () => {
    expect(initialPromptArgs('codex', { text: ' fix it \n' }, [])).toEqual(['fix it'])
    expect(initialPromptArgs('pi', { text: 'a "quoted" & piped | thing' }, [])).toEqual(['a "quoted" & piped | thing'])
  })

  it('keeps a leading dash from reading as a flag', () => {
    expect(initialPromptArgs('claude', { text: '-v is broken' }, [])).toEqual([' -v is broken'])
  })

  it('passes a permission mode to terminal Claude unless the project sets one', () => {
    expect(initialPromptArgs('claude', { text: 'go', mode: 'plan' }, [])).toEqual(['--permission-mode', 'plan', 'go'])
    expect(initialPromptArgs('claude', { text: 'go', mode: 'plan' }, ['--dangerously-skip-permissions'])).toEqual(['go'])
    expect(initialPromptArgs('claude', { text: 'go', mode: 'plan' }, ['--permission-mode=auto'])).toEqual(['go'])
    expect(initialPromptArgs('codex', { text: 'go', mode: 'plan' }, [])).toEqual(['go'])
  })

  it('leaves the prompt out when it will be pasted instead', () => {
    expect(initialPromptArgs('claude', { text: 'go', mode: 'auto' }, [], false)).toEqual(['--permission-mode', 'auto'])
  })
})

describe('pending prompts', () => {
  it('hand over once', () => {
    setPendingPrompt('t1', { text: 'hello' })
    expect(takePendingPrompt('t1')).toEqual({ text: 'hello' })
    expect(takePendingPrompt('t1')).toBeUndefined()
  })
})

describe('workspaceBranchName', () => {
  it('derives a git-safe branch from the first line', () => {
    expect(workspaceBranchName('Fix the relay reconnect\nand add a test', [])).toBe('fix-the-relay-reconnect')
  })

  it('cuts long prompts at a word boundary', () => {
    const name = workspaceBranchName('Refactor the mobile relay reconnect loop so it backs off exponentially', [])
    expect(name.length).toBeLessThanOrEqual(40)
    expect(name).toBe('refactor-the-mobile-relay-reconnect-loop')
  })

  it('falls back to task when nothing git-safe is left', () => {
    expect(workspaceBranchName('???', [])).toBe('task')
  })

  it('steps past branches that already exist', () => {
    expect(workspaceBranchName('fix it', ['fix-it', 'fix-it-2'])).toBe('fix-it-3')
  })
})
