import { createRequire } from 'module'
import os from 'os'
import path from 'path'
import { PtyManager } from '../main/pty-manager'
import { resolveShellEnv } from '../main/shell-env'
import { listCondaEnvs } from '../main/conda-env'
import { acquireInstanceLock } from '../main/instance-lock'
import { installBrokenPipeUncaughtHandler } from '../main/broken-pipe'
import { createServerLink, pairCodeForDesktop, startServerHost, type ServerHost } from './server-host'
import type { LinkCall, ServerLink } from './server-link'
import { BUNDLE_STREAM_KIND, ServerUpdater } from './updater'
import { exitForRestart } from './restart'
import { diagnosticStreamKinds } from '../main/host/link/diagnostic-streams'
import { LinkChannel, LinkEvent } from '../main/host/link/link-channels'
import { consoleError, consoleLog, ensureServerDirs, loadServerManifest, loginShell, passwdShell, serverPaths, logToFile, type ServerPaths } from './server-env'
import { ControlServer, type ControlRequest } from './control'
import { currentSupervisor } from './restart'
import { pidFile, readServiceRecord, removeService, serviceContext, stopSelf, unlinkCliOnPath } from './service'
import { removeServerFiles, type DaemonStatus } from './cli'
import fs from 'fs'
import { loadServerConfig, saveServerConfig, serverDisplayName } from './server-config'

/**
 * The server bundle's second entry (`server.js`), loaded by the launcher
 * (`main.js`) once it has checked the arguments and the Node version. Everything
 * that loads node-pty lives on this side, so a missing prebuild is reported by
 * the launcher rather than crashing it.
 */

export interface RunOptions {
  /** The bundle's dir: manifest.json and the resources. */
  bundleDir: string
}

export interface DaemonOptions extends RunOptions {
  /** Saved to server.json before the link starts. */
  relayUrl?: string
}

const SHUTDOWN_TIMEOUT_MS = 10_000

function describe(err: unknown): string {
  return err instanceof Error ? (err.stack ?? err.message) : String(err)
}

/**
 * The service: the host started on the server's data dir, until SIGTERM or SIGINT
 * stops it the way quitting the desktop does. Resolves once it is up; the hook
 * server and the instance lock keep the process alive from then on.
 */
export async function runDaemon({ bundleDir, relayUrl }: DaemonOptions): Promise<void> {
  const log = consoleLog
  // As in Electron's main: an exception escaping a callback is logged, and the
  // terminals and chats running in this process live on.
  installBrokenPipeUncaughtHandler(process, (err) => consoleError(`uncaughtException ${describe(err)}`))
  process.on('unhandledRejection', (reason) => consoleError(`unhandledRejection ${describe(reason)}`))

  const paths = serverPaths()
  // launchd and the nohup fallback keep no log of their own.
  if (process.env.DEVTOOL_SERVER_LOG === 'file') logToFile(path.join(paths.logsDir, 'server.log'))
  const manifest = loadServerManifest(bundleDir)
  log(`starting devtool-server ${manifest.version} (${manifest.commit}) node=${process.version} pid=${process.pid}`)

  ensureServerDirs(paths)
  const lock = await acquireInstanceLock(paths.dataDir, () => log('another devtool-server tried to start on this data dir'))
  if (!lock.acquired) {
    consoleError(`devtool-server is already running on ${paths.dataDir}${lock.ownerPid ? ` (pid ${lock.ownerPid})` : ''}`)
    // launchd may load the agent into both the gui and the user domain; a clean exit
    // keeps the second copy from being started again and again.
    process.exitCode = currentSupervisor() === 'launchd' ? 0 : 1
    return
  }
  // A bundle an earlier run staged but never switched to (it was killed): switch now, before anything runs.
  const leftover = new ServerUpdater({ paths, running: manifest.sha256 && manifest.sha256 !== 'dev' ? manifest : null, mode: 'daemon', log })
  if (leftover.applyLeftoverStaged()) {
    lock.release()
    exitForRestart(paths, log)
  }

  // Terminals, `!bash` and the login env all follow $SHELL; cron's /bin/sh would
  // make every one of them a bare sh without the user's PATH.
  const shell = loginShell(process.env.SHELL, passwdShell())
  if (shell) process.env.SHELL = shell
  await resolveShellEnv()
  log(`loginShell shell=${process.env.SHELL ?? ''} path=${process.env.PATH ?? ''}`)
  // Warm the conda env list so the first PTY can resolve a saved name without waiting.
  void listCondaEnvs().catch(() => {})

  let server: ServerHost
  try {
    server = await startServerHost({ paths, manifest, bundleDir, log })
  } catch (err) {
    // Whatever did start (the hook server) would keep the process up.
    consoleError(`devtool-server failed to start: ${describe(err)}`)
    lock.release()
    process.exit(1)
  }
  if (relayUrl) saveServerConfig(paths.dataDir, { relayUrl })

  let link: ServerLink | null = null
  let stopping = false
  /** After an uninstall the service manager's SIGTERM ends the process at once. */
  let exitOnSignal = false
  const updater = new ServerUpdater({
    paths,
    running: manifest.sha256 && manifest.sha256 !== 'dev' ? manifest : null,
    mode: 'daemon',
    log,
    isIdle: () => server.host.isIdle(),
    onIdleChange: (listener) => server.host.onActivityChange(listener),
    restart: (reason) => stop(reason, true),
    onStatus: (info) => link?.broadcast(LinkEvent.Status, [info])
  })
  const uninstall = (deleteData: boolean, why: string): void => {
    log(`uninstall ${why} deleteData=${deleteData}`)
    const removeEverything = async () => {
      const ctx = serviceContext(paths, log)
      const record = readServiceRecord(paths)
      if (record) await removeService(ctx, record, { stop: false })
      unlinkCliOnPath(paths, os.homedir())
      removeServerFiles(paths, deleteData)
      exitOnSignal = true
      stopSelf(ctx, record)
    }
    // After the caller's answer is out: unpairing drops its session.
    setTimeout(() => {
      // Its identity goes with the data, so the pairs are useless: unpair while the relay still hears it.
      if (deleteData) {
        for (const desktop of link?.desktops.list() ?? []) link?.unpair(desktop.id)
        server.host.revokeAllPhones()
      }
      setTimeout(() => stop(`uninstall (${why})`, false, removeEverything), 300)
    }, 300)
  }
  link = createServerLink(server, {
    streams: new Map([...diagnosticStreamKinds(), [BUNDLE_STREAM_KIND, updater.streamHandler()]]),
    linkCall: (call) => daemonLinkCall(call, { link: link!, updater, uninstall })
  })
  link.start()
  const control = new ControlServer(paths, (request) => controlCommand(request, { link: link!, updater, server, paths, manifest }), log)
  try {
    await control.start()
  } catch (err) {
    consoleError(`control socket failed: ${describe(err)}; the CLI can't reach this server`)
  }
  fs.mkdirSync(paths.runDir, { recursive: true, mode: 0o700 })
  fs.writeFileSync(pidFile(paths), `${process.pid}\n`, { mode: 0o600 })
  log(`ready version=${manifest.version} commit=${manifest.commit} data=${paths.dataDir} supervisor=${currentSupervisor()}`)
  log(`link server=${server.host.identity.get().id} relay=${loadServerConfig(paths.dataDir).relayUrl} desktops=${link.desktops.list().length}`)

  /** Stops like quitting the desktop; a staged update is switched to on the way out. */
  const stop = (why: string, restart = false, after?: () => Promise<void>): void => {
    if (stopping) return
    stopping = true
    control.close()
    log(`stopping ${why}`)
    const timer = setTimeout(() => {
      consoleError(`shutdown took over ${SHUTDOWN_TIMEOUT_MS} ms; exiting anyway`)
      lock.release()
      process.exit(1)
    }, SHUTDOWN_TIMEOUT_MS)
    timer.unref()
    link?.stop()
    server.shutdown()
      .catch((err: unknown) => consoleError(`shutdown error ${describe(err)}`))
      .finally(async () => {
        if (!after) {
          try {
            updater.applyStaged()
          } catch (err) {
            consoleError(`could not switch to the staged update: ${describe(err)}`)
          }
        }
        fs.rmSync(pidFile(paths), { force: true })
        lock.release()
        log('stopped')
        if (after) {
          try {
            await after()
          } catch (err) {
            consoleError(`uninstall failed: ${describe(err)}`)
          }
          // systemd and launchd stop us now; under nohup nothing will.
          if (currentSupervisor() === 'systemd' || currentSupervisor() === 'launchd') {
            setTimeout(() => process.exit(0), 10_000).unref()
            return
          }
        }
        if (restart) exitForRestart(paths, log)
        process.exit(0)
      })
  }
  const onSignal = (signal: string) => {
    if (exitOnSignal) process.exit(0)
    stop(`signal=${signal}`)
  }
  // Not SIGHUP: under nohup (the fallback service) it is ignored, and a handler would undo that.
  process.on('SIGTERM', () => onSignal('SIGTERM'))
  process.on('SIGINT', () => onSignal('SIGINT'))
}

interface DaemonParts {
  link: ServerLink
  updater: ServerUpdater
  server: ServerHost
  paths: ServerPaths
  manifest: ReturnType<typeof loadServerManifest>
}

/** The CLI's requests over the control socket. */
async function controlCommand(request: ControlRequest, { link, updater, server, paths, manifest }: DaemonParts): Promise<unknown> {
  switch (request.cmd) {
    case 'status': {
      const relay = link.relayState()
      const connected = new Set(link.connectedDesktops())
      const status: DaemonStatus = {
        pid: process.pid,
        serverId: server.host.identity.get().id,
        name: serverDisplayName(loadServerConfig(paths.dataDir)),
        version: manifest.version,
        commit: manifest.commit,
        builtAt: manifest.builtAt,
        node: process.versions.node,
        home: paths.home,
        supervisor: currentSupervisor(),
        relay: { url: loadServerConfig(paths.dataDir).relayUrl, state: relay.kind, ...(relay.kind === 'offline' && relay.error ? { error: relay.error } : {}) },
        desktops: link.desktops.list().map((d) => ({ id: d.id, name: d.name, online: connected.has(d.id), pairedAt: d.pairedAt, lastSeen: d.lastSeen, ...(d.build?.version ? { version: d.build.version } : {}) })),
        phones: server.host.mobile.getState().devices.map((p) => ({ id: p.id, name: p.name, online: p.online, lastSeen: p.lastSeen })),
        update: updater.info().update
      }
      return status
    }
    case 'pair':
      return link.createPairingCode()
    case 'pair-status':
      return link.codeState()
    case 'pair-cancel':
      link.cancelPairingCode()
      return null
    case 'unpair':
      return { removed: link.unpair(String(request.id ?? '')) }
    case 'revoke-all': {
      const desktops = link.desktops.list()
      for (const desktop of desktops) link.unpair(desktop.id)
      const phones = server.host.revokeAllPhones()
      // Let the revokes reach the relay before the caller stops us.
      await new Promise((resolve) => setTimeout(resolve, 300))
      return { count: desktops.length, phones }
    }
    // `devtool-server pair --phone` and `unpair` of a phone (plan step 10).
    case 'phone-pair':
      return server.host.mobile.startPairing()
    case 'phone-state':
      return server.host.mobile.getState()
    case 'phone-cancel':
      server.host.mobile.cancelPairing()
      return server.host.mobile.getState()
    case 'phone-accept':
      server.host.mobile.accept(String(request.id ?? ''))
      return server.host.mobile.getState()
    case 'phone-reject':
      server.host.mobile.reject(String(request.id ?? ''))
      return server.host.mobile.getState()
    case 'phone-revoke':
      server.host.mobile.revoke(String(request.id ?? ''))
      return server.host.mobile.getState()
    default:
      throw new Error(`unknown command ${request.cmd}`)
  }
}

/** The daemon's link-level calls (protocol/SERVER.md §5.1). */
function daemonLinkCall(call: LinkCall, { link, updater, uninstall }: { link: ServerLink; updater: ServerUpdater; uninstall: (deleteData: boolean, why: string) => void }): Promise<unknown> | undefined {
  switch (call.ch) {
    case LinkChannel.PairCode:
      return pairCodeForDesktop(link)
    case LinkChannel.Info:
      return Promise.resolve(updater.info())
    case LinkChannel.Restart:
      // After the answer is out.
      setTimeout(() => updater.restartNow(`server-restart from ${call.desktopId}`), 200)
      return Promise.resolve({ restarting: true })
    case LinkChannel.Uninstall: {
      const options = (call.args[0] ?? {}) as { deleteData?: unknown }
      uninstall(options.deleteData === true, `server-uninstall from ${call.desktopId}`)
      return Promise.resolve({ ok: true })
    }
    default:
      return undefined
  }
}

export interface CheckResult {
  ok: boolean
  lines: string[]
}

/**
 * `--check`: node-pty loads and a PTY runs `echo devtool-ok` through the host's
 * own PtyManager. Touches nothing in the data dir. The installer runs it before
 * it sets up the service.
 */
export async function runCheck({ bundleDir }: RunOptions, timeoutMs = 10_000): Promise<CheckResult> {
  const manifest = loadServerManifest(bundleDir)
  const lines = [
    `devtool-server ${manifest.version} (commit ${manifest.commit}${manifest.builtAt ? `, built ${manifest.builtAt}` : ''})`,
    `node ${process.version} ${process.platform}-${process.arch}`
  ]
  try {
    const require = createRequire(path.join(bundleDir, 'main.js'))
    const pkgPath = require.resolve('node-pty/package.json')
    const pkg = require(pkgPath) as { version?: string }
    lines.push(`node-pty ${pkg.version ?? '?'} at ${path.dirname(pkgPath)}`)
  } catch (err) {
    lines.push(`node-pty not found: ${err instanceof Error ? err.message : String(err)}`)
  }

  const ptys = new PtyManager()
  const outcome = await new Promise<{ output: string; exitCode: number | null; error?: string }>((resolve) => {
    let output = ''
    const timer = setTimeout(() => resolve({ output, exitCode: null, error: `no exit within ${timeoutMs} ms` }), timeoutMs)
    try {
      ptys.spawn('devtool-check', '/bin/sh', os.homedir(), 80, 24, ['-c', 'echo devtool-ok'], {}, {
        onData: (data) => { output += data },
        onExit: (exitCode) => {
          clearTimeout(timer)
          // The last read can land just after the exit.
          setTimeout(() => resolve({ output, exitCode }), 50)
        }
      })
    } catch (err) {
      clearTimeout(timer)
      resolve({ output, exitCode: null, error: err instanceof Error ? err.message : String(err) })
    }
  })
  ptys.killAll()

  const text = outcome.output.replace(/\r/g, '').trim()
  const ok = outcome.exitCode === 0 && text.split('\n').includes('devtool-ok')
  lines.push(`pty: ${JSON.stringify(text)} exit=${outcome.exitCode ?? 'none'}${outcome.error ? ` error=${outcome.error}` : ''}`)
  lines.push(ok ? 'check ok' : 'check FAILED')
  return { ok, lines }
}
