import { describe, expect, it } from 'vitest'
import { normalizeBrowserUrl } from '../src/renderer/browserUrl'

describe('normalizeBrowserUrl', () => {
  it('preserves http and https urls', () => {
    expect(normalizeBrowserUrl('http://example.com')).toBe('http://example.com')
    expect(normalizeBrowserUrl('https://example.com/path')).toBe('https://example.com/path')
  })

  it('adds https for bare hosts', () => {
    expect(normalizeBrowserUrl('example.com')).toBe('https://example.com')
  })

  it('trims whitespace before normalizing', () => {
    expect(normalizeBrowserUrl('  example.com/test  ')).toBe('https://example.com/test')
  })
})
