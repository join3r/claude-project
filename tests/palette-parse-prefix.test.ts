// tests/palette-parse-prefix.test.ts
import { describe, it, expect } from 'vitest'
import { parsePrefix } from '../src/renderer/palette/parsePrefix'

describe('parsePrefix', () => {
  it('returns null prefix and full query when no prefix is present', () => {
    expect(parsePrefix('hello world')).toEqual({ prefix: null, allProjects: false, query: 'hello world' })
  })
  it('extracts a primary prefix and trims whitespace from the query', () => {
    expect(parsePrefix('>  open settings')).toEqual({ prefix: '>', allProjects: false, query: 'open settings' })
    expect(parsePrefix('@deploy')).toEqual({ prefix: '@', allProjects: false, query: 'deploy' })
    expect(parsePrefix('#ssh')).toEqual({ prefix: '#', allProjects: false, query: 'ssh' })
    expect(parsePrefix(':editor')).toEqual({ prefix: ':', allProjects: false, query: 'editor' })
  })
  it('extracts allProjects modifier alone', () => {
    expect(parsePrefix('*deploy')).toEqual({ prefix: null, allProjects: true, query: 'deploy' })
  })
  it('extracts allProjects modifier after a primary prefix', () => {
    expect(parsePrefix('@*deploy')).toEqual({ prefix: '@', allProjects: true, query: 'deploy' })
    expect(parsePrefix('#* readme')).toEqual({ prefix: '#', allProjects: true, query: 'readme' })
  })
  it('returns empty query for prefix-only input', () => {
    expect(parsePrefix('>')).toEqual({ prefix: '>', allProjects: false, query: '' })
    expect(parsePrefix('@*')).toEqual({ prefix: '@', allProjects: true, query: '' })
  })
  it('treats unknown characters as part of the query, not prefixes', () => {
    expect(parsePrefix('!todo')).toEqual({ prefix: null, allProjects: false, query: '!todo' })
  })
})
