import { execFile } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { detectAgentClis, findAgentCli } from '../src/main/agent-clis'
import { AGENT_INSTALLERS, agentInstallScript, installScript, versionFrom } from '../src/shared/agent-clis'
import { registerHostAgentHandlers } from '../src/main/ipc/host-agents'
import type { IpcRegistrar } from '../src/main/ipc/registrar'
import { getShellEnv, resetShellEnvForTests, resolveShellEnv } from '../src/main/shell-env'

const dirs: string[] = []
afterEach(() => {
  resetShellEnvForTests()
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'devtool-agent-clis-')))
  dirs.push(dir)
  return dir
}

function writeExecutable(file: string, body: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 })
}

const noOverrides = { claudeCommand: '', codexCommand: '', piCommand: '' }

function runSh(script: string): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    execFile('/bin/sh', ['-c', script], (err, stdout) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout })
    })
  })
}

describe('agent CLI detection', () => {
  it('reads the version out of what each CLI prints', () => {
    expect(versionFrom('2.1.295 (Claude Code)\n')).toBe('2.1.295')
    expect(versionFrom('codex-cli 0.158.0')).toBe('0.158.0')
    expect(versionFrom('v0.80.10')).toBe('0.80.10')
    expect(versionFrom('1.2.3-beta.4 build')).toBe('1.2.3-beta.4')
    expect(versionFrom('no version here')).toBeNull()
  })

  it.skipIf(process.platform === 'win32')('finds a CLI on a PATH, skipping folders where it isn\'t executable', () => {
    const root = tempDir()
    writeExecutable(path.join(root, 'b/claude'), 'echo b')
    fs.mkdirSync(path.join(root, 'a'))
    fs.writeFileSync(path.join(root, 'a/claude'), 'not executable', { mode: 0o644 })
    const env = { PATH: `${root}/a:${root}/missing::${root}/b` }
    expect(findAgentCli('claude', env, 'linux')).toBe(path.join(root, 'b/claude'))
    expect(findAgentCli('codex', env, 'linux')).toBeNull()
    expect(findAgentCli(path.join(root, 'b/claude'), {}, 'linux')).toBe(path.join(root, 'b/claude'))
    expect(findAgentCli(path.join(root, 'a/claude'), {}, 'linux')).toBeNull()
    expect(findAgentCli('', env, 'linux')).toBeNull()
  })

  it.skipIf(process.platform === 'win32')('reports claude, codex and pi on the login PATH with their versions', async () => {
    const root = tempDir()
    writeExecutable(path.join(root, 'bin/claude'), 'echo "2.1.0 (Claude Code)"')
    writeExecutable(path.join(root, 'bin/pi'), 'exit 1')
    const report = await detectAgentClis({ env: { PATH: `${root}/bin:/usr/bin:/bin` }, config: noOverrides, platform: 'linux' }, () => 42)
    expect(report).toEqual({
      platform: 'linux',
      checkedAt: 42,
      clis: {
        claude: { found: true, path: path.join(root, 'bin/claude'), version: '2.1.0' },
        codex: { found: false },
        // It is there; `--version` failing only costs the version.
        pi: { found: true, path: path.join(root, 'bin/pi') }
      }
    })
  })

  it('looks where Settings points, and doesn\'t wait forever for a version', async () => {
    const seen: string[] = []
    const report = await detectAgentClis({
      env: { PATH: '/nowhere' },
      config: { ...noOverrides, codexCommand: '/opt/codex/bin/codex' },
      platform: 'linux',
      isExecutable: (file) => file === '/opt/codex/bin/codex',
      runVersion: async (file) => { seen.push(file); return null }
    })
    expect(report.clis.codex).toEqual({ found: true, path: '/opt/codex/bin/codex' })
    expect(report.clis.claude.found).toBe(false)
    expect(seen).toEqual(['/opt/codex/bin/codex'])
  })

  it.skipIf(process.platform === 'win32')('sees a CLI an installer added once the login env is read again', async () => {
    const home = tempDir()
    const shell = path.join(home, 'login-shell')
    // Ubuntu's ~/.profile: ~/.local/bin goes on the PATH only if it exists at login.
    writeExecutable(shell, `PATH=/usr/bin:/bin; if [ -d "${home}/.local/bin" ]; then PATH="${home}/.local/bin:$PATH"; fi; export PATH; exec env -0`)
    const env: NodeJS.ProcessEnv = { SHELL: shell, PATH: '/usr/bin:/bin' }
    await resolveShellEnv({ env })
    const detect = () => detectAgentClis({ env: getShellEnv({ env }), config: noOverrides, platform: 'linux' })
    expect((await detect()).clis.claude.found).toBe(false)

    writeExecutable(path.join(home, '.local/bin/claude'), 'echo "3.0.0 (Claude Code)"')
    expect((await detect()).clis.claude.found).toBe(false)
    await resolveShellEnv({ env })
    expect((await detect()).clis.claude).toEqual({ found: true, path: path.join(home, '.local/bin/claude'), version: '3.0.0' })
  })

  it('serves both host channels, whatever host the router named', async () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>()
    const registrar: IpcRegistrar = {
      handle: (channel, _schema, handler) => { handlers.set(channel, handler as unknown as (...args: unknown[]) => unknown) },
      on: () => {},
      onSync: () => {}
    }
    let refreshed = 0
    registerHostAgentHandlers(registrar, {
      detect: async () => ({ clis: { claude: { found: true }, codex: { found: false }, pi: { found: false } }, platform: 'linux', checkedAt: 1 }),
      refreshEnv: async () => { refreshed += 1; return { path: '/new' } }
    })
    expect(await handlers.get('host-refresh-env')!({}, 'srv')).toEqual({ path: '/new' })
    expect(refreshed).toBe(1)
    expect(await handlers.get('host-agent-clis')!({}, 'local')).toMatchObject({ platform: 'linux' })
  })
})

describe('agent installers', () => {
  it('are the official one-liners, with nothing that would break the install script\'s quoting', () => {
    expect(AGENT_INSTALLERS.claude.command).toBe('curl -fsSL https://claude.ai/install.sh | bash')
    expect(AGENT_INSTALLERS.codex.command).toBe('curl -fsSL https://chatgpt.com/codex/install.sh | CODEX_NON_INTERACTIVE=1 sh')
    expect(AGENT_INSTALLERS.pi.command).toBe('curl -fsSL https://pi.dev/install.sh | sh')
    for (const { command } of Object.values(AGENT_INSTALLERS)) expect(command).not.toContain("'")
    expect(agentInstallScript('claude')).toContain("cmd='curl -fsSL https://claude.ai/install.sh | bash'")
  })

  it.skipIf(process.platform === 'win32')('shows the command, runs it and exits with its status, a failed download included', async () => {
    const ok = await runSh(installScript('echo installing', 'Fake'))
    expect(ok.code).toBe(0)
    expect(ok.stdout).toContain('$ echo installing')
    expect(ok.stdout).toContain('installing\n')
    expect(ok.stdout).toContain('Fake installer finished')

    const failed = await runSh(installScript('exit 3', 'Fake'))
    expect(failed.code).toBe(3)
    expect(failed.stdout).toContain('Fake installer failed with exit code 3.')

    // `curl -f … | bash` with curl failing: bash gets nothing and "succeeds" without pipefail.
    const piped = await runSh(installScript("false | sh -c 'cat >/dev/null'", 'Fake'))
    expect(piped.code).toBe(1)
  })
})
