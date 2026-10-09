import fs from 'fs'
import os from 'os'
import path from 'path'
import { b64uEncode } from '../../protocol/ts/index.ts'
import type { VersionInfo } from '../../protocol/ts/index.ts'
import { startRelayServer, type RelayServer } from '../../relay/src/server.ts'
import type { RelayLimits } from '../../relay/src/relay.ts'
import { MemoryStore } from '../../relay/src/store.ts'
import { IdentityStore, type SecretEncryptor } from '../../src/main/mobile/identity'
import { RelayClient } from '../../src/main/mobile/relay-client'
import { RelayMux } from '../../src/main/host/link/relay-mux'
import { ServerHub, type ServerEvent } from '../../src/main/servers/server-hub'
import type { ServerHost } from '../../src/server/server-host'
import type { ServerLink, ServerLinkOptions } from '../../src/server/server-link'
import type { PowerSaveApi } from '../../src/main/sleep-blocker'
import type { ServerStatus } from '../../src/shared/servers'
import { waitFor } from './relay-phone'

/**
 * A desktop's ServerHub and a server's host + ServerLink, in process, on a real
 * relay (relay/src) on an ephemeral port. The server side is the same code the
 * daemon runs (`startServerHost` + `createServerLink`); the desktop side is the
 * one AppRuntime builds, minus Electron.
 */

export const plaintext: SecretEncryptor = {
  isAvailable: () => false,
  encrypt: () => { throw new Error('unused') },
  decrypt: () => { throw new Error('unused') }
}

const noPowerSave: PowerSaveApi = { start: () => 1, stop: () => {}, isStarted: () => false }
const build = { version: '0.0.0-test', commit: 'test', builtAt: '', bundleSha: '' }

export async function startTestRelay(limits: Partial<RelayLimits> = {}): Promise<{ relay: RelayServer; store: MemoryStore }> {
  const store = new MemoryStore()
  // Tests reconnect a lot from one IP.
  const relay = await startRelayServer({ store, port: 0, host: '127.0.0.1', limits: { connectionsPerIpPerMinute: 1000, ...limits } })
  return { relay, store }
}

export interface TestDesktop {
  dir: string
  identity: IdentityStore
  client: RelayClient
  mux: RelayMux
  hub: ServerHub
  events: ServerEvent[]
  log: string[]
  status(serverId: string): ServerStatus | undefined
  /** Everything a terminal tab printed for `client` so far. */
  ptyText(tabId: string, client?: string): string
  close(): void
}

export function startTestDesktop(relayUrl: string, options: { version?: VersionInfo } = {}): TestDesktop {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devtool-link-desktop-'))
  const log: string[] = []
  const identity = new IdentityStore(path.join(dir, 'mobile'), plaintext)
  const client = new RelayClient({
    role: 'desktop',
    binary: true,
    ed25519: () => identity.get().ed25519,
    deviceId: () => identity.get().id,
    minBackoffMs: 50,
    maxBackoffMs: 500,
    log: (line) => log.push(`relay ${line}`)
  })
  const mux = new RelayMux(client, (line) => log.push(line))
  const hub = new ServerHub({
    configDir: dir,
    relay: mux,
    identity,
    relayUrl: () => relayUrl,
    build,
    desktopName: () => 'test-mac',
    log: (line) => log.push(line),
    ...(options.version ? { version: options.version } : {})
  })
  const events: ServerEvent[] = []
  hub.onEvent((event) => events.push(event))
  hub.start()
  return {
    dir, identity, client, mux, hub, events, log,
    status: (serverId) => hub.getState().servers.find((s) => s.id === serverId),
    ptyText: (tabId, forClient) => events
      .filter((e) => e.ch === 'pty-data' && e.args[0] === tabId && (forClient === undefined || e.client === forClient))
      .map((e) => String(e.args[1]))
      .join(''),
    close: () => {
      hub.stop()
      client.close()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }
}

export interface TestServer {
  home: string
  server: ServerHost
  link: ServerLink
  log: string[]
  id: string
  close(): Promise<void>
}

export async function startTestServer(relayUrl: string, overrides: Partial<ServerLinkOptions> = {}): Promise<TestServer> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'devtool-link-server-'))
  // Imported here: the host loads node-pty.
  const { startServerHost, createServerLink } = await import('../../src/server/server-host')
  const { loadServerManifest, serverPaths } = await import('../../src/server/server-env')
  const { saveServerConfig } = await import('../../src/server/server-config')
  const log: string[] = []
  const server = await startServerHost({
    paths: serverPaths({ DEVTOOL_SERVER_HOME: home }),
    manifest: loadServerManifest(path.resolve('src/server')),
    bundleDir: path.resolve('resources'),
    powerSave: noPowerSave,
    log: (line) => log.push(line)
  })
  saveServerConfig(server.env.paths.dataDir, { relayUrl, name: 'test-server' })
  const link = createServerLink(server, overrides)
  link.start()
  return {
    home, server, link, log,
    id: server.host.identity.get().id,
    close: async () => {
      link.stop()
      await server.shutdown()
      fs.rmSync(home, { recursive: true, force: true })
    }
  }
}

/** The dev pairing (protocol/SERVER.md §7) end to end: offer, pair, authorize. Resolves once the desktop's link is up. */
export async function devPair(desktop: TestDesktop, server: TestServer, expect: ServerStatus['state'] = 'online'): Promise<void> {
  const identity = desktop.identity.get()
  const code = await server.link.offerDevPair({ x25519Pub: b64uEncode(identity.x25519.pub), ed25519Pub: b64uEncode(identity.ed25519.pub), name: 'test-mac' })
  desktop.hub.devPair(code)
  await waitFor(() => desktop.status(server.id)?.state === expect, `server ${expect}`, 10_000)
}

export { waitFor }
