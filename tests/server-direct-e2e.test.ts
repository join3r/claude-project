import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { RelayServer } from '../relay/src/server.ts'
import { pairByCode, startTestDesktop, startTestRelay, startTestServer, waitFor, type TestDesktop, type TestServer } from './helpers/host-link'

/**
 * The direct path end to end (protocol/SERVER.md §13): the session starts on a
 * real relay, the desktop offers a WebRTC data channel through it, and the link
 * moves to the pipe. Both ends run in this process, so ICE pairs host candidates.
 */

const cleanups: (() => unknown)[] = []
let savedStun: string | undefined

beforeAll(() => {
  // No STUN in tests: host candidates are enough on one machine.
  savedStun = process.env.DEVTOOL_STUN
  process.env.DEVTOOL_STUN = ''
})
afterAll(() => {
  if (savedStun === undefined) delete process.env.DEVTOOL_STUN
  else process.env.DEVTOOL_STUN = savedStun
})
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function relay(): Promise<RelayServer> {
  const { relay } = await startTestRelay()
  cleanups.push(() => relay.close())
  return relay
}

function desktop(relayUrl: string): TestDesktop {
  const d = startTestDesktop(relayUrl, { direct: true })
  cleanups.push(() => d.close())
  return d
}

async function server(relayUrl: string): Promise<TestServer> {
  const s = await startTestServer(relayUrl)
  cleanups.push(() => s.close())
  return s
}

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devtool-direct-cwd-'))
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

function shTab(tabId: string, cwd: string, script: string): unknown[] {
  return [tabId, '/bin/sh', cwd, 80, 24, ['-c', script], {}, undefined, undefined]
}

/** The server's link for this desktop, for poking at its pipe. */
function serverPipe(s: TestServer, desktopId: string): { close(why?: string): void } {
  const links = (s.link as unknown as { links: Map<string, { pipe: { close(why?: string): void } | null }> }).links
  const pipe = links.get(desktopId)?.pipe
  if (!pipe) throw new Error('no direct pipe on the server')
  return pipe
}

describe.skipIf(process.platform === 'win32')('direct path end to end', () => {
  it('moves to a direct pipe after the relay handshake, keeps output in order, and survives the relay going away', { timeout: 60_000 }, async () => {
    const r = await relay()
    const s = await server(r.url)
    const d = desktop(r.url)
    const desktopId = d.identity.get().id
    // A terminal that prints the whole time the link moves.
    await pairByCode(d, s)
    const cwd = tempDir()
    await d.hub.call(s.id, 'win:1', 'pty-spawn', shTab('tab-1', cwd, 'i=0; while [ $i -lt 3000 ]; do i=$((i+1)); echo "n $i"; done; echo end-marker; exec cat'), { focused: true })

    await waitFor(() => d.status(s.id)?.path === 'direct', 'desktop on the direct path', 30_000)
    await waitFor(() => s.link.directDesktops().includes(desktopId), 'server on the direct path', 10_000)
    expect(d.log.some((line) => line.includes('direct path up'))).toBe(true)

    await waitFor(() => d.ptyText('tab-1').includes('end-marker'), 'pty output')
    const numbers = d.ptyText('tab-1').replace(/\r/g, '').split('\n').filter((l) => l.startsWith('n ')).map((l) => Number(l.slice(2)))
    expect(numbers).toEqual(Array.from({ length: 3000 }, (_, i) => i + 1))

    // Without the relay the session lives on over the pipe.
    await r.close()
    await waitFor(() => d.log.some((line) => line.includes('staying on the direct path')), 'desktop noticed the relay is gone', 10_000)
    expect(d.status(s.id)?.state).toBe('online')
    await d.hub.call(s.id, 'win:1', 'pty-write', ['tab-1', 'typed-over-direct\r'])
    await waitFor(() => d.ptyText('tab-1').includes('typed-over-direct'), 'echo over the direct path')
    const { local } = await d.hub.call(s.id, 'win:1', 'load-projects') as { local: { revision: number } }
    expect(typeof local.revision).toBe('number')
  })

  it('falls back to the relay when the pipe breaks, then goes direct again', { timeout: 60_000 }, async () => {
    const r = await relay()
    const s = await server(r.url)
    const d = desktop(r.url)
    const desktopId = d.identity.get().id
    await pairByCode(d, s)
    await waitFor(() => d.status(s.id)?.path === 'direct', 'direct', 30_000)

    serverPipe(s, desktopId).close('test')
    await waitFor(() => d.log.some((line) => line.includes('direct path lost')), 'desktop saw the pipe break', 40_000)
    // The new session starts on the relay and works there before it moves again.
    await waitFor(() => d.status(s.id)?.state === 'online', 'back online', 20_000)
    const info = await d.hub.call(s.id, 'win:1', 'load-config')
    expect(info).toBeTruthy()
    await waitFor(() => d.status(s.id)?.path === 'direct', 'direct again', 30_000)
    expect(d.log.filter((line) => line.includes('direct path up')).length).toBeGreaterThanOrEqual(2)
  })
})
