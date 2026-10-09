import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { CLI_COMMANDS, CLI_USAGE, runCli } from './cli'
import { loadServerManifest } from './server-env'

/**
 * The DevTool server's launcher (`main.js` in the bundle):
 *
 *   node main.js                 run the server (a service manager keeps it up)
 *   node main.js --relay <url>   the same, saving the relay to server.json first
 *   node main.js --check         node-pty loads and a PTY works; exit 0 or 1
 *   node main.js --version       print the bundle's version and build
 *   node main.js <command>       the CLI (`devtool-server status`, `pair`, ...)
 *
 * It holds nothing that could fail to load: it checks the Node version, then
 * imports `server.js` (which loads node-pty) and reports when that fails. The CLI
 * never loads node-pty.
 */

const MIN_NODE_MAJOR = 24
const USAGE = [
  'usage: node main.js [--check | --version | --relay <url>]',
  '       node main.js <command>   (devtool-server help)'
].join('\n')

type ParsedArgs =
  | { mode: 'run'; relay?: string }
  | { mode: 'check' }
  | { mode: 'version' }
  | { mode: 'help' }
  | { mode: 'cli'; argv: string[] }

/** Null when the arguments make no sense. */
export function parseMainArgs(argv: string[]): ParsedArgs | null {
  if (argv.length === 0) return { mode: 'run' }
  if (argv.length === 1 && ['--check', '--version', '--help'].includes(argv[0])) {
    return { mode: argv[0].slice(2) as 'check' | 'version' | 'help' }
  }
  if ((CLI_COMMANDS as readonly string[]).includes(argv[0])) return { mode: 'cli', argv }
  if (argv.length === 2 && argv[0] === '--relay' && !argv[1].startsWith('--')) return { mode: 'run', relay: argv[1] }
  return null
}

function fail(message: string, code = 1): void {
  process.stderr.write(`devtool-server: ${message}\n`)
  process.exitCode = code
}

async function main(argv: string[]): Promise<void> {
  const bundleDir = path.dirname(fileURLToPath(import.meta.url))
  const args = parseMainArgs(argv)
  if (!args) return fail(`unexpected arguments: ${argv.join(' ')}\n${USAGE}\n\n${CLI_USAGE}`, 2)
  if (args.mode === 'help') {
    process.stdout.write(`${USAGE}\n\n${CLI_USAGE}\n`)
    return
  }
  if (args.mode === 'version') {
    const manifest = loadServerManifest(bundleDir)
    process.stdout.write(`${manifest.version} ${manifest.commit} ${manifest.builtAt}\n`)
    return
  }
  if (args.mode === 'cli') {
    // `devtool-server status | head`: a closed pipe ends the command quietly.
    for (const stream of [process.stdout, process.stderr]) {
      stream.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EPIPE') process.exit(typeof process.exitCode === 'number' ? process.exitCode : 0)
        throw err
      })
    }
    process.exitCode = await runCli(args.argv, { bundleDir })
    return
  }

  const major = Number(process.versions.node.split('.')[0])
  if (!(major >= MIN_NODE_MAJOR)) return fail(`needs Node ${MIN_NODE_MAJOR} or newer, this is ${process.version}`)

  let server: typeof import('./server')
  try {
    // A runtime path, so esbuild leaves server.js a file of its own.
    server = await import(new URL('./server.js', import.meta.url).href) as typeof import('./server')
  } catch (err) {
    return fail(`could not load the server on ${process.platform}-${process.arch}: ${err instanceof Error ? err.message : String(err)}`)
  }

  if (args.mode === 'check') {
    const result = await server.runCheck({ bundleDir })
    process.stdout.write(`${result.lines.join('\n')}\n`)
    // Nothing of the check may keep the process up.
    process.exit(result.ok ? 0 : 1)
  }
  await server.runDaemon({ bundleDir, relayUrl: args.relay })
}

function isEntryPoint(): boolean {
  try {
    // `current/main.js` is a symlinked path; Node loads the real file.
    return !!process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

// Only as the entry point: tests import parseMainArgs.
if (isEntryPoint()) {
  main(process.argv.slice(2)).catch((err: unknown) => {
    fail(err instanceof Error ? (err.stack ?? err.message) : String(err))
  })
}
