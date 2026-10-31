#!/usr/bin/env node
/**
 * `npm run build:server` → out/server/: the headless DevTool server, runnable with
 * a plain Node 24 (`node out/server/main.js [--check]`).
 *
 *   main.js          launcher: arguments, Node version, then loads server.js
 *   server.js        the host (HostServices, the Agent SDK) bundled into one file
 *   package.json     marks both as ES modules
 *   manifest.json    { version, commit, builtAt, protocol, node, sha256 }
 *   pi-status-extension.mjs, notebook-kernel.py   resources for external processes
 *   node_modules/node-pty/   upstream node-pty (the `node-pty-server` alias):
 *                    package.json, LICENSE, lib/ and the four unix prebuilds
 *   datachannel.json node-datachannel's prebuilds (npm URL + sha512 per platform,
 *                    from package-lock.json). Its JS is in server.js; a server
 *                    fetches its own ~9 MB binary on first use
 *                    (src/server/datachannel-binary.ts), so the bundle stays small.
 *
 * The build fails if anything in the server's graph imports electron or
 * electron-updater.
 */
import { build } from 'esbuild'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { MANIFEST_FILE, SERVER_NODE_VERSION, bundleSha256, electronGuardPlugin } from './server-bundle.mjs'
/** node-pty's prebuilt platforms the server supports; Windows is the desktop's alone. */
const PTY_PREBUILDS = ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64']
/** node-datachannel's prebuilds a server may fetch (src/server/datachannel-binary.ts `prebuildName`). */
const DATACHANNEL_PREBUILDS = ['darwin-arm64', 'darwin-x64', 'linux-arm64-gnu', 'linux-x64-gnu', 'linux-arm64-musl', 'linux-x64-musl']
/** The global the stub loader reads (BINDING_GLOBAL in src/server/datachannel-binary.ts). */
const DATACHANNEL_GLOBAL = '__devtoolNodeDatachannel'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** The host link's protocol version, read from src/main/host/link/version.ts (the one source of it). */
function hostLinkProtocolVersion() {
  const source = fs.readFileSync(path.join(root, 'src/main/host/link/version.ts'), 'utf8')
  const match = /export const HOST_LINK_PROTOCOL_VERSION = (\d+)/.exec(source)
  if (!match) throw new Error('HOST_LINK_PROTOCOL_VERSION not found in src/main/host/link/version.ts')
  return Number(match[1])
}
const outDir = path.join(root, 'out/server')
const ptySource = path.join(root, 'node_modules/node-pty-server')

function git(args) {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return ''
  }
}

function copyNodePty(dest) {
  const pkg = JSON.parse(fs.readFileSync(path.join(ptySource, 'package.json'), 'utf8'))
  if (pkg.name !== 'node-pty') throw new Error(`${ptySource} is not node-pty; run npm install`)
  fs.mkdirSync(dest, { recursive: true })
  fs.copyFileSync(path.join(ptySource, 'package.json'), path.join(dest, 'package.json'))
  fs.copyFileSync(path.join(ptySource, 'LICENSE'), path.join(dest, 'LICENSE'))
  fs.cpSync(path.join(ptySource, 'lib'), path.join(dest, 'lib'), {
    recursive: true,
    filter: (src) => !src.endsWith('.test.js') && !src.endsWith('.map')
  })
  for (const platform of PTY_PREBUILDS) {
    const from = path.join(ptySource, 'prebuilds', platform)
    const to = path.join(dest, 'prebuilds', platform)
    if (!fs.existsSync(path.join(from, 'pty.node'))) throw new Error(`node-pty ${pkg.version} has no ${platform} prebuild`)
    fs.cpSync(from, to, { recursive: true })
    // lib/unixTerminal.js execs it on macOS; a copy must not lose the x bit.
    const helper = path.join(to, 'spawn-helper')
    if (fs.existsSync(helper)) fs.chmodSync(helper, 0o755)
  }
  return pkg.version
}

/** `datachannel.json`: each prebuild's tarball and sha512, as package-lock.json pins them. */
function datachannelManifest() {
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8')).packages
  const main = lock['node_modules/node-datachannel']
  if (!main) throw new Error('node-datachannel is not in package-lock.json; run npm install')
  const prebuilds = {}
  for (const name of DATACHANNEL_PREBUILDS) {
    const entry = lock[`node_modules/@node-datachannel/${name}`]
    if (!entry?.resolved || !entry.integrity?.startsWith('sha512-')) throw new Error(`package-lock.json has no @node-datachannel/${name}`)
    if (entry.version !== main.version) throw new Error(`@node-datachannel/${name} ${entry.version} does not match node-datachannel ${main.version}`)
    prebuilds[name] = { url: entry.resolved, integrity: entry.integrity }
  }
  return { version: main.version, prebuilds }
}

/**
 * node-datachannel's loader looks for its binary next to the package or in an
 * optional dependency; in the bundle it is neither, so the loader is replaced by
 * one that returns what datachannel-binary.ts loaded.
 */
function datachannelLoaderPlugin() {
  return {
    name: 'devtool-datachannel-loader',
    setup(build) {
      build.onLoad({ filter: /node-datachannel[\\/]dist[\\/](esm|cjs)[\\/]lib[\\/]node-datachannel\.(mjs|cjs)$/ }, () => ({
        contents: `const binding = globalThis.${DATACHANNEL_GLOBAL};\n` +
          `if (!binding) throw new Error('node-datachannel binary not loaded');\n` +
          'export default binding;\n',
        loader: 'js'
      }))
    }
  }
}

async function main() {
  const started = Date.now()
  fs.rmSync(outDir, { recursive: true, force: true })
  fs.mkdirSync(outDir, { recursive: true })

  const result = await build({
    absWorkingDir: root,
    entryPoints: {
      main: 'src/server/main.ts',
      server: 'src/server/server.ts'
    },
    outdir: outDir,
    bundle: true,
    platform: 'node',
    target: 'node24',
    format: 'esm',
    // Loaded at runtime from out/server/node_modules/node-pty (copied below).
    external: ['node-pty'],
    // Bundled CommonJS code calls require(); ESM output has none of its own.
    banner: {
      js: "import { createRequire as __devtoolCreateRequire } from 'node:module'; const require = __devtoolCreateRequire(import.meta.url);"
    },
    plugins: [electronGuardPlugin(root), datachannelLoaderPlugin()],
    legalComments: 'none',
    logLevel: 'warning',
    metafile: true
  })

  fs.writeFileSync(path.join(outDir, 'package.json'), JSON.stringify({
    name: 'devtool-server',
    private: true,
    type: 'module'
  }, null, 2) + '\n')
  for (const name of ['pi-status-extension.mjs', 'notebook-kernel.py']) {
    fs.copyFileSync(path.join(root, 'resources', name), path.join(outDir, name))
  }
  const ptyVersion = copyNodePty(path.join(outDir, 'node_modules/node-pty'))
  const datachannel = datachannelManifest()
  fs.writeFileSync(path.join(outDir, 'datachannel.json'), JSON.stringify(datachannel, null, 2) + '\n')

  const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version
  const manifest = {
    version,
    commit: git(['rev-parse', 'HEAD']) || 'unknown',
    builtAt: new Date().toISOString(),
    protocol: hostLinkProtocolVersion(),
    node: SERVER_NODE_VERSION,
    sha256: bundleSha256(outDir)
  }
  fs.writeFileSync(path.join(outDir, MANIFEST_FILE), JSON.stringify(manifest, null, 2) + '\n')

  const bytes = (file) => fs.statSync(path.join(outDir, file)).size
  let total = 0
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else total += fs.statSync(full).size
    }
  }
  walk(outDir)
  const kb = (n) => `${(n / 1024).toFixed(0)} KiB`
  const inputs = Object.keys(result.metafile.inputs).length
  console.log(`build:server ${version} (${manifest.commit.slice(0, 12)}) → ${path.relative(root, outDir)}/ in ${Date.now() - started} ms`)
  console.log(`  main.js ${kb(bytes('main.js'))}, server.js ${kb(bytes('server.js'))} (${inputs} inputs), node-pty ${ptyVersion}, node-datachannel ${datachannel.version} (fetched by servers), total ${kb(total)}`)
  console.log(`  sha256 ${manifest.sha256}`)
}

main().catch((err) => {
  // esbuild has already printed its own errors (the electron guard's among them).
  if (!err?.errors) console.error(err)
  console.error('build:server failed')
  process.exit(1)
})
