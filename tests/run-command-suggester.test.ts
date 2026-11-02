import { describe, expect, it } from 'vitest'
import { parseSuggestReply, parseSuggestedCommands, suggestPrompt } from '../src/main/run-command-suggester'
import { mergeSuggestedCommands } from '../src/renderer/components/RunCommandsEditor'

describe('parseSuggestedCommands', () => {
  it('cleans names and commands to one line and drops repeats, blanks and junk', () => {
    expect(parseSuggestedCommands({
      commands: [
        { name: ' install ', command: 'npm ci' },
        { name: 'run', command: 'npm run build\n  && npm start' },
        { name: 'Install', command: 'yarn' },
        { name: '', command: 'echo' },
        { name: 'x', command: 'a'.repeat(501) },
        { name: 'test' },
        'nope'
      ]
    })).toEqual([
      { name: 'install', command: 'npm ci' },
      { name: 'run', command: 'npm run build && npm start' }
    ])
  })

  it('is null without a commands list', () => {
    expect(parseSuggestedCommands({})).toBeNull()
    expect(parseSuggestedCommands(null)).toBeNull()
  })
})

describe('parseSuggestReply', () => {
  it('reads structured_output first', () => {
    const out = JSON.stringify({ is_error: false, result: 'ignored', structured_output: { commands: [{ name: 'run', command: 'make run' }] } })
    expect(parseSuggestReply(out)).toEqual([{ name: 'run', command: 'make run' }])
  })

  it('falls back to JSON inside result', () => {
    const out = JSON.stringify({ result: 'Here:\n{"commands":[{"name":"run","command":"cargo run"}]}' })
    expect(parseSuggestReply(out)).toEqual([{ name: 'run', command: 'cargo run' }])
  })

  it('is null for an error or an unusable reply', () => {
    expect(parseSuggestReply(JSON.stringify({ is_error: true, structured_output: { commands: [] } }))).toBeNull()
    expect(parseSuggestReply('not json')).toBeNull()
    expect(parseSuggestReply(JSON.stringify({ result: 'no braces' }))).toBeNull()
  })
})

describe('suggestPrompt', () => {
  it('tells a stream what it already gets from the project', () => {
    const prompt = suggestPrompt({ dir: '/x', current: [], inherited: [{ name: 'run', command: 'npm run dev' }] })
    expect(prompt).toContain('- run: npm run dev')
    expect(prompt).toContain('only commands this branch needs differently')
  })

  it('lists the commands set already', () => {
    expect(suggestPrompt({ dir: '/x', current: [{ name: 'install', command: 'npm i' }] })).toContain('- install: npm i')
  })

  it('asks for the project\'s own scripts and deploys, not just install and run', () => {
    expect(suggestPrompt({ dir: '/x', current: [] })).toMatch(/scripts, deploys, releases/)
  })
})

describe('mergeSuggestedCommands', () => {
  const drafts = [
    { id: 'a', name: 'install', command: 'npm i' },
    { id: 'b', name: 'run', command: 'npm run dev' },
    { id: 'blank', name: '', command: '' }
  ]

  it('sets a row of the same name, adds the rest and drops blank rows', () => {
    const { next, changed } = mergeSuggestedCommands(drafts, [
      { name: 'Install', command: 'npm ci' },
      { name: 'run', command: 'npm run dev' },
      { name: 'test', command: 'npm test' }
    ])
    expect(next.map(d => [d.name, d.command])).toEqual([
      ['install', 'npm ci'],
      ['run', 'npm run dev'],
      ['test', 'npm test']
    ])
    expect(changed).toEqual(['a', next[2].id])
  })

  it('leaves out a suggestion the same as an inherited command', () => {
    const { next, changed } = mergeSuggestedCommands([], [
      { name: 'run', command: 'npm run dev' },
      { name: 'run (staging)', command: 'npm run dev -- --staging' }
    ], [{ name: 'run', command: 'npm run dev' }])
    expect(next.map(d => d.name)).toEqual(['run (staging)'])
    expect(changed).toHaveLength(1)
  })
})
