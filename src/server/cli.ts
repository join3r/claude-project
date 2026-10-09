import { spawn } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import readline from 'readline'
import { renderTerminalQr } from './qr-terminal'
import { NotRunningError, UnsafeControlSocketError, controlRequest } from './control'
import type { ServerUpdateState } from '../main/host/link/link-channels'
import { loadServerManifest, serverPaths, type ServerPaths } from './server-env'
import {
  readServiceRecord,
  removeService,
  restartService,
  serviceContext,
  serviceState,
  startService,
  unlinkCliOnPath,
  type ServiceContext,
  type ServiceRecord
} from './service'

/**
 * `devtool-server <command>` (`<home>/bin/devtool-server`, a sh wrapper around
 * `node current/main.js`). Commands that need the running server (status, pair,
 * unpair) talk to it over its control socket; the others drive the service
 * manager. No node-pty here: the CLI works even when the bundle can't load it.
 */

export const CLI_USAGE = `usage: devtool-server <command>

  status              Is it running, what version, which desktops, the relay
  logs [-f] [-n N]    The server's log (-f follows it)
  pair [--no-wait]    A pairing code for another desktop (DevTool: Add server, I have a code)
  pair --phone [--no-wait]
                      A pairing link and QR code for a phone, then Accept here
  unpair <id|name>    Remove a paired desktop or phone
  restart             Restart the server (switches to a staged update)
  start               Start it if it isn't running
  update              How updates work
  uninstall [--keep-data | --delete-data] [--yes]
                      Stop and remove the service and the server
  version             The installed version`

export type CliCommand =
  | { cmd: 'status' }
  | { cmd: 'logs'; follow: boolean; lines: number }
  | { cmd: 'pair'; wait: boolean; phone?: true }
  | { cmd: 'unpair'; target: string }
  | { cmd: 'restart' }
  | { cmd: 'start' }
  | { cmd: 'update' }
  | { cmd: 'uninstall'; data: 'keep' | 'delete' | 'ask'; yes: boolean }
  | { cmd: 'version' }
  | { cmd: 'help' }

export const CLI_COMMANDS = ['status', 'logs', 'pair', 'unpair', 'restart', 'start', 'update', 'uninstall', 'version', 'help'] as const

/** Parses the CLI's arguments; throws an Error with a readable message. */
export function parseCliArgs(argv: string[]): CliCommand {
  const [cmd, ...rest] = argv
  const noArgs = (command: CliCommand): CliCommand => {
    if (rest.length) throw new Error(`${cmd} takes no arguments`)
    return command
  }
  switch (cmd) {
    case 'status': return noArgs({ cmd: 'status' })
    case 'restart': return noArgs({ cmd: 'restart' })
    case 'start': return noArgs({ cmd: 'start' })
    case 'update': return noArgs({ cmd: 'update' })
    case 'version': return noArgs({ cmd: 'version' })
    case 'help': case '--help': case '-h': return { cmd: 'help' }
    case 'logs': {
      let follow = false
      let lines = 200
      for (let i = 0; i < rest.length; i++) {
        const arg = rest[i]
        if (arg === '-f' || arg === '--follow') follow = true
        else if (arg === '-n' || arg === '--lines') {
          const n = Number(rest[++i])
          if (!Number.isInteger(n) || n < 0) throw new Error(`${arg} needs a number`)
          lines = n
        } else throw new Error(`unknown option for logs: ${arg}`)
      }
      return { cmd: 'logs', follow, lines }
    }
    case 'pair': {
      if (rest.some((arg) => arg !== '--no-wait' && arg !== '--phone')) throw new Error('pair takes only --phone and --no-wait')
      return { cmd: 'pair', wait: !rest.includes('--no-wait'), ...(rest.includes('--phone') ? { phone: true as const } : {}) }
    }
    case 'unpair': {
      if (rest.length !== 1 || rest[0].startsWith('-')) throw new Error('usage: devtool-server unpair <desktop or phone id or name>')
      return { cmd: 'unpair', target: rest[0] }
    }
    case 'uninstall': {
      let data: 'keep' | 'delete' | 'ask' = 'ask'
      let yes = false
      for (const arg of rest) {
        if (arg === '--keep-data') data = data === 'delete' ? fail('--keep-data and --delete-data') : 'keep'
        else if (arg === '--delete-data') data = data === 'keep' ? fail('--keep-data and --delete-data') : 'delete'
        else if (arg === '--yes' || arg === '-y') yes = true
        else throw new Error(`unknown option for uninstall: ${arg}`)
      }
      return { cmd: 'uninstall', data, yes }
    }
    case undefined: throw new Error(CLI_USAGE)
    default: throw new Error(`unknown command: ${cmd}\n${CLI_USAGE}`)
  }
}

function fail(what: string): never {
  throw new Error(`choose one of ${what}`)
}

/** What a running server reports (`status` over the control socket). */
export interface DaemonStatus {
  pid: number
  serverId: string
  name: string
  version: string
  commit: string
  builtAt: string
  node: string
  home: string
  supervisor: string
  relay: { url: string; state: string; error?: string }
  desktops: { id: string; name: string; online: boolean; pairedAt: number; lastSeen: number | null; version?: string }[]
  phones: { id: string; name: string; online?: boolean; lastSeen?: number | null }[]
  update: ServerUpdateState | null
}

/** What a pairing code request answers. */
export interface CodeAnswer {
  code: string
  exp: number
  state: 'waiting' | 'paired' | 'expired' | 'cancelled'
  desktop?: { id: string; name: string }
}

export interface CliIo {
  out: (line: string) => void
  err: (line: string) => void
  /** Asks a yes/no question; null when there is no terminal to ask on. */
  confirm: (question: string) => Promise<boolean | null>
  /** A QR code of `text` drawn for this terminal; null when output isn't a terminal. */
  qr?: (text: string) => Promise<string | null>
  /** Milliseconds between polls of the daemon while waiting (tests make it short). */
  pollMs?: number
}

const defaultIo: CliIo = {
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
  qr: async (text) => {
    if (!process.stdout.isTTY) return null
    try {
      return renderTerminalQr(text)
    } catch {
      return null
    }
  },
  confirm: async (question) => {
    if (!process.stdin.isTTY) return null
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    const answer = await new Promise<string>((resolve) => rl.question(`${question} [y/N] `, resolve))
    rl.close()
    return /^y(es)?$/i.test(answer.trim())
  }
}

function ago(ms: number | null): string {
  if (!ms) return 'never'
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000))
  if (s < 90) return `${s} s ago`
  if (s < 5400) return `${Math.round(s / 60)} min ago`
  if (s < 172_800) return `${Math.round(s / 3600)} h ago`
  return `${Math.round(s / 86_400)} days ago`
}

/** Runs one CLI command; resolves to the exit code. */
export async function runCli(argv: string[], options: { bundleDir: string; io?: CliIo; paths?: ServerPaths; ctx?: ServiceContext } = { bundleDir: '.' }): Promise<number> {
  const io = options.io ?? defaultIo
  let command: CliCommand
  try {
    command = parseCliArgs(argv)
  } catch (err) {
    io.err(err instanceof Error ? err.message : String(err))
    return 2
  }
  const paths = options.paths ?? serverPaths()
  const ctx = options.ctx ?? serviceContext(paths)
  const record = readServiceRecord(paths)
  try {
    switch (command.cmd) {
      case 'help':
        io.out(CLI_USAGE)
        return 0
      case 'version': {
        const manifest = loadServerManifest(options.bundleDir)
        io.out(`devtool-server ${manifest.version} (commit ${manifest.commit.slice(0, 12)}, built ${manifest.builtAt || 'unknown'}) on Node ${process.versions.node}`)
        return 0
      }
      case 'update': {
        const manifest = loadServerManifest(options.bundleDir)
        io.out(`This server runs ${manifest.version} (commit ${manifest.commit.slice(0, 12)}).`)
        io.out('Updates come from DevTool: when a desktop with a newer build connects, it sends its server and this one switches once no tab is working.')
        return 0
      }
      case 'status':
        return await status(io, paths, ctx, record)
      case 'logs':
        return await logs(io, paths, record, command.follow, command.lines)
      case 'pair':
        return command.phone ? await pairPhone(io, paths, command.wait) : await pair(io, paths, command.wait)
      case 'unpair':
        return await unpair(io, paths, command.target)
      case 'restart':
        if (!record) {
          io.err('No service is installed. Run the installer again.')
          return 1
        }
        await restartService(ctx, record)
        io.out('Restarted.')
        return 0
      case 'start':
        if (!record) {
          io.err('No service is installed. Run the installer again.')
          return 1
        }
        await startService(ctx, record)
        return 0
      case 'uninstall':
        return await uninstall(io, paths, ctx, record, command.data, command.yes)
    }
  } catch (err) {
    io.err(err instanceof NotRunningError ? 'The DevTool server is not running. Start it with: devtool-server start'
      : err instanceof UnsafeControlSocketError ? `Refusing to talk to the server: ${err.message}`
        : err instanceof Error ? err.message : String(err))
    return 1
  }
}

async function status(io: CliIo, paths: ServerPaths, ctx: ServiceContext, record: ServiceRecord | null): Promise<number> {
  const service = await serviceState(ctx, record)
  let daemon: DaemonStatus | null = null
  try {
    daemon = await controlRequest(paths, { cmd: 'status' }, 10_000) as DaemonStatus
  } catch (err) {
    if (err instanceof UnsafeControlSocketError) throw err
    if (!(err instanceof NotRunningError)) io.err(`(no answer from the server: ${err instanceof Error ? err.message : String(err)})`)
  }
  if (!daemon) {
    io.out('DevTool server: not running')
    io.out(`  service   ${service.detail}`)
    return 3
  }
  const update = daemon.update ? `${daemon.update.version} (${daemon.update.commit.slice(0, 12)}) ${daemon.update.state === 'staged' ? 'staged: switches once no tab is working (or devtool-server restart)' : 'restarting'}` : 'none'
  io.out(`DevTool server "${daemon.name}" (${daemon.serverId})`)
  io.out(`  running   yes, pid ${daemon.pid}; ${service.detail}`)
  io.out(`  version   ${daemon.version} (commit ${daemon.commit.slice(0, 12)}${daemon.builtAt ? `, built ${daemon.builtAt}` : ''}) on Node ${daemon.node}`)
  io.out(`  relay     ${daemon.relay.url}: ${daemon.relay.state}${daemon.relay.error ? ` (${daemon.relay.error})` : ''}`)
  io.out(`  update    ${update}`)
  io.out(`  desktops  ${daemon.desktops.length === 0 ? 'none (pair one with: devtool-server pair)' : daemon.desktops.length}`)
  for (const desktop of daemon.desktops) {
    io.out(`    ${desktop.name.padEnd(20)} ${desktop.id.slice(0, 8)}  ${desktop.online ? 'connected' : `last seen ${ago(desktop.lastSeen)}`}${desktop.version ? `  DevTool ${desktop.version}` : ''}`)
  }
  io.out(`  phones    ${daemon.phones.length === 0 ? 'none (pair one with: devtool-server pair --phone)' : daemon.phones.length}`)
  for (const phone of daemon.phones) {
    io.out(`    ${phone.name.padEnd(20)} ${phone.id.slice(0, 8)}  ${phone.online ? 'connected' : `last seen ${ago(phone.lastSeen ?? null)}`}`)
  }
  io.out(`  home      ${daemon.home}`)
  return 0
}

async function logs(io: CliIo, paths: ServerPaths, record: ServiceRecord | null, follow: boolean, lines: number): Promise<number> {
  const [command, args] = record?.kind === 'systemd'
    ? ['journalctl', ['--user', '-u', record.name, '-n', String(lines), '-o', 'cat', ...(follow ? ['-f'] : [])]]
    : ['tail', ['-n', String(lines), ...(follow ? ['-F'] : []), path.join(paths.logsDir, 'server.log')]]
  if (record?.kind !== 'systemd' && !fs.existsSync(path.join(paths.logsDir, 'server.log'))) {
    io.err(`No log yet in ${paths.logsDir}`)
    return 1
  }
  return new Promise((resolve) => {
    const child = spawn(command as string, args as string[], { stdio: 'inherit' })
    child.on('error', (err) => {
      io.err(`${command}: ${err.message}`)
      resolve(1)
    })
    child.on('exit', (code) => resolve(code ?? 0))
  })
}

async function pair(io: CliIo, paths: ServerPaths, wait: boolean): Promise<number> {
  const answer = await controlRequest(paths, { cmd: 'pair' }) as CodeAnswer
  io.out('In DevTool: Add server, then "I have a code", and paste:')
  io.out('')
  io.out(`  ${answer.code}`)
  io.out('')
  io.out(`The code works once, until ${new Date(answer.exp * 1000).toLocaleTimeString()}.`)
  if (!wait) return 0
  io.out('Waiting for DevTool... (Ctrl-C to stop waiting; the code stays valid)')
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, 1000))
    const state = await controlRequest(paths, { cmd: 'pair-status' }) as CodeAnswer | null
    if (!state || state.code !== answer.code) {
      io.err('Another pairing code replaced this one.')
      return 1
    }
    if (state.state === 'paired') {
      io.out(`Paired with ${state.desktop?.name ?? 'a desktop'} (${state.desktop?.id.slice(0, 8) ?? '?'}).`)
      return 0
    }
    if (state.state === 'expired' || state.state === 'cancelled') {
      io.err(state.state === 'expired' ? 'The code expired. Run devtool-server pair again.' : 'The code was replaced by another offer.')
      return 1
    }
  }
}

async function unpair(io: CliIo, paths: ServerPaths, target: string): Promise<number> {
  const daemon = await controlRequest(paths, { cmd: 'status' }) as DaemonStatus
  const matching = (d: { id: string; name: string }) => d.id === target || d.id.startsWith(target.toLowerCase()) || d.name === target
  const matches = [
    ...daemon.desktops.filter(matching).map((d) => ({ ...d, kind: 'desktop' as const })),
    ...(daemon.phones ?? []).filter(matching).map((p) => ({ ...p, kind: 'phone' as const }))
  ]
  if (matches.length === 0) {
    io.err(`No paired desktop or phone matches "${target}". See: devtool-server status`)
    return 1
  }
  if (matches.length > 1) {
    io.err(`"${target}" matches ${matches.length} devices; use more of the id.`)
    return 1
  }
  const [match] = matches
  await controlRequest(paths, match.kind === 'phone' ? { cmd: 'phone-revoke', id: match.id } : { cmd: 'unpair', id: match.id })
  io.out(`Removed ${match.kind === 'phone' ? 'the phone ' : ''}${match.name} (${match.id.slice(0, 8)}).`)
  return 0
}

/** What the daemon's `phone-*` requests answer: its MobileState, as far as the CLI reads it. */
interface PhoneState {
  invite: { uri: string; exp: number } | null
  pending: { phoneId: string; name: string; online: boolean } | null
  devices: { id: string; name: string }[]
}

/**
 * `pair --phone`: a QR code and link for DevTool on a phone, then the phone's
 * request answered here (or in DevTool, Settings › Servers › Pair a phone).
 */
async function pairPhone(io: CliIo, paths: ServerPaths, wait: boolean): Promise<number> {
  const invite = await controlRequest(paths, { cmd: 'phone-pair' }) as { uri: string; exp: number }
  const qr = await io.qr?.(invite.uri) ?? null
  if (qr) {
    io.out('On your phone: open DevTool, tap Pair, and scan this code.')
    io.out('')
    io.out(qr)
    io.out('Or open this link on the phone:')
  } else {
    io.out('Open this link with DevTool on your phone (or paste it under Paste pairing link):')
  }
  io.out('')
  io.out(`  ${invite.uri}`)
  io.out('')
  io.out(`It works once, until ${new Date(invite.exp * 1000).toLocaleTimeString()}.`)
  if (!wait) {
    io.out('Accept the phone in DevTool: Settings, Servers, this server, Pair a phone.')
    return 0
  }
  io.out('Waiting for the phone... (Ctrl-C to stop waiting; the link stays valid)')
  let asked = null as { phoneId: string; name: string } | null
  let told = false
  const paired = (state: PhoneState, phoneId: string) => state.devices.some((d) => d.id === phoneId)
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, io.pollMs ?? 1000))
    let state = await controlRequest(paths, { cmd: 'phone-state' }) as PhoneState
    if (asked && paired(state, asked.phoneId)) {
      io.out(`Paired with ${asked.name}.`)
      return 0
    }
    const pending = state.pending
    if (pending && pending.phoneId !== asked?.phoneId) {
      asked = { phoneId: pending.phoneId, name: pending.name }
      const answer = await io.confirm(`${pending.name} wants to pair with this server. Accept only if it is your phone and you just scanned the code. Accept?`)
      if (answer === null) {
        if (!told) io.out(`${pending.name} wants to pair. Accept it in DevTool: Settings, Servers, this server.`)
        told = true
        continue
      }
      try {
        state = await controlRequest(paths, { cmd: answer ? 'phone-accept' : 'phone-reject', id: pending.phoneId }) as PhoneState
      } catch (err) {
        // Answered in DevTool meanwhile.
        state = await controlRequest(paths, { cmd: 'phone-state' }) as PhoneState
        if (!paired(state, pending.phoneId)) throw err
      }
      if (!answer) {
        io.out(`Rejected ${pending.name}.`)
        return 1
      }
      if (paired(state, pending.phoneId)) {
        io.out(`Paired with ${pending.name}.`)
        return 0
      }
      continue
    }
    if (pending) continue
    if (asked) {
      io.err(`${asked.name} did not pair: the request was rejected or ran out.`)
      return 1
    }
    if (!state.invite || state.invite.uri !== invite.uri) {
      io.err(invite.exp * 1000 <= Date.now()
        ? 'The link expired. Run devtool-server pair --phone again.'
        : 'Another pairing code replaced this link (only one works at a time).')
      return 1
    }
  }
}

/**
 * Removes the server's files: with `deleteData` the whole home, else everything
 * but `data/` (the identity, the paired desktops and phones, projects and settings).
 */
export function removeServerFiles(paths: ServerPaths, deleteData: boolean): void {
  if (deleteData) {
    fs.rmSync(paths.home, { recursive: true, force: true })
    return
  }
  for (const target of [paths.appDir, paths.nodeDir, paths.current, paths.binDir, paths.logsDir, paths.runDir, path.join(paths.home, 'service.json')]) {
    fs.rmSync(target, { recursive: true, force: true })
  }
}

async function uninstall(io: CliIo, paths: ServerPaths, ctx: ServiceContext, record: ServiceRecord | null, data: 'keep' | 'delete' | 'ask', yes: boolean): Promise<number> {
  let deleteData = data === 'delete'
  if (data === 'ask') {
    const answer = await io.confirm(`Also delete the server's data (paired desktops and phones, projects and settings in ${paths.dataDir})?`)
    deleteData = answer === true
  }
  if (!yes && data !== 'ask') {
    const answer = await io.confirm(`Remove the DevTool server from ${paths.home}${deleteData ? ', data included' : ''}?`)
    if (answer === false) return 1
  }
  if (deleteData) {
    // Its identity goes away, so its pairs are useless: tell the relay (and the desktops) first.
    try {
      const result = await controlRequest(paths, { cmd: 'revoke-all' }, 10_000) as { count?: number; phones?: number }
      if (result?.count) io.out(`Unpaired ${result.count} desktop${result.count === 1 ? '' : 's'}.`)
      if (result?.phones) io.out(`Unpaired ${result.phones} phone${result.phones === 1 ? '' : 's'}.`)
    } catch {
      // Not running: the relay pairs stay until DevTool removes this server.
    }
  }
  if (record) {
    await removeService(ctx, record, { stop: true })
    io.out(`Removed the service (${record.kind}: ${record.name}).`)
  }
  unlinkCliOnPath(paths, os.homedir())
  removeServerFiles(paths, deleteData)
  io.out(deleteData ? `Deleted ${paths.home}.` : `Removed the server; kept its data in ${paths.dataDir}.`)
  return 0
}

