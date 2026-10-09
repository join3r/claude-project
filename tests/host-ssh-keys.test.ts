import { execFileSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { DESKTOP_KEY_OPTIONS, authorizeDesktopKey, cleanKeyComment, parseEd25519PublicKey, readHostKeys, revokeDesktopKey, type SshKeyHome } from '../src/main/host-ssh-keys'
import { registerHostSshHandlers } from '../src/main/ipc/host-ssh'
import type { IpcRegistrar } from '../src/main/ipc/registrar'

/** Open in IDE's key on a server: the authorized_keys host channel (plan step 9). */

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function tempHome(): SshKeyHome {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devtool-sshkeys-'))
  dirs.push(root)
  const hostKeyDir = path.join(root, 'etc-ssh')
  fs.mkdirSync(hostKeyDir)
  return { home: path.join(root, 'home'), user: 'dev', hostKeyDir }
}

/** A real Ed25519 public key line: 32 key bytes in the ssh wire format. */
function ed25519Pub(seed: number, comment = 'devtool-test'): string {
  const type = Buffer.from('ssh-ed25519')
  const blob = Buffer.concat([Buffer.from([0, 0, 0, 11]), type, Buffer.from([0, 0, 0, 32]), Buffer.alloc(32, seed)])
  return `ssh-ed25519 ${blob.toString('base64')} ${comment}`
}

const mode = (file: string) => fs.statSync(file).mode & 0o777

describe('authorized_keys on a server', () => {
  it('accepts only one well-formed ssh-ed25519 key', () => {
    expect(parseEd25519PublicKey(ed25519Pub(1))).toMatch(/^AAAAC3NzaC1lZDI1NTE5/)
    expect(() => parseEd25519PublicKey('ssh-rsa AAAAB3NzaC1yc2E= x')).toThrow(/ssh-ed25519/)
    expect(() => parseEd25519PublicKey('ssh-ed25519 !!!')).toThrow(/base64/)
    expect(() => parseEd25519PublicKey(`ssh-ed25519 ${Buffer.alloc(51).toString('base64')}`)).toThrow(/valid/)
    expect(cleanKeyComment('devtool-My Mac (2)\nevil')).toBe('devtool-My-Mac-2-evil')
  })

  it('creates ~/.ssh 0700 and authorized_keys 0600, restricted to connections from the server itself', () => {
    const where = tempHome()
    const result = authorizeDesktopKey({ publicKey: ed25519Pub(1), comment: 'devtool-mac' }, where)
    expect(result).toMatchObject({ user: 'dev', home: where.home, added: true, hostKeys: [] })
    const file = path.join(where.home, '.ssh', 'authorized_keys')
    expect(mode(path.join(where.home, '.ssh'))).toBe(0o700)
    expect(mode(file)).toBe(0o600)
    const blob = parseEd25519PublicKey(ed25519Pub(1))
    expect(fs.readFileSync(file, 'utf8')).toBe(`${DESKTOP_KEY_OPTIONS} ssh-ed25519 ${blob} devtool-mac\n`)
  })

  it('is idempotent, keeps what was there, and never loosens a mode', () => {
    const where = tempHome()
    fs.mkdirSync(path.join(where.home, '.ssh'), { recursive: true, mode: 0o755 })
    const file = path.join(where.home, '.ssh', 'authorized_keys')
    fs.writeFileSync(file, 'ssh-ed25519 AAAAexisting someone', { mode: 0o640 })
    expect(authorizeDesktopKey({ publicKey: ed25519Pub(2), comment: 'devtool-a' }, where).added).toBe(true)
    expect(authorizeDesktopKey({ publicKey: ed25519Pub(2, 'other-comment'), comment: 'devtool-b' }, where).added).toBe(false)
    const lines = fs.readFileSync(file, 'utf8').split('\n')
    expect(lines[0]).toBe('ssh-ed25519 AAAAexisting someone')
    expect(lines.filter((l) => l.includes(parseEd25519PublicKey(ed25519Pub(2))))).toHaveLength(1)
    expect(mode(file)).toBe(0o640)
    expect(mode(path.join(where.home, '.ssh'))).toBe(0o755)
    // A key the user added by hand (no options) counts as there.
    fs.appendFileSync(file, `${ed25519Pub(3)}\n`)
    expect(authorizeDesktopKey({ publicKey: ed25519Pub(3), comment: 'x' }, where).added).toBe(false)
  })

  it('answers sshd\'s host keys for pinning', () => {
    const where = tempHome()
    fs.writeFileSync(path.join(where.hostKeyDir, 'ssh_host_ed25519_key.pub'), `${ed25519Pub(9, 'root@box')}\n`)
    fs.writeFileSync(path.join(where.hostKeyDir, 'ssh_host_rsa_key.pub'), 'ssh-rsa AAAAB3NzaC1yc2EAAA== root@box\n')
    fs.writeFileSync(path.join(where.hostKeyDir, 'ssh_host_ecdsa_key.pub'), 'garbage\n')
    expect(readHostKeys(where.hostKeyDir)).toEqual([ed25519Pub(9, '').trim(), 'ssh-rsa AAAAB3NzaC1yc2EAAA=='])
  })

  it('revokes every line with the key, keeping the file\'s mode', () => {
    const where = tempHome()
    authorizeDesktopKey({ publicKey: ed25519Pub(4), comment: 'devtool-a' }, where)
    authorizeDesktopKey({ publicKey: ed25519Pub(5), comment: 'devtool-b' }, where)
    const file = path.join(where.home, '.ssh', 'authorized_keys')
    expect(revokeDesktopKey(ed25519Pub(4), where)).toEqual({ removed: true })
    expect(revokeDesktopKey(ed25519Pub(4), where)).toEqual({ removed: false })
    expect(fs.readFileSync(file, 'utf8')).not.toContain(parseEd25519PublicKey(ed25519Pub(4)))
    expect(fs.readFileSync(file, 'utf8')).toContain(parseEd25519PublicKey(ed25519Pub(5)))
    expect(mode(file)).toBe(0o600)
  })

  it('matches keys by their bytes, never their comment: two desktops with one name stay apart', () => {
    const where = tempHome()
    authorizeDesktopKey({ publicKey: ed25519Pub(6), comment: 'devtool-mac' }, where)
    authorizeDesktopKey({ publicKey: ed25519Pub(7), comment: 'devtool-mac' }, where)
    expect(revokeDesktopKey(ed25519Pub(6, 'devtool-mac'), where)).toEqual({ removed: true })
    const left = fs.readFileSync(path.join(where.home, '.ssh', 'authorized_keys'), 'utf8')
    expect(left).toContain(parseEd25519PublicKey(ed25519Pub(7)))
    expect(left).not.toContain(parseEd25519PublicKey(ed25519Pub(6)))
  })

  it('works with a key ssh-keygen made', () => {
    const where = tempHome()
    const keyFile = path.join(path.dirname(where.home), 'id_ed25519')
    try {
      execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'devtool-test', '-f', keyFile])
    } catch {
      return // no ssh-keygen here
    }
    const pub = fs.readFileSync(`${keyFile}.pub`, 'utf8')
    expect(authorizeDesktopKey({ publicKey: pub, comment: 'devtool-test' }, where).added).toBe(true)
  })

  it('serves the channels only on a server', async () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>()
    const registrar = { handle: (ch: string, _s: unknown, fn: (...args: unknown[]) => unknown) => { handlers.set(ch, fn) }, on: () => {}, onSync: () => {} } as unknown as IpcRegistrar
    const where = tempHome()
    registerHostSshHandlers(registrar, { isServer: false, where: () => where })
    expect(() => handlers.get('host-ssh-authorize-key')!({}, 'local', { publicKey: ed25519Pub(1), comment: 'x' })).toThrow(/Only a DevTool server/)
    expect(fs.existsSync(where.home)).toBe(false)
    registerHostSshHandlers(registrar, { isServer: true, where: () => where })
    expect(handlers.get('host-ssh-authorize-key')!({}, 'srv', { publicKey: ed25519Pub(1), comment: 'x' })).toMatchObject({ added: true })
    expect(handlers.get('host-ssh-revoke-key')!({}, 'srv', { publicKey: ed25519Pub(1) })).toEqual({ removed: true })
  })
})
