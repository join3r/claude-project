import { createRequire } from 'module'
import os from 'os'
import path from 'path'
import { PtyManager } from '../main/pty-manager'
import { resolveShellEnv } from '../main/shell-env'
import { listCondaEnvs } from '../main/conda-env'
import { acquireInstanceLock } from '../main/instance-lock'
import { installBrokenPipeUncaughtHandler } from '../main/broken-pipe'
import { createServerLink, startServerHost, type ServerHost } from './server-host'
import { consoleError, consoleLog, ensureServerDirs, loadServerManifest, loginShell, passwdShell, serverPaths } from './server-env'
import { loadServerConfig, saveServerConfig } from './server-config'
import { decodeDevKeys, type DevKeys } from '../main/host/link/dev-pair'

/** `--dev-pair`'s argument; throws when it isn't `<x25519Pub>.<ed25519Pub>`. */
export const parseDevKeys = decodeDevKeys

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
  /** Dev only: also offer this desktop a pairing and print the code for it (protocol/SERVER.md §7). */
  devPair?: DevKeys & { name?: string }
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
export async function runDaemon({ bundleDir, devPair, relayUrl }: DaemonOptions): Promise<void> {
  const log = consoleLog
  // As in Electron's main: an exception escaping a callback is logged, and the
  // terminals and chats running in this process live on.
  installBrokenPipeUncaughtHandler(process, (err) => consoleError(`uncaughtException ${describe(err)}`))
  process.on('unhandledRejection', (reason) => consoleError(`unhandledRejection ${describe(reason)}`))

  const paths = serverPaths()
  const manifest = loadServerManifest(bundleDir)
  log(`starting devtool-server ${manifest.version} (${manifest.commit}) node=${process.version} pid=${process.pid}`)

  ensureServerDirs(paths)
  const lock = await acquireInstanceLock(paths.dataDir, () => log('another devtool-server tried to start on this data dir'))
  if (!lock.acquired) {
    consoleError(`devtool-server is already running on ${paths.dataDir}${lock.ownerPid ? ` (pid ${lock.ownerPid})` : ''}`)
    process.exitCode = 1
    return
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
  const link = createServerLink(server)
  link.start()
  log(`ready version=${manifest.version} commit=${manifest.commit} data=${paths.dataDir}`)
  log(`link server=${server.host.identity.get().id} relay=${loadServerConfig(paths.dataDir).relayUrl} desktops=${link.desktops.list().length}`)
  if (devPair) {
    link.offerDevPair(devPair).then(
      (code) => {
        log('dev pairing: give this code to the desktop (ServerHub.devPair, or DEVTOOL_DEV_SERVER_PAIR in a dev run):')
        process.stdout.write(`${code}\n`)
      },
      (err: unknown) => consoleError(`dev pairing failed: ${describe(err)}`)
    )
  }

  let stopping = false
  const stop = (signal: string): void => {
    if (stopping) return
    stopping = true
    log(`stopping signal=${signal}`)
    const timer = setTimeout(() => {
      consoleError(`shutdown took over ${SHUTDOWN_TIMEOUT_MS} ms; exiting anyway`)
      lock.release()
      process.exit(1)
    }, SHUTDOWN_TIMEOUT_MS)
    timer.unref()
    link.stop()
    server.shutdown()
      .catch((err: unknown) => consoleError(`shutdown error ${describe(err)}`))
      .finally(() => {
        lock.release()
        log('stopped')
        process.exit(0)
      })
  }
  // Not SIGHUP: under nohup (the fallback service) it is ignored, and a handler would undo that.
  process.on('SIGTERM', () => stop('SIGTERM'))
  process.on('SIGINT', () => stop('SIGINT'))
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
