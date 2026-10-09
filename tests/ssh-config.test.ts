import { execFileSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  INCLUDE_COMMENT,
  assertSafeSshConfig,
  ensureUserSshInclude,
  hasInclude,
  isPlainUserName,
  renderDevtoolSshConfig,
  renderHostBlock,
  renderKnownHosts,
  serverAlias,
  shellWord,
  sshConfigWord,
  type SshHostEntry
} from '../src/main/servers/ssh-config'

/** DevTool's ssh config for Open in IDE, and the Include in the user's (plan step 9). */

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function tempHome(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'devtool-sshcfg-')))
  dirs.push(dir)
  return dir
}

const mode = (file: string) => fs.statSync(file).mode & 0o777
const ID = '0123456789abcdef'.repeat(2)
const entry: SshHostEntry = { serverId: ID, user: 'dev', hostKeys: ['ssh-ed25519 AAAAC3Nza', 'ssh-rsa AAAAB3=='] }
const paths = { identityFile: '/Users/me/.devtool/ssh/id_ed25519', knownHostsFile: '/Users/me/.devtool/ssh/known_hosts' }

describe('ssh config for Open in IDE', () => {
  it('names hosts after the server id, never its name', () => {
    expect(serverAlias(ID)).toBe('devtool-0123456789ab')
    expect(() => serverAlias('box\nProxyCommand evil')).toThrow()
  })

  it('quotes desktop paths for ssh and its shell, doubles % (ssh expands tokens), and refuses what it can\'t quote', () => {
    expect(sshConfigWord('/a/b')).toBe('/a/b')
    expect(sshConfigWord('/a b/c%d')).toBe('"/a b/c%%d"')
    expect(shellWord('/usr/bin/nc')).toBe('/usr/bin/nc')
    expect(shellWord("/it's here")).toBe("'/it'\\''s here'")
    for (const bad of ['a"b', 'a\nb', 'a\rb', 'a\\b', 'a\u0000b', 'a\u001bb']) {
      expect(() => sshConfigWord(bad), JSON.stringify(bad)).toThrow()
      expect(() => shellWord(bad), JSON.stringify(bad)).toThrow()
    }
  })

  it('takes only plain POSIX user names from a server', () => {
    for (const ok of ['dev', 'join3r', '_svc', 'a-b_c', 'machine$', 'Dev']) expect(isPlainUserName(ok), ok).toBe(true)
    for (const bad of ['', '3dev', 'dev\nProxyCommand evil', 'dev ProxyCommand', 'de%h', '"dev"', 'dév', 'a'.repeat(40), 'dev;rm', '-oProxyCommand=x']) {
      expect(isPlainUserName(bad), JSON.stringify(bad)).toBe(false)
    }
  })

  it('refuses or neutralises hostile server values in the rendered config', () => {
    const hostile = [
      'dev\nProxyCommand touch /tmp/pwned',
      'dev\n  LocalCommand touch /tmp/pwned',
      'dev\nMatch exec "touch /tmp/pwned"',
      'dev\nInclude /tmp/evil',
      'de"v',
      'de%hv',
      'dév',
      'dev\r\n  PermitLocalCommand yes'
    ]
    for (const user of hostile) {
      expect(() => renderHostBlock({ ...entry, user }, '/usr/bin/nc -U /s.sock', paths), JSON.stringify(user)).toThrow()
    }
    // Host keys from the server only ever become `<alias> <type> <base64>` lines.
    expect(renderKnownHosts([{ ...entry, hostKeys: ['ssh-ed25519 AAAA\n@cert-authority * ssh-rsa AAAA', '@revoked ssh-rsa AAAA', 'ssh-ed25519 AAAA=='] }]))
      .toBe('devtool-0123456789ab ssh-ed25519 AAAA==\n')
    // And the whole file is checked line by line.
    const good = renderHostBlock(entry, '/usr/bin/nc -U /s.sock', paths)
    expect(() => renderDevtoolSshConfig([good])).not.toThrow()
    for (const extra of ['  LocalCommand touch /tmp/pwned', 'Match exec "true"', 'Include /tmp/evil', '  PermitLocalCommand yes', 'Host *', `Host ${serverAlias(ID)}`, '  User dev\u0007', '  User de"v']) {
      expect(() => assertSafeSshConfig(`${good}${extra}\n`), JSON.stringify(extra)).toThrow()
    }
  })

  it('writes a Host block that logs in with DevTool\'s key and pins the host keys under the alias', () => {
    const block = renderHostBlock(entry, '/usr/bin/nc -U /Users/me/.devtool/servers/x/ssh.sock', paths)
    expect(block).toBe([
      `# DevTool server ${entry.serverId}`,
      'Host devtool-0123456789ab',
      '  HostName devtool-0123456789ab.invalid',
      '  User dev',
      '  ProxyCommand /usr/bin/nc -U /Users/me/.devtool/servers/x/ssh.sock',
      '  IdentityFile /Users/me/.devtool/ssh/id_ed25519',
      '  IdentitiesOnly yes',
      '  HostKeyAlias devtool-0123456789ab',
      '  UserKnownHostsFile /Users/me/.devtool/ssh/known_hosts',
      '  StrictHostKeyChecking accept-new',
      ''
    ].join('\n'))
    expect(renderKnownHosts([entry])).toBe('devtool-0123456789ab ssh-ed25519 AAAAC3Nza\ndevtool-0123456789ab ssh-rsa AAAAB3==\n')
  })

  it('finds an existing Include in any form ssh reads', () => {
    const target = '/Users/me/.devtool/ssh/config'
    expect(hasInclude(`Include ${target}\n`, target, '/Users/me')).toBe(true)
    expect(hasInclude('  include ~/.devtool/ssh/config other\n', target, '/Users/me')).toBe(true)
    expect(hasInclude(`Include "${target}"\n`, target, '/Users/me')).toBe(true)
    expect(hasInclude('Include=$HOME/.devtool/ssh/config\n', target, '/Users/me')).toBe(true)
    expect(hasInclude('# Include /Users/me/.devtool/ssh/config\n', target, '/Users/me')).toBe(false)
    expect(hasInclude('Include /Users/me/.devtool-dev/ssh/config\n', target, '/Users/me')).toBe(false)
  })

  it('creates the user\'s ssh config (dir 0700, file 0600) when there is none', () => {
    const home = tempHome()
    const userConfig = path.join(home, '.ssh', 'config')
    const target = path.join(home, '.devtool', 'ssh', 'config')
    expect(ensureUserSshInclude(userConfig, target, { home })).toEqual({ changed: true, created: true })
    expect(fs.readFileSync(userConfig, 'utf8')).toBe(`${INCLUDE_COMMENT}\nInclude ${target}\n`)
    expect(mode(path.dirname(userConfig))).toBe(0o700)
    expect(mode(userConfig)).toBe(0o600)
    expect(ensureUserSshInclude(userConfig, target, { home })).toEqual({ changed: false, created: false })
  })

  it('puts the Include at the very top of an existing config, once, after a backup', () => {
    const home = tempHome()
    const userConfig = path.join(home, '.ssh', 'config')
    const target = path.join(home, '.devtool', 'ssh', 'config')
    fs.mkdirSync(path.dirname(userConfig), { mode: 0o700 })
    const original = 'Host *\n  ServerAliveInterval 30\n'
    fs.writeFileSync(userConfig, original, { mode: 0o644 })
    const result = ensureUserSshInclude(userConfig, target, { home, now: new Date('2026-10-09T12:34:56Z') })
    expect(result).toEqual({ changed: true, created: false, backup: `${userConfig}.devtool-backup-20261009-123456` })
    expect(fs.readFileSync(result.backup!, 'utf8')).toBe(original)
    expect(fs.readFileSync(userConfig, 'utf8')).toBe(`${INCLUDE_COMMENT}\nInclude ${target}\n\n${original}`)
    expect(mode(userConfig)).toBe(0o644)
    expect(ensureUserSshInclude(userConfig, target, { home }).changed).toBe(false)
    expect(fs.readdirSync(path.dirname(userConfig)).filter((f) => f.includes('backup'))).toHaveLength(1)
  })

  it('writes through a symlinked config (dotfiles), leaving the link', () => {
    const home = tempHome()
    const real = path.join(home, 'dotfiles', 'ssh_config')
    fs.mkdirSync(path.dirname(real), { recursive: true })
    fs.writeFileSync(real, 'Host a\n  User b\n')
    fs.mkdirSync(path.join(home, '.ssh'))
    const userConfig = path.join(home, '.ssh', 'config')
    fs.symlinkSync(real, userConfig)
    const target = path.join(home, '.devtool', 'ssh', 'config')
    ensureUserSshInclude(userConfig, target, { home })
    expect(fs.lstatSync(userConfig).isSymbolicLink()).toBe(true)
    expect(fs.readFileSync(real, 'utf8')).toContain(`Include ${target}`)
  })

  it('reads back as ssh means it (ssh -G), where ssh is installed', () => {
    const home = tempHome()
    const devtoolConfig = path.join(home, 'devtool-ssh-config')
    fs.writeFileSync(devtoolConfig, renderHostBlock(entry, `/usr/bin/nc -U ${path.join(home, 'ssh.sock')}`, paths))
    const userConfig = path.join(home, 'config')
    fs.writeFileSync(userConfig, 'Host *\n  User someone-else\n  ServerAliveInterval 15\n')
    ensureUserSshInclude(userConfig, devtoolConfig, { home })
    let out: string
    try {
      out = execFileSync('ssh', ['-G', '-F', userConfig, 'devtool-0123456789ab'], { encoding: 'utf8' })
    } catch {
      return // no ssh client here
    }
    expect(out).toMatch(/^user dev$/m)
    expect(out).toMatch(/^hostkeyalias devtool-0123456789ab$/m)
    expect(out).toMatch(/^hostname devtool-0123456789ab\.invalid$/m)
    expect(out).toMatch(new RegExp(`^proxycommand /usr/bin/nc -U ${path.join(home, 'ssh.sock').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'))
    expect(out).toMatch(/^serveraliveinterval 15$/m)
  })
})
