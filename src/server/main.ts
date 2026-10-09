import path from 'path'
import { fileURLToPath } from 'url'
import { loadServerManifest } from './server-env'

/**
 * The DevTool server's launcher (`main.js` in the bundle):
 *
 *   node main.js            run the server (a service manager keeps it up)
 *   node main.js --check    node-pty loads and a PTY works; exit 0 or 1
 *   node main.js --version  print the bundle's version and build
 *
 * It holds nothing that could fail to load: it checks the Node version, then
 * imports `server.js` (which loads node-pty) and reports when that fails.
 */

const MIN_NODE_MAJOR = 24
const USAGE = 'usage: node main.js [--check | --version]'

function fail(message: string, code = 1): void {
  process.stderr.write(`devtool-server: ${message}\n`)
  process.exitCode = code
}

async function main(argv: string[]): Promise<void> {
  const bundleDir = path.dirname(fileURLToPath(import.meta.url))
  const known = new Set(['--check', '--version', '--help'])
  const unknown = argv.filter((arg) => !known.has(arg))
  if (unknown.length > 0 || argv.length > 1) return fail(`unexpected arguments: ${argv.join(' ')}\n${USAGE}`, 2)
  if (argv[0] === '--help') {
    process.stdout.write(`${USAGE}\n`)
    return
  }
  if (argv[0] === '--version') {
    const manifest = loadServerManifest(bundleDir)
    process.stdout.write(`${manifest.version} ${manifest.commit} ${manifest.builtAt}\n`)
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

  if (argv[0] === '--check') {
    const result = await server.runCheck({ bundleDir })
    process.stdout.write(`${result.lines.join('\n')}\n`)
    // Nothing of the check may keep the process up.
    process.exit(result.ok ? 0 : 1)
  }
  await server.runDaemon({ bundleDir })
}

main(process.argv.slice(2)).catch((err: unknown) => {
  fail(err instanceof Error ? (err.stack ?? err.message) : String(err))
})
