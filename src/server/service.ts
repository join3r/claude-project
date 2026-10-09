import { execFile, spawn } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { atomicWriteFileSync } from '../main/atomic-write'
import type { ServerPaths } from './server-env'

/**
 * Keeping the server running (plan: Install › Service):
 *
 * - Linux with a user systemd: `~/.config/systemd/user/devtool-server.service`,
 *   `Restart=always`, enabled, plus `loginctl enable-linger` so it runs without a
 *   login session and starts at boot. Logs go to journald.
 * - Linux without one (containers, minimal images): started detached, plus an
 *   `@reboot` crontab line. The server writes `logs/server.log` itself.
 * - macOS: the LaunchAgent `sk.awantech.devtool-server`, loaded into `gui/<uid>`
 *   and, when there is no GUI session (installed over SSH with nobody logged in),
 *   into `user/<uid>`. `KeepAlive` restarts it after a failed exit.
 *
 * `DEVTOOL_SERVER_SERVICE_SUFFIX` (e.g. `.dev`) gives a test install its own unit
 * name and label, so tests never touch a real install; `DEVTOOL_SERVER_HOME` its
 * own files. `<home>/service.json` remembers what was installed, for the CLI.
 */

export type ServiceKind = 'systemd' | 'launchd' | 'nohup'

/** What `<home>/service.json` holds. */
export interface ServiceRecord {
  kind: ServiceKind
  /** The systemd unit, the launchd label, or the crontab marker. */
  name: string
  /** The unit or plist file; null for nohup. */
  file: string | null
  /** launchd: the domain it was loaded into (`gui/501` or `user/501`). */
  domain?: string
  suffix: string
  installedAt: string
}

export interface CommandResult {
  code: number
  stdout: string
  stderr: string
}

export type CommandRunner = (command: string, args: string[], options?: { input?: string; timeoutMs?: number }) => Promise<CommandResult>

/** Runs a command and never throws: a missing binary is code 127. */
export const runCommand: CommandRunner = (command, args, options = {}) => new Promise((resolve) => {
  const child = execFile(command, args, { timeout: options.timeoutMs ?? 30_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
    // `code` is the exit status, or a string such as ENOENT when it never ran.
    const raw = (error as { code?: unknown } | null)?.code
    const code = !error ? 0 : typeof raw === 'number' ? raw : raw === 'ENOENT' ? 127 : 1
    const ran = !error || typeof raw === 'number'
    resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') || (ran ? '' : (error?.message ?? '')) })
  })
  child.on('error', () => {})
  if (options.input !== undefined) child.stdin?.end(options.input)
})

export interface ServiceContext {
  paths: ServerPaths
  /** `DEVTOOL_SERVER_SERVICE_SUFFIX`, sanitized. */
  suffix: string
  platform: NodeJS.Platform
  uid: number
  user: string
  /** The user's home directory (the service's working directory). */
  userHome: string
  run: CommandRunner
  log: (message: string) => void
}

export function serviceContext(paths: ServerPaths, log: (message: string) => void = () => {}, env: NodeJS.ProcessEnv = process.env): ServiceContext {
  const info = os.userInfo()
  return {
    paths,
    suffix: serviceSuffix(env),
    platform: process.platform,
    uid: info.uid,
    user: info.username,
    userHome: os.homedir(),
    run: runCommand,
    log
  }
}

/** `DEVTOOL_SERVER_SERVICE_SUFFIX` as `.name`, or empty. */
export function serviceSuffix(env: NodeJS.ProcessEnv = process.env): string {
  const raw = (env.DEVTOOL_SERVER_SERVICE_SUFFIX ?? '').trim().replace(/^[.-]+/, '')
  const clean = raw.replace(/[^A-Za-z0-9.-]/g, '').slice(0, 32)
  return clean ? `.${clean}` : ''
}

export const LAUNCHD_LABEL = 'sk.awantech.devtool-server'

export function launchdLabel(suffix: string): string {
  return `${LAUNCHD_LABEL}${suffix}`
}

export function systemdUnitName(suffix: string): string {
  return `devtool-server${suffix.replace(/\./g, '-')}.service`
}

function nodeBin(paths: ServerPaths): string {
  return path.join(paths.nodeCurrent, 'bin', 'node')
}

function mainJs(paths: ServerPaths): string {
  return path.join(paths.current, 'main.js')
}

/** A systemd unit-file word: double-quoted, with `%` (specifiers), `\` and `"` escaped. */
function systemdQuote(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%')}"`
}

export function renderSystemdUnit(paths: ServerPaths): string {
  return [
    '# Written by the DevTool server installer. `devtool-server uninstall` removes it.',
    '[Unit]',
    'Description=DevTool server',
    'Documentation=https://devtool.awantech.sk',
    'Wants=network-online.target',
    'After=network-online.target',
    // Restart forever: a server that can't reach the relay keeps trying.
    'StartLimitIntervalSec=0',
    '',
    '[Service]',
    'Type=simple',
    `ExecStart=${systemdQuote(nodeBin(paths))} ${systemdQuote(mainJs(paths))}`,
    'WorkingDirectory=~',
    `Environment=${systemdQuote(`DEVTOOL_SERVER_HOME=${paths.home}`)}`,
    'Environment=DEVTOOL_SERVER_SUPERVISOR=systemd',
    'Restart=always',
    'RestartSec=3',
    // 75 is "restart me into an update", not a failure.
    'SuccessExitStatus=75',
    // SIGTERM to the server first, so it saves scrollback and stops its PTYs; the rest after.
    'KillMode=mixed',
    'TimeoutStopSec=20',
    '',
    '[Install]',
    'WantedBy=default.target',
    ''
  ].join('\n')
}

function xml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

export function renderLaunchdPlist(paths: ServerPaths, label: string, userHome: string): string {
  const string = (value: string) => `<string>${xml(value)}</string>`
  const launchdLog = path.join(paths.logsDir, 'launchd.log')
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<!-- Written by the DevTool server installer. `devtool-server uninstall` removes it. -->',
    '<plist version="1.0">',
    '<dict>',
    `  <key>Label</key>${string(label)}`,
    `  <key>ProgramArguments</key><array>${string(nodeBin(paths))}${string(mainJs(paths))}</array>`,
    '  <key>EnvironmentVariables</key>',
    '  <dict>',
    `    <key>DEVTOOL_SERVER_HOME</key>${string(paths.home)}`,
    `    <key>DEVTOOL_SERVER_SUPERVISOR</key>${string('launchd')}`,
    `    <key>DEVTOOL_SERVER_LOG</key>${string('file')}`,
    '  </dict>',
    `  <key>WorkingDirectory</key>${string(userHome)}`,
    '  <key>RunAtLoad</key><true/>',
    // Restart after a crash or an update (exit 75), not after a clean stop.
    '  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>',
    '  <key>ThrottleInterval</key><integer>5</integer>',
    // Only what escapes the server's own log (a crash before it opened it).
    `  <key>StandardOutPath</key>${string(launchdLog)}`,
    `  <key>StandardErrorPath</key>${string(launchdLog)}`,
    '</dict>',
    '</plist>',
    ''
  ].join('\n')
}

/** The marker on our crontab line. */
export function cronMarker(suffix: string): string {
  return `# devtool-server${suffix}`
}

function shQuote(value: string): string {
  return /^[A-Za-z0-9_./=:@%+-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`
}

export function renderCronLine(paths: ServerPaths, suffix: string): string {
  return `@reboot DEVTOOL_SERVER_HOME=${shQuote(paths.home)} ${shQuote(path.join(paths.binDir, 'devtool-server'))} start ${cronMarker(suffix)}`
}

/** The crontab with our line put in (or taken out, with `line` null); other lines are kept as they are. */
export function editCrontab(current: string, suffix: string, line: string | null): string {
  const marker = cronMarker(suffix)
  const kept = current.split('\n').filter((l) => l.trim() !== '' && !l.trimEnd().endsWith(marker))
  if (line) kept.push(line)
  return kept.length ? `${kept.join('\n')}\n` : ''
}

/** `bin/devtool-server`: the CLI, on whatever Node and bundle are current. */
export function renderCliWrapper(paths: ServerPaths): string {
  return [
    '#!/bin/sh',
    '# DevTool server CLI, written by the installer. See: devtool-server help',
    `DEVTOOL_SERVER_HOME="\${DEVTOOL_SERVER_HOME:-${paths.home.replace(/(["\\$`])/g, '\\$1')}}"`,
    'export DEVTOOL_SERVER_HOME',
    'exec "$DEVTOOL_SERVER_HOME/node/current/bin/node" "$DEVTOOL_SERVER_HOME/current/main.js" "$@"',
    ''
  ].join('\n')
}

// ---- service.json -------------------------------------------------------------------------

export function serviceRecordFile(paths: ServerPaths): string {
  return path.join(paths.home, 'service.json')
}

export function readServiceRecord(paths: ServerPaths): ServiceRecord | null {
  try {
    const raw = JSON.parse(fs.readFileSync(serviceRecordFile(paths), 'utf8')) as Partial<ServiceRecord>
    if (raw.kind !== 'systemd' && raw.kind !== 'launchd' && raw.kind !== 'nohup') return null
    if (typeof raw.name !== 'string') return null
    return { kind: raw.kind, name: raw.name, file: typeof raw.file === 'string' ? raw.file : null, ...(typeof raw.domain === 'string' ? { domain: raw.domain } : {}), suffix: typeof raw.suffix === 'string' ? raw.suffix : '', installedAt: typeof raw.installedAt === 'string' ? raw.installedAt : '' }
  } catch {
    return null
  }
}

function writeServiceRecord(paths: ServerPaths, record: ServiceRecord): void {
  atomicWriteFileSync(serviceRecordFile(paths), JSON.stringify(record, null, 2) + '\n', 0o600)
}

// ---- install ------------------------------------------------------------------------------

export interface InstallResult {
  record: ServiceRecord
  /** Things the user should know or do (the linger sudo line). */
  notes: string[]
}

/** Writes the CLI wrapper. */
export function writeCliWrapper(paths: ServerPaths): string {
  fs.mkdirSync(paths.binDir, { recursive: true, mode: 0o755 })
  const file = path.join(paths.binDir, 'devtool-server')
  atomicWriteFileSync(file, renderCliWrapper(paths), 0o755)
  fs.chmodSync(file, 0o755)
  return file
}

/** True when `systemctl --user` reaches a user manager (it can take a moment after boot). */
export async function hasUserSystemd(ctx: ServiceContext): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const result = await ctx.run('systemctl', ['--user', 'show-environment'], { timeoutMs: 10_000 })
    if (result.code === 0) return true
    if (result.code === 127) return false
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  return false
}

/** Installs (or reinstalls) the service for this platform and starts it. */
export async function installService(ctx: ServiceContext): Promise<InstallResult> {
  writeCliWrapper(ctx.paths)
  fs.mkdirSync(ctx.paths.logsDir, { recursive: true, mode: 0o700 })
  const previous = readServiceRecord(ctx.paths)
  let result: InstallResult
  if (ctx.platform === 'darwin') result = await installLaunchd(ctx)
  else if (ctx.platform === 'linux' && await hasUserSystemd(ctx)) result = await installSystemd(ctx)
  else result = await installNohup(ctx)
  // A kind that changed (systemd went away, say) leaves nothing of the old one behind.
  if (previous && previous.kind !== result.record.kind) await removeService(ctx, previous, { stop: false }).catch(() => {})
  writeServiceRecord(ctx.paths, result.record)
  return result
}

async function must(ctx: ServiceContext, command: string, args: string[]): Promise<CommandResult> {
  const result = await ctx.run(command, args)
  if (result.code !== 0) throw new Error(`${command} ${args.join(' ')} failed: ${(result.stderr || result.stdout).trim() || `exit ${result.code}`}`)
  return result
}

async function installSystemd(ctx: ServiceContext): Promise<InstallResult> {
  const name = systemdUnitName(ctx.suffix)
  const dir = path.join(ctx.userHome, '.config', 'systemd', 'user')
  const file = path.join(dir, name)
  fs.mkdirSync(dir, { recursive: true })
  atomicWriteFileSync(file, renderSystemdUnit(ctx.paths), 0o644)
  await must(ctx, 'systemctl', ['--user', 'daemon-reload'])
  await must(ctx, 'systemctl', ['--user', 'enable', name])
  await must(ctx, 'systemctl', ['--user', 'restart', name])
  const notes: string[] = []
  const linger = await ctx.run('loginctl', ['show-user', ctx.user, '--property=Linger', '--value'])
  if (linger.stdout.trim() !== 'yes') {
    const enable = await ctx.run('loginctl', ['enable-linger', ctx.user])
    const check = await ctx.run('loginctl', ['show-user', ctx.user, '--property=Linger', '--value'])
    if (enable.code !== 0 || check.stdout.trim() !== 'yes') {
      notes.push(`To keep the server running after you log out and start it at boot, run:\n  sudo loginctl enable-linger ${ctx.user}`)
    }
  }
  ctx.log(`service systemd unit=${name}`)
  return { record: { kind: 'systemd', name, file, suffix: ctx.suffix, installedAt: new Date().toISOString() }, notes }
}

async function installLaunchd(ctx: ServiceContext): Promise<InstallResult> {
  const label = launchdLabel(ctx.suffix)
  const dir = path.join(ctx.userHome, 'Library', 'LaunchAgents')
  const file = path.join(dir, `${label}.plist`)
  fs.mkdirSync(dir, { recursive: true })
  atomicWriteFileSync(file, renderLaunchdPlist(ctx.paths, label, ctx.userHome), 0o644)
  // Whatever was loaded before goes first, in either domain.
  for (const domain of [`gui/${ctx.uid}`, `user/${ctx.uid}`]) await ctx.run('launchctl', ['bootout', `${domain}/${label}`])
  const notes: string[] = []
  let domain = `gui/${ctx.uid}`
  let loaded = await ctx.run('launchctl', ['bootstrap', domain, file])
  if (loaded.code !== 0) {
    // No GUI session (installed over SSH with nobody logged in on the Mac).
    ctx.log(`service launchd ${domain} refused: ${(loaded.stderr || loaded.stdout).trim()}`)
    domain = `user/${ctx.uid}`
    loaded = await ctx.run('launchctl', ['bootstrap', domain, file])
    if (loaded.code !== 0) throw new Error(`launchctl bootstrap failed: ${(loaded.stderr || loaded.stdout).trim()}`)
    notes.push('Nobody is logged in on this Mac\'s screen, so the server runs in the background user session. It starts again when you next log in.')
  }
  ctx.log(`service launchd label=${label} domain=${domain}`)
  return { record: { kind: 'launchd', name: label, file, domain, suffix: ctx.suffix, installedAt: new Date().toISOString() }, notes }
}

async function installNohup(ctx: ServiceContext): Promise<InstallResult> {
  const name = cronMarker(ctx.suffix).slice(2)
  const notes: string[] = ['This system has no user systemd, so the server runs in the background without a service manager.']
  const current = await ctx.run('crontab', ['-l'])
  if (current.code === 127) {
    notes.push('There is no crontab here, so the server won\'t start by itself after a reboot. Start it with: devtool-server start')
  } else {
    const next = editCrontab(current.code === 0 ? current.stdout : '', ctx.suffix, renderCronLine(ctx.paths, ctx.suffix))
    const written = await ctx.run('crontab', ['-'], { input: next })
    if (written.code !== 0) notes.push(`Could not add the @reboot line to your crontab (${(written.stderr || written.stdout).trim()}). Start the server after a reboot with: devtool-server start`)
  }
  const record: ServiceRecord = { kind: 'nohup', name, file: null, suffix: ctx.suffix, installedAt: new Date().toISOString() }
  await stopNohup(ctx)
  startNohup(ctx.paths)
  ctx.log(`service nohup${current.code === 127 ? ' (no crontab)' : ''}`)
  return { record, notes }
}

// ---- running ------------------------------------------------------------------------------

export function pidFile(paths: ServerPaths): string {
  return path.join(paths.runDir, 'server.pid')
}

export function readPid(paths: ServerPaths): number | null {
  try {
    const pid = Number(fs.readFileSync(pidFile(paths), 'utf8').trim())
    if (!Number.isInteger(pid) || pid <= 0) return null
    process.kill(pid, 0)
    return pid
  } catch {
    return null
  }
}

/** The nohup fallback's start: the daemon, detached, with its own log file. */
export function startNohup(paths: ServerPaths): void {
  fs.mkdirSync(paths.logsDir, { recursive: true, mode: 0o700 })
  const out = fs.openSync(path.join(paths.logsDir, 'stdio.log'), 'a', 0o600)
  const child = spawn(nodeBin(paths), [mainJs(paths)], {
    detached: true,
    stdio: ['ignore', out, out],
    cwd: os.homedir(),
    env: { ...process.env, DEVTOOL_SERVER_HOME: paths.home, DEVTOOL_SERVER_SUPERVISOR: 'nohup', DEVTOOL_SERVER_LOG: 'file' }
  })
  child.on('error', () => {})
  child.unref()
  fs.closeSync(out)
}

async function stopNohup(ctx: ServiceContext, waitMs = 15_000): Promise<void> {
  const pid = readPid(ctx.paths)
  if (!pid) return
  try {
    process.kill(pid, 'SIGTERM')
  } catch {
    return
  }
  const until = Date.now() + waitMs
  while (Date.now() < until) {
    try {
      process.kill(pid, 0)
    } catch {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  try {
    process.kill(pid, 'SIGKILL')
  } catch {
    // Gone.
  }
}

export interface ServiceState {
  running: boolean
  pid: number | null
  /** One line for `devtool-server status`. */
  detail: string
}

export async function serviceState(ctx: ServiceContext, record: ServiceRecord | null): Promise<ServiceState> {
  const pid = readPid(ctx.paths)
  if (!record) return { running: pid !== null, pid, detail: 'no service installed' }
  switch (record.kind) {
    case 'systemd': {
      const result = await ctx.run('systemctl', ['--user', 'is-active', record.name])
      return { running: result.stdout.trim() === 'active', pid, detail: `systemd user unit ${record.name}: ${result.stdout.trim() || 'unknown'}` }
    }
    case 'launchd': {
      const result = await ctx.run('launchctl', ['print', `${record.domain ?? `gui/${ctx.uid}`}/${record.name}`])
      const state = /\n\s*state = ([^\n]+)/.exec(result.stdout)?.[1]?.trim() ?? (result.code === 0 ? 'loaded' : 'not loaded')
      return { running: state === 'running', pid, detail: `LaunchAgent ${record.name} in ${record.domain ?? '?'}: ${state}` }
    }
    case 'nohup':
      return { running: pid !== null, pid, detail: `background process (no service manager)${pid ? `, pid ${pid}` : ''}` }
  }
}

export async function startService(ctx: ServiceContext, record: ServiceRecord): Promise<void> {
  switch (record.kind) {
    case 'systemd':
      await must(ctx, 'systemctl', ['--user', 'start', record.name])
      return
    case 'launchd': {
      const target = `${record.domain ?? `gui/${ctx.uid}`}/${record.name}`
      const kick = await ctx.run('launchctl', ['kickstart', target])
      if (kick.code !== 0 && record.file) await must(ctx, 'launchctl', ['bootstrap', record.domain ?? `gui/${ctx.uid}`, record.file])
      return
    }
    case 'nohup':
      if (!readPid(ctx.paths)) startNohup(ctx.paths)
  }
}

/** Stops it; a staged update is switched to on the way out (the daemon does that on SIGTERM). */
export async function stopService(ctx: ServiceContext, record: ServiceRecord): Promise<void> {
  switch (record.kind) {
    case 'systemd':
      await must(ctx, 'systemctl', ['--user', 'stop', record.name])
      return
    case 'launchd':
      // SIGTERM: a clean exit, which KeepAlive leaves alone.
      await ctx.run('launchctl', ['kill', 'SIGTERM', `${record.domain ?? `gui/${ctx.uid}`}/${record.name}`])
      return
    case 'nohup':
      await stopNohup(ctx)
  }
}

export async function restartService(ctx: ServiceContext, record: ServiceRecord): Promise<void> {
  switch (record.kind) {
    case 'systemd':
      await must(ctx, 'systemctl', ['--user', 'restart', record.name])
      return
    case 'launchd':
      await must(ctx, 'launchctl', ['kickstart', '-k', `${record.domain ?? `gui/${ctx.uid}`}/${record.name}`])
      return
    case 'nohup':
      await stopNohup(ctx)
      startNohup(ctx.paths)
  }
}

/**
 * Takes the service out: disabled and its file removed. With `stop`, it also stops
 * it and waits; the daemon uninstalling itself passes `stop: false` and then calls
 * {@link stopSelf}.
 */
export async function removeService(ctx: ServiceContext, record: ServiceRecord, { stop }: { stop: boolean }): Promise<void> {
  switch (record.kind) {
    case 'systemd':
      await ctx.run('systemctl', ['--user', 'disable', ...(stop ? ['--now'] : []), record.name])
      if (record.file) fs.rmSync(record.file, { force: true })
      await ctx.run('systemctl', ['--user', 'daemon-reload'])
      break
    case 'launchd':
      if (record.file) fs.rmSync(record.file, { force: true })
      if (stop) {
        for (const domain of [record.domain ?? `gui/${ctx.uid}`]) await ctx.run('launchctl', ['bootout', `${domain}/${record.name}`])
      }
      break
    case 'nohup': {
      const current = await ctx.run('crontab', ['-l'])
      if (current.code === 0) {
        const next = editCrontab(current.stdout, record.suffix, null)
        if (next.trim()) await ctx.run('crontab', ['-'], { input: next })
        else await ctx.run('crontab', ['-r'])
      }
      if (stop) await stopNohup(ctx)
      break
    }
  }
  fs.rmSync(serviceRecordFile(ctx.paths), { force: true })
}

/**
 * The daemon, uninstalling itself, asks its service manager to stop it (so it
 * isn't restarted). Detached, since the service manager kills the caller's process
 * group. Under nohup there is nothing to ask: the caller just exits.
 */
export function stopSelf(ctx: ServiceContext, record: ServiceRecord | null): void {
  if (!record || record.kind === 'nohup') return
  const [command, args] = record.kind === 'systemd'
    ? ['systemctl', ['--user', 'stop', '--no-block', record.name]]
    : ['launchctl', ['bootout', `${record.domain ?? `gui/${ctx.uid}`}/${record.name}`]]
  const child = spawn(command as string, args as string[], { detached: true, stdio: 'ignore' })
  child.on('error', () => {})
  child.unref()
}

/**
 * `~/.local/bin/devtool-server` → `<home>/bin/devtool-server`, when `~/.local/bin`
 * is on PATH and nothing else of that name is there. Only for the default home, so
 * a test install never takes it over. Returns the link, or null.
 */
export function linkCliOnPath(paths: ServerPaths, userHome: string, envPath: string = process.env.PATH ?? '', isDefaultHome: boolean): string | null {
  if (!isDefaultHome) return null
  const dir = path.join(userHome, '.local', 'bin')
  if (!envPath.split(':').some((entry) => path.resolve(entry) === dir)) return null
  const link = path.join(dir, 'devtool-server')
  const target = path.join(paths.binDir, 'devtool-server')
  try {
    const existing = fs.readlinkSync(link)
    if (path.resolve(dir, existing) === target) return link
    return null
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EINVAL') return null
  }
  try {
    fs.mkdirSync(dir, { recursive: true })
    fs.symlinkSync(target, link)
    return link
  } catch {
    return null
  }
}

/** Removes the `~/.local/bin` link if it is ours. */
export function unlinkCliOnPath(paths: ServerPaths, userHome: string): void {
  const link = path.join(userHome, '.local', 'bin', 'devtool-server')
  try {
    if (path.resolve(path.dirname(link), fs.readlinkSync(link)) === path.join(paths.binDir, 'devtool-server')) fs.rmSync(link)
  } catch {
    // Not there, or not ours.
  }
}
