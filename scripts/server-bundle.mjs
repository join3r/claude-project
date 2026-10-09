/**
 * Helpers for the DevTool server bundle (`npm run build:server`), kept apart from
 * the build script so tests (and later the server's own updater) can use them.
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

/** The bundle's own manifest; it carries the hash, so the hash leaves it out. */
export const MANIFEST_FILE = 'manifest.json'

const ELECTRON_IMPORT = /^electron(-updater)?(\/.*)?$/

/**
 * An esbuild plugin that fails the build when anything resolves `electron` or
 * `electron-updater`: the server runs on plain Node, where either would only fail
 * at runtime. Each error names the file that imports it.
 *
 * @param {string} [root] Importer paths are shown relative to this directory.
 * @returns {import('esbuild').Plugin}
 */
export function electronGuardPlugin(root = process.cwd()) {
  // esbuild reports importers by their real path (/private/var/… for /var/… on macOS).
  let base = root
  try { base = fs.realpathSync(root) } catch { /* keep it as given */ }
  const shown = (file) => {
    const rel = path.relative(base, file)
    return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel.split(path.sep).join('/') : file
  }
  return {
    name: 'devtool-server-no-electron',
    setup(build) {
      build.onResolve({ filter: ELECTRON_IMPORT }, (args) => {
        const importer = args.importer ? shown(args.importer) : '(entry point)'
        return {
          errors: [{
            text: `"${args.path}" is imported by ${importer}, but the server bundle runs without Electron`
          }]
        }
      })
    }
  }
}

/**
 * Every regular file under `dir` but the manifest, as POSIX paths relative to it,
 * sorted by code unit (byte order for the ASCII names a bundle has). A symlink
 * fails: the bundle is unpacked on another machine, where it would point elsewhere.
 *
 * @param {string} dir
 * @returns {string[]}
 */
export function bundleFiles(dir) {
  /** @type {string[]} */
  const files = []
  const walk = (rel) => {
    for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const child = rel ? `${rel}/${entry.name}` : entry.name
      if (entry.isDirectory()) walk(child)
      else if (entry.isFile()) {
        if (child !== MANIFEST_FILE) files.push(child)
      } else {
        throw new Error(`${child} in the server bundle is not a regular file`)
      }
    }
  }
  walk('')
  return files.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
}

/**
 * The bundle's content hash: SHA-256 over one `<sha256 of the file>  <path>\n` line
 * per file of {@link bundleFiles}, in that order. That is `sha256sum`'s own output,
 * so it can be checked by hand from the bundle dir:
 *
 *     find . -type f ! -path ./manifest.json | sed 's|^\./||' | LC_ALL=C sort \
 *       | xargs sha256sum | sha256sum
 *
 * File modes are not part of it.
 *
 * @param {string} dir
 * @returns {string} lowercase hex
 */
export function bundleSha256(dir) {
  const listing = createHash('sha256')
  for (const file of bundleFiles(dir)) {
    const digest = createHash('sha256').update(fs.readFileSync(path.join(dir, file))).digest('hex')
    listing.update(`${digest}  ${file}\n`)
  }
  return listing.digest('hex')
}
