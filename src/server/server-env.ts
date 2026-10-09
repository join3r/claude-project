import fs from 'fs'
import os from 'os'
import path from 'path'
import type { HostEnv } from '../main/host/host-env'
import type { ImageCodec } from '../main/mobile/chat-image'
import type { SecretEncryptor } from '../main/mobile/identity'
import type { PowerSaveApi } from '../main/sleep-blocker'
import type { ServerHostInfo } from '../shared/servers'

/**
 * Where a server keeps everything: `$DEVTOOL_SERVER_HOME`, by default `~/.devtool-server`.
 *
 *     app/<version>-<sha8>/   unpacked bundles (the running one and one before it)
 *     current -> app/...      the bundle the service starts
 *     node/<version>/         Node from nodejs.org;  node/current -> <version>
 *     data/                   the host's config dir (0700)
 *     logs/                   server.log when not under systemd
 *     run/                    staged.json, the control socket (0700)
 *     bin/devtool-server      the CLI
 *     service.json            how the service was installed
 */
export interface ServerPaths {
  home: string
  /** The host's config dir (projects.json, config, scrollback, the identity). */
  dataDir: string
  appDir: string
  /** Symlink to the bundle the service starts. */
  current: string
  nodeDir: string
  /** Symlink to the Node the service starts. */
  nodeCurrent: string
  logsDir: string
  runDir: string
  binDir: string
}

export const DEFAULT_SERVER_HOME_NAME = '.devtool-server'

export function serverPaths(env: NodeJS.ProcessEnv = process.env): ServerPaths {
  const home = path.resolve(env.DEVTOOL_SERVER_HOME?.trim() || path.join(os.homedir(), DEFAULT_SERVER_HOME_NAME))
  return {
    home,
    dataDir: path.join(home, 'data'),
    appDir: path.join(home, 'app'),
    current: path.join(home, 'current'),
    nodeDir: path.join(home, 'node'),
    nodeCurrent: path.join(home, 'node', 'current'),
    logsDir: path.join(home, 'logs'),
    runDir: path.join(home, 'run'),
    binDir: path.join(home, 'bin')
  }
}

/** Creates the home (0700 when new) and the data dir (always 0700: it holds the identity keys and the projects). */
export function ensureServerDirs(paths: ServerPaths): void {
  fs.mkdirSync(paths.home, { recursive: true, mode: 0o700 })
  fs.mkdirSync(paths.dataDir, { recursive: true, mode: 0o700 })
  fs.chmodSync(paths.dataDir, 0o700)
}

/** `manifest.json` beside the bundle (scripts/build-server.mjs writes it). */
export interface ServerManifest {
  version: string
  /** The git commit it was built from, or `unknown`. */
  commit: string
  /** ISO time of the build. */
  builtAt: string
  /** The host link's protocol version (`HOST_LINK_PROTOCOL_VERSION`); 0 in a source checkout. */
  protocol: number
  /** The Node version the installer pins for this build. */
  node: string
  /** The bundle's content hash (`bundleSha256` in scripts/server-bundle.mjs); its identity for updates. */
  sha256: string
}

/**
 * The bundle's manifest. A source checkout (tests, a dev run) has none: then the
 * version is the repo's package.json one and the rest reads `dev`.
 */
export function loadServerManifest(bundleDir: string): ServerManifest {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(bundleDir, 'manifest.json'), 'utf8')) as Partial<ServerManifest>
    if (typeof raw.version === 'string' && raw.version) {
      return {
        version: raw.version,
        commit: typeof raw.commit === 'string' ? raw.commit : 'unknown',
        builtAt: typeof raw.builtAt === 'string' ? raw.builtAt : '',
        protocol: typeof raw.protocol === 'number' ? raw.protocol : 0,
        node: typeof raw.node === 'string' ? raw.node : '',
        sha256: typeof raw.sha256 === 'string' ? raw.sha256 : ''
      }
    }
  } catch {
    // No manifest: a source checkout.
  }
  return { version: repoVersion(bundleDir), commit: 'dev', builtAt: '', protocol: 0, node: '', sha256: 'dev' }
}

/** The version in the nearest DevTool package.json above `dir`. */
function repoVersion(dir: string): string {
  for (let current = path.resolve(dir), i = 0; i < 6; i++) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(current, 'package.json'), 'utf8')) as { name?: unknown; version?: unknown }
      if (pkg.name === 'devtool' && typeof pkg.version === 'string') return pkg.version
    } catch {
      // Not here; keep walking up.
    }
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  return '0.0.0'
}

/** A server has no keychain: the identity is stored in the clear, in a 0600 file inside the 0700 data dir. */
export const plaintextSecrets: SecretEncryptor = {
  isAvailable: () => false,
  encrypt: () => { throw new Error('The DevTool server stores secrets unencrypted') },
  decrypt: () => { throw new Error('The DevTool server cannot read keychain-encrypted secrets') }
}

/**
 * Phone images go through as they are: no image library on the server. `fitImage`
 * then passes an image that is within the `chat.image` size and refuses a bigger one.
 */
export const passThroughImageCodec: ImageCodec = {
  decode: () => null
}

/** Where log lines go: stdout/stderr (journald keeps them), or a file ({@link logToFile}). */
let logSink: ((line: string, error: boolean) => void) | null = null

/** A log line on stdout, timestamped; the service manager (journald) or {@link logToFile} keeps it. */
export function consoleLog(message: string): void {
  writeLog(`[${new Date().toISOString()}] ${message}\n`, false)
}

/** The same on stderr, for what stops the server. */
export function consoleError(message: string): void {
  writeLog(`[${new Date().toISOString()}] ${message}\n`, true)
}

function writeLog(line: string, error: boolean): void {
  try {
    if (logSink) logSink(line, error)
    else (error ? process.stderr : process.stdout).write(line)
  } catch {
    // Nowhere left to log.
  }
}

/** Bytes `server.log` may reach before it is renamed to `server.log.1` (the one before is dropped). */
export const LOG_FILE_MAX_BYTES = 5 * 1024 * 1024

/**
 * Under launchd and the nohup fallback the server writes its own log,
 * `<logs>/server.log`, capped at {@link LOG_FILE_MAX_BYTES} with one older file kept.
 * (Under systemd it logs to stdout and journald keeps it.)
 */
export function logToFile(file: string, maxBytes = LOG_FILE_MAX_BYTES): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  let size = 0
  try {
    size = fs.statSync(file).size
  } catch {
    size = 0
  }
  logSink = (line) => {
    if (size + line.length > maxBytes && size > 0) {
      try {
        fs.renameSync(file, `${file}.1`)
      } catch {
        // Keep appending to the one we have.
      }
      size = 0
    }
    fs.appendFileSync(file, line, { mode: 0o600 })
    size += Buffer.byteLength(line)
  }
}

/** Back to stdout/stderr (tests). */
export function logToConsole(): void {
  logSink = null
}

/** The server's {@link HostEnv}, plus what it knows about its own build. */
export interface ServerHostEnv extends HostEnv {
  manifest: ServerManifest
  paths: ServerPaths
}

export interface ServerHostEnvOptions {
  paths: ServerPaths
  manifest: ServerManifest
  /** Where the resources are: the bundle's own dir. */
  bundleDir: string
  powerSave: PowerSaveApi
  log: (message: string) => void
}

export function createServerHostEnv({ paths, manifest, bundleDir, powerSave, log }: ServerHostEnvOptions): ServerHostEnv {
  return {
    configDir: paths.dataDir,
    appVersion: manifest.version,
    resourcePath: (name) => path.join(bundleDir, name),
    secrets: plaintextSecrets,
    powerSave,
    images: passThroughImageCodec,
    log,
    manifest,
    paths
  }
}

/**
 * The shell the server logs in with: `$SHELL`, unless that is missing or `/bin/sh`
 * (what cron's `@reboot` gives a nohup fallback), in which case the account's own
 * shell from passwd. A passwd shell that refuses logins is never picked.
 */
export function loginShell(envShell: string | undefined, passwdShell: string | null | undefined): string | undefined {
  const current = envShell?.trim()
  if (current && current !== '/bin/sh') return current
  const account = passwdShell?.trim()
  if (account && !/(nologin|\/false)$/.test(account)) return account
  return current || undefined
}

/** The passwd shell, or null when the account has no passwd entry. */
export function passwdShell(): string | null {
  try {
    return os.userInfo().shell
  } catch {
    return null
  }
}

/** What a server says about its machine in its handshake and pairing hello. */
/** The login name the server runs as; empty when the passwd entry can't be read. */
function serverUser(): string {
  try {
    return os.userInfo().username
  } catch {
    return process.env.USER ?? ''
  }
}

export function serverHostInfo(): ServerHostInfo {
  return { os: process.platform, arch: process.arch, hostname: os.hostname().replace(/\.local$/, ''), node: process.versions.node, user: serverUser() }
}
