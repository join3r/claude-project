#!/usr/bin/env node
/**
 * Verify — and if needed repair — the Electron binary install.
 *
 * Electron's own postinstall unpacks the downloaded zip with extract-zip@2 (yauzl@2).
 * On Node >=26 that stack can abort mid-extraction without settling its promise: the
 * event loop drains, install.js exits 0, and `node_modules/electron/dist` is left with
 * a handful of files and no `path.txt`. npm reports success, then electron-vite fails
 * later with the opaque `Error: Electron uninstall`.
 *
 * This script detects that half-installed state and re-extracts the already-downloaded
 * zip from the @electron/get cache using a system unzip tool.
 */
import { existsSync, readFileSync, writeFileSync, renameSync, rmSync, chmodSync, readdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'

const require = createRequire(import.meta.url)

/** Path of the executable inside dist/, matching electron's own install.js. */
function platformPath(platform) {
  switch (platform) {
    case 'mas':
    case 'darwin':
      return 'Electron.app/Contents/MacOS/Electron'
    case 'freebsd':
    case 'openbsd':
    case 'linux':
      return 'electron'
    case 'win32':
      return 'electron.exe'
    default:
      return null
  }
}

function cacheRoots() {
  const roots = []
  for (const explicit of [process.env.electron_config_cache, process.env.ELECTRON_CACHE]) {
    if (explicit) roots.push(explicit)
  }
  if (process.platform === 'darwin') {
    roots.push(join(homedir(), 'Library', 'Caches', 'electron'))
  } else if (process.platform === 'win32') {
    if (process.env.LOCALAPPDATA) roots.push(join(process.env.LOCALAPPDATA, 'electron', 'Cache'))
  } else {
    roots.push(join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'electron'))
  }
  return roots
}

/** @electron/get stores each artifact under a content-hash directory, so glob one level down. */
function findCachedZip(zipName) {
  for (const root of cacheRoots()) {
    if (!existsSync(root)) continue
    const direct = join(root, zipName)
    if (existsSync(direct)) return direct
    for (const entry of readdirSync(root)) {
      const candidate = join(root, entry, zipName)
      if (existsSync(candidate)) return candidate
    }
  }
  return null
}

function extractZip(zipPath, destDir) {
  const tools = [
    ['unzip', ['-q', '-o', zipPath, '-d', destDir]],
    ['python3', ['-m', 'zipfile', '-e', zipPath, destDir]],
    ['bsdtar', ['-xf', zipPath, '-C', destDir]]
  ]
  if (process.platform === 'win32') {
    tools.unshift([
      'powershell',
      ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${destDir}' -Force`]
    ])
  }
  for (const [cmd, args] of tools) {
    try {
      execFileSync(cmd, args, { stdio: 'ignore' })
      return cmd
    } catch {
      // Tool missing or extraction failed — try the next one.
    }
  }
  return null
}

let electronDir
try {
  electronDir = dirname(require.resolve('electron/package.json'))
} catch {
  // Electron isn't installed (e.g. ELECTRON_SKIP_BINARY_DOWNLOAD, or a partial tree) — nothing to do.
  process.exit(0)
}

const { version } = require(join(electronDir, 'package.json'))
const execName = platformPath(process.env.npm_config_platform || process.platform)
if (!execName) process.exit(0)

const distDir = join(electronDir, 'dist')
const pathTxt = join(electronDir, 'path.txt')

const installedVersion = existsSync(join(distDir, 'version'))
  ? readFileSync(join(distDir, 'version'), 'utf-8').trim().replace(/^v/, '')
  : null

if (installedVersion === version && existsSync(pathTxt) && existsSync(join(distDir, execName))) {
  process.exit(0)
}

const arch = process.env.npm_config_arch || process.arch
const platform = process.env.npm_config_platform || process.platform
const zipName = `electron-v${version}-${platform}-${arch}.zip`
const zipPath = findCachedZip(zipName)

if (!zipPath) {
  console.warn(
    `[ensure-electron] Electron ${version} is not fully unpacked and ${zipName} is not in the ` +
      `download cache.\n[ensure-electron] Run: rm -rf node_modules/electron && npm install`
  )
  process.exit(0)
}

console.warn(`[ensure-electron] Electron ${version} is only partially unpacked — re-extracting ${zipName}`)

rmSync(distDir, { recursive: true, force: true })
const tool = extractZip(zipPath, distDir)

if (!tool) {
  console.warn(
    '[ensure-electron] No usable unzip tool found (tried unzip, python3, bsdtar).\n' +
      `[ensure-electron] Extract ${zipPath} into ${distDir} manually, then write "${execName}" to ${pathTxt}.`
  )
  process.exit(0)
}

// The zip ships electron.d.ts at its root; electron's installer hoists it out of dist/.
const bundledTypes = join(distDir, 'electron.d.ts')
if (existsSync(bundledTypes)) {
  renameSync(bundledTypes, join(electronDir, 'electron.d.ts'))
}

writeFileSync(pathTxt, execName)

// Leave chrome-sandbox at its packaged mode: making it setuid without root ownership
// makes Chromium reject it outright instead of falling back to the namespace sandbox.
if (process.platform !== 'win32') {
  try {
    chmodSync(join(distDir, execName), 0o755)
  } catch {
    // Non-fatal; the binary is usually already executable.
  }
}

console.warn(`[ensure-electron] Repaired Electron ${version} install using ${tool}.`)
