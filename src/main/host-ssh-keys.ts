import fs from 'fs'
import os from 'os'
import path from 'path'
import { atomicWriteFileSync } from './atomic-write'

/**
 * Open in IDE on a DevTool server (plan step 9), the server's half: a desktop's
 * DevTool key goes into this user's `~/.ssh/authorized_keys`, and the sshd host
 * keys come back so the desktop can pin them.
 *
 * The desktop's ssh always arrives through the link's `tcp` stream, which the
 * server dials to its own `127.0.0.1:22`, so the key is written with
 * `from="127.0.0.1,::1"`: the same private key used from anywhere else is refused.
 */

/** sshd sees DevTool's connections from the server itself. */
export const DESKTOP_KEY_OPTIONS = 'from="127.0.0.1,::1"'
const ED25519 = 'ssh-ed25519'
const HOST_KEY_FILES = ['ssh_host_ed25519_key.pub', 'ssh_host_ecdsa_key.pub', 'ssh_host_rsa_key.pub']
const HOST_KEY_TYPES = /^(ssh-ed25519|ecdsa-sha2-nistp(?:256|384|521)|ssh-rsa) ([A-Za-z0-9+/]+={0,3})(?:\s|$)/

export interface SshKeyHome {
  /** The user's home (`os.homedir()`). */
  home: string
  user: string
  /** Where sshd's host keys are (`/etc/ssh`). */
  hostKeyDir: string
}

export function defaultSshKeyHome(): SshKeyHome {
  return { home: os.homedir(), user: os.userInfo().username, hostKeyDir: '/etc/ssh' }
}

export interface AuthorizeKeyRequest {
  /** `ssh-ed25519 <base64> [comment]`: the desktop's DevTool key. */
  publicKey: string
  /** `devtool-<desktop name>`. */
  comment: string
}

export interface AuthorizeKeyResult {
  user: string
  home: string
  /** False when the key was there already. */
  added: boolean
  /** sshd's host keys, `<type> <base64>` each, for the desktop's known_hosts. */
  hostKeys: string[]
}

/** The base64 blob of an Ed25519 public key line, checked to be exactly one 32-byte key. */
export function parseEd25519PublicKey(text: string): string {
  const parts = text.trim().split(/\s+/)
  if (parts.length < 2 || parts[0] !== ED25519) throw new Error('Expected an ssh-ed25519 public key')
  const blob = parts[1]
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(blob)) throw new Error('The public key is not base64')
  const bytes = Buffer.from(blob, 'base64')
  // string "ssh-ed25519" + string key[32]
  const typeLength = bytes.length >= 4 ? bytes.readUInt32BE(0) : -1
  const keyLength = bytes.length >= 4 + 11 + 4 ? bytes.readUInt32BE(4 + 11) : -1
  if (bytes.length !== 4 + 11 + 4 + 32 || typeLength !== 11 || bytes.subarray(4, 15).toString('latin1') !== ED25519 || keyLength !== 32) {
    throw new Error('The public key is not a valid ssh-ed25519 key')
  }
  return blob
}

/** A comment safe on one authorized_keys line. */
export function cleanKeyComment(comment: string): string {
  const clean = comment.replace(/[^A-Za-z0-9._@-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 64)
  return clean || 'devtool'
}

/** Whether `line` (with or without options) carries this exact Ed25519 key. */
function lineHasKey(line: string, blob: string): boolean {
  const trimmed = line.trim()
  if (!trimmed || trimmed.startsWith('#')) return false
  const needle = `${ED25519} ${blob}`
  const at = trimmed.indexOf(needle)
  if (at < 0) return false
  const before = at === 0 ? ' ' : trimmed[at - 1]
  const after = trimmed[at + needle.length] ?? ' '
  return /\s/.test(before) && /\s/.test(after)
}

function authorizedKeysFile(home: string): string {
  return path.join(home, '.ssh', 'authorized_keys')
}

/** `~/.ssh`, made 0700 when it isn't there. An existing one is left as it is. */
function ensureSshDir(home: string): string {
  const dir = path.join(home, '.ssh')
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  return dir
}

/** sshd's public host keys, `<type> <base64>`, ed25519 first. Unreadable ones are skipped. */
export function readHostKeys(hostKeyDir: string): string[] {
  const keys: string[] = []
  for (const name of HOST_KEY_FILES) {
    try {
      const match = HOST_KEY_TYPES.exec(fs.readFileSync(path.join(hostKeyDir, name), 'utf8').trim())
      if (match) keys.push(`${match[1]} ${match[2]}`)
    } catch {
      // Not there (no such key type), or not readable.
    }
  }
  return keys
}

/**
 * Appends the desktop's key to `~/.ssh/authorized_keys` unless it is there in any
 * form. Creates `~/.ssh` 0700 and the file 0600 when missing; never loosens an
 * existing file's mode.
 */
export function authorizeDesktopKey(request: AuthorizeKeyRequest, where: SshKeyHome = defaultSshKeyHome()): AuthorizeKeyResult {
  const blob = parseEd25519PublicKey(request.publicKey)
  ensureSshDir(where.home)
  const file = authorizedKeysFile(where.home)
  let existing = ''
  try {
    existing = fs.readFileSync(file, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
  const present = existing.split('\n').some((line) => lineHasKey(line, blob))
  if (!present) {
    const line = `${DESKTOP_KEY_OPTIONS} ${ED25519} ${blob} ${cleanKeyComment(request.comment)}\n`
    const separator = existing.length > 0 && !existing.endsWith('\n') ? '\n' : ''
    const fd = fs.openSync(file, 'a', 0o600)
    try {
      fs.writeSync(fd, separator + line)
    } finally {
      fs.closeSync(fd)
    }
  }
  return { user: where.user, home: where.home, added: !present, hostKeys: readHostKeys(where.hostKeyDir) }
}

/** Removes every line with the desktop's key. Answers whether there was one. */
export function revokeDesktopKey(publicKey: string, where: SshKeyHome = defaultSshKeyHome()): { removed: boolean } {
  const blob = parseEd25519PublicKey(publicKey)
  const file = authorizedKeysFile(where.home)
  let existing: string
  try {
    existing = fs.readFileSync(file, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { removed: false }
    throw err
  }
  const lines = existing.split('\n')
  const kept = lines.filter((line) => !lineHasKey(line, blob))
  if (kept.length === lines.length) return { removed: false }
  // Through a symlink (dotfiles) to the file itself, keeping its mode.
  const target = fs.realpathSync(file)
  const mode = fs.statSync(target).mode & 0o777
  atomicWriteFileSync(target, kept.join('\n'), mode)
  return { removed: true }
}
