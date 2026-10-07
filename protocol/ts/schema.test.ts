import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { cannedInbox } from '../tools/fake-desktop-core.ts'

/**
 * Keeps `protocol/schema/` honest against the TS types without pulling in a validator
 * dependency: a tiny interpreter for exactly the draft 2020-12 keywords the schemas use.
 * If a schema starts using another keyword, this throws rather than silently passing.
 */

type Schema = Record<string, unknown>
const SCHEMA_DIR = new URL('../schema/', import.meta.url)
const docs = new Map<string, Schema>()

function doc(file: string): Schema {
  if (!docs.has(file)) docs.set(file, JSON.parse(readFileSync(new URL(file, SCHEMA_DIR), 'utf8')) as Schema)
  return docs.get(file)!
}

const KNOWN = new Set([
  '$schema', '$id', '$defs', '$ref', 'title', 'description', 'type', 'required', 'properties',
  'items', 'enum', 'const', 'pattern', 'minimum', 'oneOf', 'if', 'then'
])

function resolve(ref: string, file: string): [Schema, string] {
  const [target, fragment] = ref.split('#')
  const nextFile = target || file
  let node: unknown = doc(nextFile)
  for (const part of (fragment ?? '').split('/').filter(Boolean)) node = (node as Schema)[part]
  if (!node) throw new Error(`unresolved $ref ${ref}`)
  return [node as Schema, nextFile]
}

function typeOk(type: string, value: unknown): boolean {
  switch (type) {
    case 'object': return typeof value === 'object' && value !== null && !Array.isArray(value)
    case 'array': return Array.isArray(value)
    case 'string': return typeof value === 'string'
    case 'integer': return Number.isInteger(value)
    case 'boolean': return typeof value === 'boolean'
    default: throw new Error(`unsupported type ${type}`)
  }
}

/** Returns a list of error paths; empty means valid. */
function validate(schema: Schema, value: unknown, file: string, path = '$'): string[] {
  for (const key of Object.keys(schema)) if (!KNOWN.has(key)) throw new Error(`schema keyword ${key} not supported by the test`)
  if (schema.$ref) {
    const [target, nextFile] = resolve(schema.$ref as string, file)
    return validate(target, value, nextFile, path)
  }
  const errors: string[] = []
  if (schema.type && !typeOk(schema.type as string, value)) return [`${path}: not ${schema.type as string}`]
  if ('const' in schema && value !== schema.const) errors.push(`${path}: not ${JSON.stringify(schema.const)}`)
  if (schema.enum && !(schema.enum as unknown[]).includes(value)) errors.push(`${path}: not in enum`)
  if (schema.pattern && (typeof value !== 'string' || !new RegExp(schema.pattern as string).test(value))) errors.push(`${path}: pattern`)
  if (typeof schema.minimum === 'number' && (typeof value !== 'number' || value < schema.minimum)) errors.push(`${path}: minimum`)
  const isObj = typeOk('object', value)
  if (isObj && schema.required) {
    for (const key of schema.required as string[]) if (!(key in (value as Schema))) errors.push(`${path}.${key}: required`)
  }
  if (isObj && schema.properties) {
    for (const [key, sub] of Object.entries(schema.properties as Record<string, Schema>)) {
      if (key in (value as Schema)) errors.push(...validate(sub, (value as Schema)[key], file, `${path}.${key}`))
    }
  }
  if (Array.isArray(value) && schema.items) value.forEach((item, i) => errors.push(...validate(schema.items as Schema, item, file, `${path}[${i}]`)))
  if (schema.oneOf) {
    const passing = (schema.oneOf as Schema[]).filter((s) => validate(s, value, file, path).length === 0).length
    if (passing !== 1) errors.push(`${path}: matches ${passing} of oneOf`)
  }
  if (schema.if && validate(schema.if as Schema, value, file, path).length === 0 && schema.then) {
    errors.push(...validate(schema.then as Schema, value, file, path))
  }
  return errors
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const vectors: any = JSON.parse(readFileSync(new URL('../vectors/app-messages.json', import.meta.url), 'utf8'))
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const chat: any = JSON.parse(readFileSync(new URL('../vectors/chat-messages.json', import.meta.url), 'utf8'))

describe('JSON Schema', () => {
  it('declares draft 2020-12 everywhere', () => {
    for (const file of ['inbox.schema.json', 'handshake.schema.json', 'app-message.schema.json', 'chat.schema.json']) {
      expect(doc(file).$schema).toBe('https://json-schema.org/draft/2020-12/schema')
    }
  })

  it('accepts every normalized sample in app-messages.json', () => {
    for (const s of [...vectors.phoneHello, ...vectors.desktopHello]) {
      expect(validate(doc('handshake.schema.json'), s.expected, 'handshake.schema.json')).toEqual([])
    }
    for (const s of vectors.appMessages) {
      if (s.expected === null) continue
      expect(validate(doc('app-message.schema.json'), s.expected, 'app-message.schema.json'), s.json).toEqual([])
    }
    expect(validate(doc('inbox.schema.json'), vectors.inboxWithUnknownFields.expected, 'inbox.schema.json')).toEqual([])
    for (let tick = 0; tick < 5; tick++) {
      const inbox = JSON.parse(JSON.stringify(cannedInbox({ id: 'a'.repeat(32), name: 'd' }, tick, 1790000000000)))
      expect(validate(doc('inbox.schema.json'), inbox, 'inbox.schema.json')).toEqual([])
    }
  })

  it('rejects the invalid samples the parsers reject', () => {
    for (const text of vectors.invalid.phoneHello) {
      // `min <= v` is a cross-field rule JSON Schema can't express; only the parser enforces it.
      if (JSON.parse(text).min > JSON.parse(text).v) continue
      expect(validate(doc('handshake.schema.json'), JSON.parse(text), 'handshake.schema.json'), text).not.toEqual([])
    }
    for (const text of vectors.invalid.desktopHello) {
      expect(validate(doc('handshake.schema.json'), JSON.parse(text), 'handshake.schema.json'), text).not.toEqual([])
    }
    for (const text of vectors.invalid.appMessages.slice(0, 4)) {
      expect(validate(doc('app-message.schema.json'), JSON.parse(text), 'app-message.schema.json'), text).not.toEqual([])
    }
  })

  it('accepts the chat samples in chat-messages.json (except unknown kinds, which no sender produces)', () => {
    const known = (value: unknown): boolean => !JSON.stringify(value).includes('"unknown"')
    const defs = { 'chat.open': 'openResult', 'chat.earlier': 'earlierResult', 'chat.detail': 'detailResult' } as Record<string, string>
    let checked = 0
    for (const s of chat.results) {
      if (!defs[s.op] || !known(s.expected)) continue
      expect(validate({ $ref: `chat.schema.json#/$defs/${defs[s.op]}` }, s.expected, 'chat.schema.json'), s.json).toEqual([])
      checked++
    }
    for (const s of chat.image.results) {
      expect(validate({ $ref: 'chat.schema.json#/$defs/imageResult' }, s.expected, 'chat.schema.json'), s.json).toEqual([])
      checked++
    }
    for (const s of [...chat.events, ...chat.requests]) {
      if (!known(s.expected)) continue
      expect(validate(doc('app-message.schema.json'), s.expected, 'app-message.schema.json'), s.json).toEqual([])
      checked++
    }
    for (const text of chat.invalid.events) {
      expect(validate(doc('app-message.schema.json'), JSON.parse(text), 'app-message.schema.json'), text).not.toEqual([])
    }
    expect(checked).toBeGreaterThan(8)
  })

  it('accepts the stream.new and branches.list samples and rejects the invalid ones (§8.12, §8.13)', () => {
    const check = (def: string, value: unknown) => validate({ $ref: `app-message.schema.json#/$defs/${def}` }, value, 'app-message.schema.json')
    for (const s of chat.streamNew.params) expect(check('streamNewParams', s.expected), s.json).toEqual([])
    for (const s of chat.streamNew.results) expect(check('streamNewResult', s.expected), s.json).toEqual([])
    for (const s of chat.branchesList.params) expect(check('branchesListParams', s.expected), s.json).toEqual([])
    for (const s of chat.branchesList.results) expect(check('branchesListResult', s.expected), s.json).toEqual([])
    for (const text of chat.streamNew.invalid.params) expect(check('streamNewParams', JSON.parse(text)), text).not.toEqual([])
    for (const text of chat.branchesList.invalid.results) expect(check('branchesListResult', JSON.parse(text)), text).not.toEqual([])
  })
})
