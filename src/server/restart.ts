import { spawn } from 'child_process'
import fs from 'fs'
import path from 'path'
import type { ServerPaths } from './server-env'

/**
 * How a server restarts itself into a new bundle (protocol/SERVER.md §10). Under
 * systemd (`Restart=always`) and launchd (`KeepAlive` on a failed exit) it exits
 * with {@link RESTART_EXIT_CODE} and the service manager starts `current` again.
 * Under the nohup fallback, or when run by hand, nothing would: it starts the new
 * `current` itself, detached, after it has let go of the instance lock.
 */

/** "Restart me": any exit but 0 makes the service manager start the server again; this one says why. */
export const RESTART_EXIT_CODE = 75

export type Supervisor = 'systemd' | 'launchd' | 'nohup' | 'none'

/** Set by the service definition (`DEVTOOL_SERVER_SUPERVISOR`). */
export function currentSupervisor(env: NodeJS.ProcessEnv = process.env): Supervisor {
  const value = env.DEVTOOL_SERVER_SUPERVISOR
  return value === 'systemd' || value === 'launchd' || value === 'nohup' ? value : 'none'
}

/**
 * What to start again: `node/current` and `current/main.js` when this process came
 * from the installed layout (so a switched bundle and Node take effect), else the
 * same command line.
 */
export function respawnCommand(paths: ServerPaths, argv: string[] = process.argv, execPath: string = process.execPath): { command: string; args: string[] } {
  const script = argv[1] ? path.resolve(argv[1]) : ''
  const installed = script.startsWith(paths.current + path.sep)
  const node = path.join(paths.nodeCurrent, 'bin', 'node')
  return {
    command: installed && fs.existsSync(node) ? node : execPath,
    args: [installed ? path.join(paths.current, 'main.js') : script, ...argv.slice(2)]
  }
}

/** Exits so the new bundle runs: by exit code for a service manager, by starting it ourselves otherwise. */
export function exitForRestart(paths: ServerPaths, log: (message: string) => void): never {
  const supervisor = currentSupervisor()
  if (supervisor === 'systemd' || supervisor === 'launchd') {
    log(`restart: exit ${RESTART_EXIT_CODE} for ${supervisor}`)
    process.exit(RESTART_EXIT_CODE)
  }
  const { command, args } = respawnCommand(paths)
  log(`restart: starting ${command} ${args.join(' ')}`)
  const child = spawn(command, args, { detached: true, stdio: ['ignore', 'inherit', 'inherit'], env: process.env })
  child.unref()
  process.exit(0)
}
