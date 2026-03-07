import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { HookServer } from '../src/main/hook-server'
import http from 'http'

function post(port: number, path: string, body: Record<string, unknown>, headers?: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body)
    const req = http.request(
      { hostname: '127.0.0.1', port, path, method: 'POST', headers: { 'Content-Type': 'application/json', ...headers } },
      (res) => resolve(res.statusCode ?? 0)
    )
    req.on('error', reject)
    req.write(data)
    req.end()
  })
}

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

  it('reports ready after start', () => {
    expect(server.isReady()).toBe(true)
  })

  it('emits session-start event with tabId and body', async () => {
    const events: { tabId: string; body: Record<string, unknown> }[] = []
    server.on('session-start', (tabId, body) => events.push({ tabId, body }))

    const status = await post(server.getPort(), '/hook/session-start', { session_id: 'sess-123' }, { 'X-Tab-Id': 'tab-1' })
    expect(status).toBe(200)

    await new Promise((r) => setTimeout(r, 10))
    expect(events).toHaveLength(1)
    expect(events[0].tabId).toBe('tab-1')
    expect(events[0].body.session_id).toBe('sess-123')
  })

  it('emits working event', async () => {
    const events: string[] = []
    server.on('working', (tabId) => events.push(tabId))

    await post(server.getPort(), '/hook/working', {}, { 'X-Tab-Id': 'tab-2' })
    await new Promise((r) => setTimeout(r, 10))
    expect(events).toEqual(['tab-2'])
  })

  it('emits stopped event', async () => {
    const events: string[] = []
    server.on('stopped', (tabId) => events.push(tabId))

    await post(server.getPort(), '/hook/stopped', {}, { 'X-Tab-Id': 'tab-3' })
    await new Promise((r) => setTimeout(r, 10))
    expect(events).toEqual(['tab-3'])
  })

  it('emits notification event with tabId and body', async () => {
    const events: { tabId: string; body: Record<string, unknown> }[] = []
    server.on('notification', (tabId, body) => events.push({ tabId, body }))

    await post(server.getPort(), '/hook/notification', { type: 'permission_prompt' }, { 'X-Tab-Id': 'tab-4' })
    await new Promise((r) => setTimeout(r, 10))
    expect(events).toHaveLength(1)
    expect(events[0].tabId).toBe('tab-4')
  })

  it('returns 404 for unknown paths', async () => {
    const status = await post(server.getPort(), '/hook/unknown', {})
    expect(status).toBe(404)
  })

  it('returns 400 when X-Tab-Id header is missing', async () => {
    const status = await post(server.getPort(), '/hook/working', {})
    expect(status).toBe(400)
  })
})
