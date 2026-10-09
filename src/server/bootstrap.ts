import { spawn } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { ProtocolError } from '../../protocol/ts/index.ts'
import { IdentityStore } from '../main/mobile/identity'
import { RelayClient } from '../main/mobile/relay-client'
import { acquireInstanceLock } from '../main/instance-lock'
import { readLocalBundle } from '../main/host/link/bundle-archive'
import { LinkChannel } from '../main/host/link/link-channels'
import { BOOTSTRAP_PROTOCOL, PairingError, decodeTicket, isTicketExpired, type PairingTicket } from '../main/host/link/pairing'
import type { PeerRecord } from '../main/host/link/peer-store'
import { RelayMux } from '../main/host/link/relay-mux'
import type { LinkStream } from '../main/host/link/stream'
import { DEFAULT_MOBILE_RELAY_URL, isValidRelayUrl, normalizeRelayUrl } from '../shared/mobile'
import { NotRunningError, controlRequest } from './control'
import { loadServerConfig, saveServerConfig, serverDisplayName } from './server-config'
import { DEFAULT_SERVER_HOME_NAME, ensureServerDirs, plaintextSecrets, serverHostInfo, serverPaths, logToFile, consoleLog, type ServerPaths } from './server-env'
import { ServerLink } from './server-link'
import { installService, linkCliOnPath, readServiceRecord, serviceContext, stopService } from './service'
import { BUNDLE_STREAM_KIND, ServerUpdater } from './updater'
import type { DaemonStatus } from './cli'

/**
 * `site/server/bootstrap.mjs`: what `site/install` runs once it has Node. It pairs
 * this machine with a desktop, receives the server bundle from it, installs the
 * service and waits until the desktop sees the server online.
 *
 *   DEVTOOL_TOKEN=<install token> node bootstrap.mjs   the token flow (the one-liner)
 *   node bootstrap.mjs [--relay <url>]                  prints a pairing code instead
 *   ... [--name <name>] [--allow-root] [--no-service]
 *
 * The token comes in the environment (`site/install` passes it so), never on the
 * command line, where other users of the machine could read it from `ps` and pair
 * first. `--token` still works by hand, with a warning.
 *
 * It speaks a small, frozen part of the protocol (BOOTSTRAP_PROTOCOL 1): pairing,
 * the link handshake, the `bundle` stream and `server-bootstrap-done`, so a desktop
 * newer than this file can still install with it. Running it again on a machine
 * that has a server pairs again and updates it in place.
 */

export interface BootstrapArgs {
  token?: string
  name?: string
  relay?: string
  allowRoot: boolean
  noService: boolean
}

export const BOOTSTRAP_USAGE = 'usage: [DEVTOOL_TOKEN=<token>] bootstrap.mjs [--name <name>] [--relay <url>] [--allow-root] [--no-service]'

export function parseBootstrapArgs(argv: string[]): BootstrapArgs {
  const args: BootstrapArgs = { allowRoot: false, noService: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const value = (): string => {
      const next = argv[++i]
      if (next === undefined || next.startsWith('--')) throw new Error(`${arg} needs a value`)
      return next
    }
    switch (arg) {
      case '--token': args.token = value(); break
      case '--name': args.name = value(); break
      case '--relay': args.relay = value(); break
      case '--allow-root': args.allowRoot = true; break
      case '--no-service': args.noService = true; break
      default: throw new Error(`unexpected argument: ${arg}\n${BOOTSTRAP_USAGE}`)
    }
  }
  return args
}

/** A problem the user can act on: printed as is, without a stack. */
export class InstallError extends Error {
  constructor(message: string, readonly exitCode = 1) {
    super(message)
    this.name = 'InstallError'
  }
}

const MIN_NODE_MAJOR = 24
const MIN_GLIBC: [number, number] = [2, 28]
const MIN_FREE_BYTES = 150 * 1024 * 1024
const DONE_TIMEOUT_MS = 10 * 60_000
const ONLINE_TIMEOUT_MS = 90_000

/** The machine checks `site/install` does in sh, again, for a bootstrap run by hand. */
export function checkPlatform(info: { platform: string; arch: string; node: string; glibc: string | null; uid: number | null; allowRoot: boolean }): void {
  if (info.platform !== 'linux' && info.platform !== 'darwin') throw new InstallError(`DevTool servers run on Linux and macOS, not ${info.platform}`)
  if (info.arch !== 'x64' && info.arch !== 'arm64') throw new InstallError(`DevTool servers run on x64 and arm64 CPUs, not ${info.arch}`)
  if (Number(info.node.split('.')[0]) < MIN_NODE_MAJOR) throw new InstallError(`The installer needs Node ${MIN_NODE_MAJOR} or newer, this is ${info.node}`)
  if (info.platform === 'linux') {
    if (!info.glibc) throw new InstallError('This Linux has no glibc (Alpine and other musl systems are not supported); the server needs glibc 2.28 or newer')
    const [major, minor] = info.glibc.split('.').map(Number)
    if (major < MIN_GLIBC[0] || (major === MIN_GLIBC[0] && minor < MIN_GLIBC[1])) throw new InstallError(`glibc ${info.glibc} is too old; the server needs ${MIN_GLIBC.join('.')} or newer`)
  }
  if (info.uid === 0 && !info.allowRoot) {
    throw new InstallError('Refusing to install as root. Run the command as the user who will work on this server, or add --allow-root.')
  }
}

function glibcVersion(): string | null {
  if (process.platform !== 'linux') return null
  const report = process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined
  return report?.header?.glibcVersionRuntime ?? null
}

function freeBytes(dir: string): number | null {
  try {
    const stats = fs.statfsSync(dir)
    return stats.bavail * stats.bsize
  } catch {
    return null
  }
}

function checkBundleRuns(paths: ServerPaths): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(path.join(paths.nodeCurrent, 'bin', 'node'), [path.join(paths.current, 'main.js'), '--check'], { stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString() })
    child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString() })
    child.on('error', (err) => resolve({ ok: false, output: err.message }))
    child.on('exit', (code) => resolve({ ok: code === 0, output: output.trim() }))
  })
}

export interface BootstrapIo {
  out: (line: string) => void
}

/** The whole install. Throws InstallError (or anything unexpected). */
export async function runBootstrap(args: BootstrapArgs, io: BootstrapIo = { out: (line) => process.stdout.write(`${line}\n`) }): Promise<void> {
  checkPlatform({ platform: process.platform, arch: process.arch, node: process.versions.node, glibc: glibcVersion(), uid: process.getuid?.() ?? null, allowRoot: args.allowRoot })

  let ticket: PairingTicket | null = null
  if (args.token) {
    try {
      ticket = decodeTicket(args.token, 'install')
    } catch (err) {
      const message = err instanceof ProtocolError ? err.message : String(err)
      throw new InstallError(/pairing code for a desktop/.test(message)
        ? 'This is a pairing code for DevTool, not an install token. Paste it into DevTool (Add server, I have a code), or run the installer without it.'
        : 'This install token is damaged. Copy the whole command from DevTool (Add server) again.')
    }
    if (isTicketExpired(ticket)) throw new InstallError(`This install command expired at ${new Date(ticket.exp * 1000).toLocaleTimeString()}. Create a new one in DevTool (Add server).`)
  }

  const paths = serverPaths()
  ensureServerDirs(paths)
  // Everything the user doesn't need to see goes here.
  logToFile(path.join(paths.logsDir, 'install.log'))
  const log = consoleLog
  log(`bootstrap ${BOOTSTRAP_PROTOCOL} node=${process.version} ${process.platform}-${process.arch} home=${paths.home}`)
  const free = freeBytes(paths.home)
  if (free !== null && free < MIN_FREE_BYTES) throw new InstallError(`Not enough disk space in ${paths.home}: ${Math.round(free / 1048576)} MB free, the server needs about ${MIN_FREE_BYTES / 1048576} MB`)

  // A server already running here holds the identity's relay socket: stop it, then take over.
  const previous = readServiceRecord(paths)
  if (previous) {
    io.out('Stopping the DevTool server that runs here, to update it...')
    await stopService(serviceContext(paths, log), previous).catch((err: unknown) => log(`stop failed: ${String(err)}`))
  }
  const lock = await acquireInstanceLock(paths.dataDir, () => {})
  if (!lock.acquired) {
    throw new InstallError(`A DevTool server is running on ${paths.dataDir}${lock.ownerPid ? ` (pid ${lock.ownerPid})` : ''}. Stop it first (devtool-server uninstall --keep-data), then run this again.`)
  }

  const existing = loadServerConfig(paths.dataDir)
  const relayFlag = args.relay ?? process.env.DEVTOOL_RELAY_URL
  if (relayFlag && !isValidRelayUrl(relayFlag)) throw new InstallError(`Not a relay URL: ${relayFlag}`)
  const relayUrl = normalizeRelayUrl(ticket?.relay ?? relayFlag ?? (existing.relayUrl || DEFAULT_MOBILE_RELAY_URL))
  const config = saveServerConfig(paths.dataDir, { relayUrl, ...(args.name !== undefined ? { name: args.name.trim().slice(0, 100) } : {}) })
  const name = serverDisplayName(config)

  const identity = new IdentityStore(path.join(paths.dataDir, 'mobile'), plaintextSecrets, log)
  const installed = () => readLocalBundle(paths.current)
  const updater = new ServerUpdater({ paths, running: installed()?.manifest ?? null, mode: 'install', log })
  const client = new RelayClient({
    role: 'server',
    binary: true,
    ed25519: () => identity.get().ed25519,
    deviceId: () => identity.get().id,
    log: (line) => log(`relay ${line}`)
  })
  const mux = new RelayMux(client, log)

  let desktop: PeerRecord | null = null
  let finish: (value: { desktopId: string; uploaded: boolean }) => void = () => {}
  const done = new Promise<{ desktopId: string; uploaded: boolean }>((resolve) => { finish = resolve })
  let pairedWith: (record: PeerRecord) => void = () => {}
  const paired = new Promise<PeerRecord>((resolve) => { pairedWith = resolve })

  const link = new ServerLink({
    relay: mux,
    identity,
    dataDir: paths.dataDir,
    relayUrl: () => relayUrl,
    name: () => name,
    build: () => {
      const manifest = installed()?.manifest
      return manifest ? { version: manifest.version, commit: manifest.commit, builtAt: manifest.builtAt, bundleSha: manifest.sha256 } : { version: '', commit: '', builtAt: '', bundleSha: '' }
    },
    host: serverHostInfo,
    features: ['bootstrap'],
    log,
    streams: new Map([[BUNDLE_STREAM_KIND, async (stream: LinkStream, context: { peer: string }) => {
      io.out(`Receiving the DevTool server from ${desktop?.name ?? 'DevTool'}...`)
      await updater.streamHandler()(stream, context)
    }]]),
    linkCall: (call) => {
      if (call.ch === LinkChannel.BootstrapDone) {
        const uploaded = (call.args[0] as { uploaded?: unknown } | undefined)?.uploaded === true
        finish({ desktopId: call.desktopId, uploaded })
        return Promise.resolve({ ok: true })
      }
      if (call.ch === LinkChannel.Info) return Promise.resolve({ update: null })
      return undefined
    },
    onPaired: (record) => pairedWith(record)
  })

  const cleanup = () => {
    link.stop()
    client.close()
    lock.release()
  }
  const onSignal = () => {
    cleanup()
    process.stderr.write('\nInstall cancelled.\n')
    process.exit(130)
  }
  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)

  try {
    link.start()
    if (ticket) {
      io.out(`Pairing with ${ticket.name || 'DevTool'} through ${relayUrl}...`)
      desktop = await link.pairWithInstallToken(ticket, { bootstrap: BOOTSTRAP_PROTOCOL })
    } else {
      const code = await link.createPairingCode()
      io.out('')
      io.out('No install token, so pair from DevTool: Add server, then "I have a code", and paste:')
      io.out('')
      io.out(`  ${code.code}`)
      io.out('')
      io.out(`The code works once, until ${new Date(code.exp * 1000).toLocaleTimeString()}. Waiting for DevTool...`)
      desktop = await Promise.race([
        paired,
        new Promise<never>((_, reject) => setTimeout(() => reject(new InstallError('The pairing code expired. Run the installer again.')), Math.max(0, code.exp * 1000 - Date.now())).unref())
      ])
    }
    io.out(`Paired with ${desktop.name}.`)

    const result = await Promise.race([
      done,
      new Promise<never>((_, reject) => setTimeout(() => reject(new InstallError(`${desktop?.name ?? 'DevTool'} paired but did not finish sending the server. Keep DevTool open and run the command again.`)), DONE_TIMEOUT_MS).unref())
    ])
    log(`bootstrap done desktop=${result.desktopId} uploaded=${result.uploaded}`)
    const bundle = installed()
    if (!bundle) throw new InstallError(`${desktop.name} has no server bundle to send. Update DevTool (a dev build needs npm run build:server) and run the command again.`)
    io.out(`DevTool server ${bundle.manifest.version} (${bundle.manifest.commit.slice(0, 12)}) is in ${paths.home}.`)
  } catch (err) {
    cleanup()
    if (err instanceof PairingError) throw new InstallError(err.message)
    throw err
  }
  cleanup()
  process.off('SIGINT', onSignal)
  process.off('SIGTERM', onSignal)

  const check = await checkBundleRuns(paths)
  log(`check ok=${check.ok}\n${check.output}`)
  if (!check.ok) throw new InstallError(`The server does not run on this machine:\n${check.output}`)

  if (args.noService) {
    io.out(`Installed without a service. Start it with: ${path.join(paths.binDir, 'devtool-server')} start`)
    return
  }
  io.out('Installing the service...')
  const ctx = serviceContext(paths, log)
  const service = await installService(ctx)
  io.out(`Service: ${service.record.kind === 'systemd' ? `systemd user unit ${service.record.name}` : service.record.kind === 'launchd' ? `LaunchAgent ${service.record.name} (${service.record.domain})` : 'background process with an @reboot crontab line'}`)
  for (const note of service.notes) io.out(note)
  const linked = linkCliOnPath(paths, os.homedir(), process.env.PATH ?? '', paths.home === path.join(os.homedir(), DEFAULT_SERVER_HOME_NAME))

  io.out(`Waiting for ${desktop.name} to see the server online...`)
  const desktopId = desktop.id
  const until = Date.now() + ONLINE_TIMEOUT_MS
  for (;;) {
    let lastError: string
    try {
      const status = await controlRequest(paths, { cmd: 'status' }, 5000) as DaemonStatus
      if (status.desktops.some((d) => d.id === desktopId && d.online)) break
      lastError = status.relay.state === 'online' ? '' : `relay ${status.relay.state}${status.relay.error ? `: ${status.relay.error}` : ''}`
    } catch (err) {
      lastError = err instanceof NotRunningError ? 'the server is not running' : String(err)
    }
    if (Date.now() > until) {
      throw new InstallError(`The service is installed, but ${desktop.name} did not connect within ${ONLINE_TIMEOUT_MS / 1000} s${lastError ? ` (${lastError})` : ''}. See: ${path.join(paths.binDir, 'devtool-server')} logs`)
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  const cli = linked ? 'devtool-server' : path.join(paths.binDir, 'devtool-server')
  io.out('')
  io.out(`Connected to ${desktop.name}. DevTool shows "${name}" online.`)
  io.out(`Manage it with: ${cli} status`)
}

/**
 * The install token: `DEVTOOL_TOKEN`, which this removes from `env` so nothing the
 * bootstrap starts (tar, systemctl, the server) inherits it, or `--token`.
 */
export function takeToken(args: BootstrapArgs, env: NodeJS.ProcessEnv = process.env, warn: (line: string) => void = (line) => process.stderr.write(`${line}\n`)): BootstrapArgs {
  const fromEnv = env.DEVTOOL_TOKEN?.trim()
  delete env.DEVTOOL_TOKEN
  if (args.token) {
    warn('warning: --token is visible to other users of this machine (ps); pass the token as DEVTOOL_TOKEN instead.')
    return args
  }
  return fromEnv ? { ...args, token: fromEnv } : args
}

async function main(): Promise<void> {
  let args: BootstrapArgs
  try {
    args = takeToken(parseBootstrapArgs(process.argv.slice(2)))
  } catch (err) {
    process.stderr.write(`devtool-server install: ${err instanceof Error ? err.message : String(err)}\n`)
    process.exit(2)
  }
  try {
    await runBootstrap(args)
    process.exit(0)
  } catch (err) {
    const paths = serverPaths()
    const code = (err as NodeJS.ErrnoException).code
    const message = err instanceof InstallError
      ? err.message
      : code === 'ENOSPC' ? `The disk is full (${paths.home})`
        : code === 'EACCES' ? `Permission denied: ${(err as NodeJS.ErrnoException).path ?? ''}`
          : `Unexpected error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`
    process.stderr.write(`devtool-server install: ${message}\n`)
    if (!(err instanceof InstallError)) process.stderr.write(`Details: ${path.join(paths.logsDir, 'install.log')}\n`)
    process.exit(err instanceof InstallError ? err.exitCode : 1)
  }
}

if (process.argv[1] && /bootstrap\.m?[jt]s$/.test(process.argv[1]) && process.env.DEVTOOL_BOOTSTRAP_NO_MAIN !== '1') {
  void main()
}
