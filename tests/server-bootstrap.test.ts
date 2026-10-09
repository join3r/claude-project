import { afterEach, describe, expect, it } from 'vitest'
import { spawnSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { readLocalBundle } from '../src/main/host/link/bundle-archive'
import { runBootstrap, InstallError } from '../src/server/bootstrap'
import { bundleDirName } from '../src/server/updater'
import { serverPaths, logToConsole } from '../src/server/server-env'
import { PeerStore } from '../src/main/host/link/peer-store'
import { encodeTicket, decodeTicket } from '../src/main/host/link/pairing'
import { startTestDesktop, startTestRelay, waitFor, type TestDesktop } from './helpers/host-link'

/**
 * The bootstrap (site/server/bootstrap.mjs) in process, against a real relay and a
 * desktop's ServerHub carrying the built bundle (out/server; `npm run
 * build:server`). It runs with --no-service: installing the service is
 * tests/server-service.test.ts's, and the live run's.
 */

const bundle = readLocalBundle(path.resolve('out/server'))
const cleanups: (() => unknown)[] = []
const savedHome = process.env.DEVTOOL_SERVER_HOME

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  logToConsole()
  if (savedHome === undefined) delete process.env.DEVTOOL_SERVER_HOME
  else process.env.DEVTOOL_SERVER_HOME = savedHome
})

async function setup(): Promise<{ d: TestDesktop; home: string; lines: string[]; relayUrl: string }> {
  const { relay } = await startTestRelay()
  cleanups.push(() => relay.close())
  const d = startTestDesktop(relay.url, { bundle: () => bundle })
  cleanups.push(() => d.close())
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'devtool-bootstrap-'))
  cleanups.push(() => fs.rmSync(home, { recursive: true, force: true }))
  process.env.DEVTOOL_SERVER_HOME = home
  // The Node the bundle names, "installed": this test's own Node.
  const paths = serverPaths()
  fs.mkdirSync(paths.nodeDir, { recursive: true })
  fs.symlinkSync(path.dirname(path.dirname(process.execPath)), path.join(paths.nodeDir, bundle!.manifest.node))
  return { d, home, lines: [], relayUrl: relay.url }
}

describe.skipIf(!bundle || process.platform === 'win32')('bootstrap', () => {
  it('token flow: pairs, receives and checks the bundle, and the desktop knows the server', { timeout: 60_000 }, async () => {
    const { d, home, lines } = await setup()
    const invite = d.hub.createInvite()
    await waitFor(() => d.hub.getState().relay.kind === 'online', 'desktop online')
    await runBootstrap({ token: invite.token, name: 'box', allowRoot: false, noService: true }, { out: (line) => lines.push(line) })

    expect(lines).toContain('Paired with test-mac.')
    expect(lines.some((line) => line.startsWith('Receiving the DevTool server from test-mac'))).toBe(true)
    expect(fs.readlinkSync(path.join(home, 'current'))).toBe(path.join('app', bundleDirName(bundle!.manifest)))
    expect(fs.readlinkSync(path.join(home, 'node', 'current'))).toBe(bundle!.manifest.node)
    expect(readLocalBundle(path.join(home, 'current'))?.manifest.sha256).toBe(bundle!.manifest.sha256)
    const server = d.hub.getState().servers[0]
    // The installer connected, the service hasn't yet: Add server keeps waiting.
    expect(server).toMatchObject({ name: 'box', host: { os: process.platform }, installing: true })
    expect(d.hub.getState().invite).toMatchObject({ status: 'paired', serverId: server.id })
    expect(new PeerStore(path.join(home, 'data'), 'desktops.json').list().map((r) => r.id)).toEqual([d.identity.get().id])
    expect(d.log.some((line) => line.includes('update=server-empty uploading'))).toBe(true)
    // The token (and its secret) is in no log and no file the bootstrap wrote.
    const secretText = invite.token.split('.')[0]
    const written = spawnSync('grep', ['-rl', secretText.slice(10, 50), home], { encoding: 'utf8' })
    expect(written.stdout).toBe('')
    expect(fs.readFileSync(path.join(home, 'logs', 'install.log'), 'utf8')).toContain('bootstrap done')

    // Run again with a new invite: pairs again, nothing to upload, still fine.
    const again = d.hub.createInvite()
    const second: string[] = []
    await runBootstrap({ token: again.token, allowRoot: false, noService: true }, { out: (line) => second.push(line) })
    expect(second).toContain('Paired with test-mac.')
    expect(second.some((line) => line.startsWith('Receiving'))).toBe(false)
    expect(d.log.some((line) => line.includes('update=same'))).toBe(true)
    expect(d.hub.getState().servers).toHaveLength(1)
  })

  it('code flow: prints a code, the desktop pairs with it, and the bundle arrives', { timeout: 60_000 }, async () => {
    const { d, home, lines, relayUrl } = await setup()
    const run = runBootstrap({ relay: relayUrl, allowRoot: false, noService: true }, { out: (line) => lines.push(line) })
    run.catch(() => {})
    await waitFor(() => lines.some((line) => /^ {2}\S{100,}$/.test(line)), 'pairing code', 15_000)
    const code = lines.find((line) => /^ {2}\S{100,}$/.test(line))!.trim()
    // The hub needs the relay socket for code pairing; it has no server yet.
    await d.hub.pairWithCode(code)
    await run
    expect(lines).toContain('Paired with test-mac.')
    expect(readLocalBundle(path.join(home, 'current'))?.manifest.sha256).toBe(bundle!.manifest.sha256)
  })

  it('refuses an expired token and a pairing code passed as a token', async () => {
    const { d } = await setup()
    const invite = d.hub.createInvite()
    const expired = encodeTicket({ ...decodeTicket(invite.token), exp: Math.floor(Date.now() / 1000) - 60 })
    await expect(runBootstrap({ token: expired, allowRoot: false, noService: true })).rejects.toThrow(/expired/)
    const device = encodeTicket({ ...decodeTicket(invite.token), kind: 'device', node: undefined })
    await expect(runBootstrap({ token: device, allowRoot: false, noService: true })).rejects.toBeInstanceOf(InstallError)
  })
})
