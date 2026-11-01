import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { HookServer, hookTokensMatch } from '../src/main/hook-server'
import { HOOK_TAB_ID_HEADER, HOOK_TOKEN_HEADER, MAX_HOOK_BODY_BYTES } from '../src/shared/hook-protocol'
import http from 'http'

function request(
  port: number,
  path: string,
  body: string | Record<string, unknown>,
  headers?: Record<string, string>,
  method = 'POST'
): Promise<number> {
  return new Promise((resolve, reject) => {
    const data = typeof body === 'string' ? body : JSON.stringify(body)
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method,
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...headers }
      },
      (res) => {
        res.resume()
        res.on('end', () => resolve(res.statusCode ?? 0))
      }
    )
    req.on('error', reject)
    req.write(data)
    req.end()
  })
}

function authedHeaders(server: HookServer, tabId = 'tab-1'): Record<string, string> {
  return {
    [HOOK_TAB_ID_HEADER]: tabId,
    [HOOK_TOKEN_HEADER]: server.getToken()
  }
}

describe('hookTokensMatch', () => {
  it('accepts an exact match', () => {
    expect(hookTokensMatch('abc', 'abc')).toBe(true)
  })

  it('rejects missing, wrong, or length-mismatched tokens', () => {
    expect(hookTokensMatch(undefined, 'abc')).toBe(false)
    expect(hookTokensMatch('ab', 'abc')).toBe(false)
    expect(hookTokensMatch('abd', 'abc')).toBe(false)
  })
})

describe('HookServer', () => {
  let server: HookServer

  beforeEach(async () => {
    server = new HookServer()
    await server.start()
  })

  afterEach(async () => {
    await server.stop()
  })

  it('starts on a random port', () => {
    expect(server.getPort()).toBeGreaterThan(0)
  })

  it('mints a non-empty token', () => {
    expect(server.getToken().length).toBeGreaterThan(20)
  })

  it('reports ready after start', () => {
    expect(server.isReady()).toBe(true)
  })

  it('emits session-start event with tabId and body', async () => {
    const events: { tabId: string; body: Record<string, unknown> }[] = []
    server.on('session-start', (tabId, body) => events.push({ tabId, body }))

    const status = await request(server.getPort(), '/hook/session-start', { session_id: 'sess-123' }, authedHeaders(server, 'tab-1'))
    expect(status).toBe(200)

    await new Promise((r) => setTimeout(r, 10))
    expect(events).toHaveLength(1)
    expect(events[0].tabId).toBe('tab-1')
    expect(events[0].body.session_id).toBe('sess-123')
  })

  it('answers with the responder, and never emits the request endpoints', async () => {
    const emitted: string[] = []
    server.on('context', () => emitted.push('context'))
    server.on('session-start', () => emitted.push('session-start'))
    server.setResponder((endpoint, tabId) => (endpoint === 'working' ? undefined : `${endpoint}:${tabId}`))

    const answer = (path: string): Promise<{ status: number; text: string }> => new Promise((resolve, reject) => {
      const req = http.request(
        { hostname: '127.0.0.1', port: server.getPort(), path, method: 'POST', headers: authedHeaders(server, 'tab-9') },
        (res) => {
          let text = ''
          res.on('data', (chunk) => { text += chunk })
          res.on('end', () => resolve({ status: res.statusCode ?? 0, text }))
        }
      )
      req.on('error', reject)
      req.end('{}')
    })

    expect(await answer('/hook/context')).toEqual({ status: 200, text: 'context:tab-9' })
    expect(await answer('/hook/session-start')).toEqual({ status: 200, text: 'session-start:tab-9' })
    expect(await answer('/hook/working')).toEqual({ status: 200, text: '' })
    expect(emitted).toEqual(['session-start'])
  })

  it('takes only the tab\'s own token for land and update', async () => {
    server.setResponder(() => 'ok')
    const shared = await request(server.getPort(), '/hook/land', {}, authedHeaders(server, 'tab-1'))
    const otherTab = await request(server.getPort(), '/hook/land', {}, { [HOOK_TAB_ID_HEADER]: 'tab-2', [HOOK_TOKEN_HEADER]: server.tabToken('tab-1') })
    const own = await request(server.getPort(), '/hook/update', {}, { [HOOK_TAB_ID_HEADER]: 'tab-1', [HOOK_TOKEN_HEADER]: server.tabToken('tab-1') })
    expect([shared, otherTab, own]).toEqual([401, 401, 200])
  })

  it('emits working event', async () => {
    const events: string[] = []
    server.on('working', (tabId) => events.push(tabId))

    await request(server.getPort(), '/hook/working', {}, authedHeaders(server, 'tab-2'))
    await new Promise((r) => setTimeout(r, 10))
    expect(events).toEqual(['tab-2'])
  })

  it('emits stopped event', async () => {
    const events: string[] = []
    server.on('stopped', (tabId) => events.push(tabId))

    await request(server.getPort(), '/hook/stopped', {}, authedHeaders(server, 'tab-3'))
    await new Promise((r) => setTimeout(r, 10))
    expect(events).toEqual(['tab-3'])
  })

  it('emits notification event with tabId and body', async () => {
    const events: { tabId: string; body: Record<string, unknown> }[] = []
    server.on('notification', (tabId, body) => events.push({ tabId, body }))

    await request(server.getPort(), '/hook/notification', { type: 'permission_prompt' }, authedHeaders(server, 'tab-4'))
    await new Promise((r) => setTimeout(r, 10))
    expect(events).toHaveLength(1)
    expect(events[0].tabId).toBe('tab-4')
  })

  it('returns 404 for unknown paths', async () => {
    const status = await request(server.getPort(), '/hook/unknown', {}, authedHeaders(server))
    expect(status).toBe(404)
  })

  it('returns 405 for non-POST methods', async () => {
    const status = await request(server.getPort(), '/hook/working', {}, authedHeaders(server), 'GET')
    expect(status).toBe(405)
  })

  it('returns 400 when X-Tab-Id header is missing', async () => {
    const status = await request(server.getPort(), '/hook/working', {}, { [HOOK_TOKEN_HEADER]: server.getToken() })
    expect(status).toBe(400)
  })

  it('returns 401 when the token is missing', async () => {
    const events: string[] = []
    server.on('working', (tabId) => events.push(tabId))
    const status = await request(server.getPort(), '/hook/working', {}, { [HOOK_TAB_ID_HEADER]: 'tab-1' })
    expect(status).toBe(401)
    await new Promise((r) => setTimeout(r, 10))
    expect(events).toEqual([])
  })

  it('returns 401 when the token is wrong', async () => {
    const status = await request(
      server.getPort(),
      '/hook/working',
      {},
      { [HOOK_TAB_ID_HEADER]: 'tab-1', [HOOK_TOKEN_HEADER]: 'not-the-token' }
    )
    expect(status).toBe(401)
  })

  it('returns 413 when the body is too large', async () => {
    const events: string[] = []
    server.on('working', (tabId) => events.push(tabId))
    const huge = 'x'.repeat(MAX_HOOK_BODY_BYTES + 1)
    const status = await request(server.getPort(), '/hook/working', huge, authedHeaders(server, 'tab-1'))
    expect(status).toBe(413)
    await new Promise((r) => setTimeout(r, 10))
    expect(events).toEqual([])
  })
})

describe('HookServer logging', () => {
  let logged: string[]
  let server: HookServer

  beforeEach(async () => {
    logged = []
    server = new HookServer((message) => logged.push(message))
    await server.start()
  })

  afterEach(async () => {
    await server.stop()
  })

  it('logs accepted hooks with endpoint, tab id and notification message', async () => {
    await request(server.getPort(), '/hook/working', {}, authedHeaders(server, 'tab-1'))
    await request(server.getPort(), '/hook/notification', { message: 'needs your permission' }, authedHeaders(server, 'tab-1'))
    await new Promise((r) => setTimeout(r, 10))

    expect(logged).toContain('hook endpoint=working tabId=tab-1')
    expect(logged).toContain('hook endpoint=notification tabId=tab-1 message="needs your permission"')
  })

  it('logs a hook that arrived without a tab id', async () => {
    await request(server.getPort(), '/hook/stopped', {}, { [HOOK_TOKEN_HEADER]: server.getToken() })
    await new Promise((r) => setTimeout(r, 10))
    expect(logged).toContain('hook reject-no-tab-id endpoint=stopped')
  })

  it('logs an unauthorized hook', async () => {
    await request(server.getPort(), '/hook/working', {}, { [HOOK_TAB_ID_HEADER]: 'tab-1' })
    await new Promise((r) => setTimeout(r, 10))
    expect(logged).toContain('hook reject-unauthorized endpoint=working tabId=tab-1')
  })

  it('logs an unknown endpoint', async () => {
    await request(server.getPort(), '/hook/nope', {}, authedHeaders(server, 'tab-1'))
    await new Promise((r) => setTimeout(r, 10))
    expect(logged).toContain('hook reject-unknown url=/hook/nope')
  })
})
