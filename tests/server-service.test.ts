import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync, spawnSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { serverPaths } from '../src/server/server-env'
import {
  editCrontab,
  installService,
  launchdLabel,
  readServiceRecord,
  removeService,
  renderCliWrapper,
  renderCronLine,
  renderLaunchdPlist,
  renderSystemdUnit,
  serviceSuffix,
  systemdUnitName,
  type CommandResult,
  type ServiceContext
} from '../src/server/service'

const dirs: string[] = []
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devtool-service-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

/** A ServiceContext whose commands are answered by `answer` and recorded. */
function fakeContext(platform: NodeJS.Platform, answer: (command: string, args: string[]) => Partial<CommandResult>, suffix = '.test'): { ctx: ServiceContext; calls: string[]; inputs: string[] } {
  const userHome = tempDir()
  const paths = serverPaths({ DEVTOOL_SERVER_HOME: path.join(userHome, '.devtool-server') })
  const calls: string[] = []
  const inputs: string[] = []
  const ctx: ServiceContext = {
    paths,
    suffix,
    platform,
    uid: 501,
    user: 'join3r',
    userHome,
    log: () => {},
    run: async (command, args, options) => {
      calls.push([command, ...args].join(' '))
      if (options?.input !== undefined) inputs.push(options.input)
      return { code: 0, stdout: '', stderr: '', ...answer(command, args) }
    }
  }
  return { ctx, calls, inputs }
}

describe('service names', () => {
  it('suffixes test installs and sanitizes the suffix', () => {
    expect(serviceSuffix({})).toBe('')
    expect(serviceSuffix({ DEVTOOL_SERVER_SERVICE_SUFFIX: 'dev' })).toBe('.dev')
    expect(serviceSuffix({ DEVTOOL_SERVER_SERVICE_SUFFIX: '.dev' })).toBe('.dev')
    expect(serviceSuffix({ DEVTOOL_SERVER_SERVICE_SUFFIX: 'a b/c;d' })).toBe('.abcd')
    expect(launchdLabel('')).toBe('sk.awantech.devtool-server')
    expect(launchdLabel('.dev')).toBe('sk.awantech.devtool-server.dev')
    expect(systemdUnitName('')).toBe('devtool-server.service')
    expect(systemdUnitName('.dev')).toBe('devtool-server-dev.service')
  })
})

describe('service files', () => {
  const paths = serverPaths({ DEVTOOL_SERVER_HOME: '/home/u/my %server' })

  it('renders a systemd user unit that restarts forever and quotes its paths', () => {
    const unit = renderSystemdUnit(paths)
    expect(unit).toContain('ExecStart="/home/u/my %%server/node/current/bin/node" "/home/u/my %%server/current/main.js"')
    expect(unit).toContain('Environment="DEVTOOL_SERVER_HOME=/home/u/my %%server"')
    expect(unit).toContain('Environment=DEVTOOL_SERVER_SUPERVISOR=systemd')
    expect(unit).toMatch(/^Restart=always$/m)
    expect(unit).toMatch(/^SuccessExitStatus=75$/m)
    expect(unit).toMatch(/^StartLimitIntervalSec=0$/m)
    expect(unit).toMatch(/^KillMode=mixed$/m)
    expect(unit).toMatch(/^WantedBy=default.target$/m)
    // The service gets no install token: only its home and how it is supervised.
    expect(unit).not.toContain('TOKEN')
    expect(renderLaunchdPlist(paths, 'l', '/home/u')).not.toContain('TOKEN')
  })

  it('renders a LaunchAgent plist that restarts after a failed exit and logs to a file', () => {
    const plist = renderLaunchdPlist(serverPaths({ DEVTOOL_SERVER_HOME: '/Users/u/a&b' }), 'sk.awantech.devtool-server.dev', '/Users/u')
    expect(plist).toContain('<key>Label</key><string>sk.awantech.devtool-server.dev</string>')
    expect(plist).toContain('<string>/Users/u/a&amp;b/node/current/bin/node</string><string>/Users/u/a&amp;b/current/main.js</string>')
    expect(plist).toContain('<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>')
    expect(plist).toContain('<key>DEVTOOL_SERVER_LOG</key><string>file</string>')
    expect(plist).toContain('<key>RunAtLoad</key><true/>')
    if (process.platform === 'darwin') {
      const file = path.join(tempDir(), 'x.plist')
      fs.writeFileSync(file, plist)
      expect(execFileSync('plutil', ['-lint', file]).toString()).toContain('OK')
    }
  })

  it('edits only its own crontab line', () => {
    const line = renderCronLine(serverPaths({ DEVTOOL_SERVER_HOME: "/home/u/it's" }), '.dev')
    expect(line).toBe("@reboot DEVTOOL_SERVER_HOME='/home/u/it'\\''s' '/home/u/it'\\''s/bin/devtool-server' start # devtool-server.dev")
    const mine = editCrontab('MAILTO=me\n0 * * * * backup\n', '.dev', line)
    expect(mine).toBe(`MAILTO=me\n0 * * * * backup\n${line}\n`)
    expect(editCrontab(mine, '.dev', line)).toBe(mine)
    expect(editCrontab(mine, '', null)).toBe(mine)
    expect(editCrontab(mine, '.dev', null)).toBe('MAILTO=me\n0 * * * * backup\n')
    expect(editCrontab(`${line}\n`, '.dev', null)).toBe('')
  })

  it('writes a CLI wrapper that sh accepts', () => {
    const wrapper = renderCliWrapper(serverPaths({ DEVTOOL_SERVER_HOME: '/home/u/a"b$c' }))
    expect(wrapper).toContain('DEVTOOL_SERVER_HOME="${DEVTOOL_SERVER_HOME:-/home/u/a\\"b\\$c}"')
    const file = path.join(tempDir(), 'devtool-server')
    fs.writeFileSync(file, wrapper)
    expect(spawnSync('sh', ['-n', file]).status).toBe(0)
  })
})

describe('installing the service', () => {
  it('Linux with a user systemd: writes, enables and starts the unit, and prints the sudo line when linger is refused', async () => {
    const { ctx, calls } = fakeContext('linux', (command, args) => {
      if (command === 'loginctl' && args[0] === 'enable-linger') return { code: 1, stderr: 'Access denied' }
      if (command === 'loginctl') return { stdout: 'no\n' }
      return {}
    })
    const result = await installService(ctx)
    const unitFile = path.join(ctx.userHome, '.config/systemd/user/devtool-server-test.service')
    expect(result.record).toMatchObject({ kind: 'systemd', name: 'devtool-server-test.service', file: unitFile, suffix: '.test' })
    expect(fs.readFileSync(unitFile, 'utf8')).toContain('Restart=always')
    expect(calls).toEqual(expect.arrayContaining([
      'systemctl --user show-environment',
      'systemctl --user daemon-reload',
      'systemctl --user enable devtool-server-test.service',
      'systemctl --user restart devtool-server-test.service',
      'loginctl enable-linger join3r'
    ]))
    expect(result.notes.join('\n')).toContain('sudo loginctl enable-linger join3r')
    expect(fs.statSync(path.join(ctx.paths.binDir, 'devtool-server')).mode & 0o111).not.toBe(0)
    expect(readServiceRecord(ctx.paths)).toMatchObject({ kind: 'systemd' })

    await removeService(ctx, result.record, { stop: true })
    expect(fs.existsSync(unitFile)).toBe(false)
    expect(calls).toContain('systemctl --user disable --now devtool-server-test.service')
    expect(readServiceRecord(ctx.paths)).toBeNull()
  })

  it('Linux with linger already on says nothing about it', async () => {
    const { ctx, calls } = fakeContext('linux', (command) => (command === 'loginctl' ? { stdout: 'yes\n' } : {}))
    const result = await installService(ctx)
    expect(result.notes).toEqual([])
    expect(calls).not.toContain('loginctl enable-linger join3r')
  })

  it('macOS: loads the LaunchAgent into gui/<uid>, or user/<uid> when there is no GUI session', async () => {
    const gui = fakeContext('darwin', () => ({}))
    const result = await installService(gui.ctx)
    expect(result.record).toMatchObject({ kind: 'launchd', name: 'sk.awantech.devtool-server.test', domain: 'gui/501' })
    expect(gui.calls).toContain(`launchctl bootstrap gui/501 ${path.join(gui.ctx.userHome, 'Library/LaunchAgents/sk.awantech.devtool-server.test.plist')}`)

    const ssh = fakeContext('darwin', (command, args) => (command === 'launchctl' && args[0] === 'bootstrap' && args[1] === 'gui/501' ? { code: 5, stderr: 'Bootstrap failed: 125: Domain does not support specified action' } : {}))
    const fallback = await installService(ssh.ctx)
    expect(fallback.record.domain).toBe('user/501')
    expect(fallback.notes.join('\n')).toMatch(/background user domain \(user\/501\)/)
    // The user domain only takes Background-session jobs.
    expect(fs.readFileSync(fallback.record.file!, 'utf8')).toContain('<key>LimitLoadToSessionType</key><string>Background</string>')
    expect(fs.readFileSync(result.record.file!, 'utf8')).not.toContain('LimitLoadToSessionType')

    const chosen = fakeContext('darwin', () => ({}))
    chosen.ctx.launchdDomain = 'user'
    expect((await installService(chosen.ctx)).record.domain).toBe('user/501')
    expect(chosen.calls.filter((c) => c.startsWith('launchctl bootstrap'))).toEqual([`launchctl bootstrap user/501 ${path.join(chosen.ctx.userHome, 'Library/LaunchAgents/sk.awantech.devtool-server.test.plist')}`])
  })

  it('Linux without systemd: an @reboot crontab line next to the user\'s own, and a background process', async () => {
    const { ctx, calls, inputs } = fakeContext('linux', (command, args) => {
      if (command === 'systemctl') return { code: 127 }
      if (command === 'crontab' && args[0] === '-l') return { stdout: '0 3 * * * backup\n' }
      return {}
    })
    const result = await installService(ctx)
    expect(result.record).toMatchObject({ kind: 'nohup', file: null })
    expect(calls).toContain('crontab -')
    expect(inputs[0]).toBe(`0 3 * * * backup\n${renderCronLine(ctx.paths, '.test')}\n`)
    expect(result.notes[0]).toMatch(/no user systemd/)
  })

  it('Linux without systemd or crontab says how to start it after a reboot', async () => {
    const { ctx } = fakeContext('linux', () => ({ code: 127 }))
    const result = await installService(ctx)
    expect(result.notes.join('\n')).toMatch(/devtool-server start/)
  })
})
