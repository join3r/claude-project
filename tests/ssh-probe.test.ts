import { describe, expect, it } from 'vitest'
import { buildSshProbeArgs, probeSshHost } from '../src/main/servers/ssh-probe'
import { SSH_PROBE_MARKER, sshProbeScript } from '../src/shared/project-move'
import type { SshConfig } from '../src/shared/types'

const SSH: SshConfig = { host: 'orb', port: 22, username: 'devtool-srv-test', remoteDir: '/home/join3r/repo' }

describe('probing an SSH project\'s machine', () => {
  it('goes through the project\'s ControlMaster when it is up, and never asks for anything', () => {
    expect(buildSshProbeArgs(SSH, '/cfg/ssh/p.sock')).toEqual([
      '-S', '/cfg/ssh/p.sock', '-o', 'ControlMaster=no',
      '-o', 'StrictHostKeyChecking=accept-new',
      '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-T', '-p', '22',
      'devtool-srv-test@orb', sshProbeScript()
    ])
    const fresh = buildSshProbeArgs({ ...SSH, port: 2222, keyFile: '/k/id' }, null)
    expect(fresh).not.toContain('-S')
    expect(fresh.slice(-5)).toEqual(['2222', '-i', '/k/id', 'devtool-srv-test@orb', sshProbeScript()])
  })

  it('answers what the host said, or why ssh could not ask it', async () => {
    const ok = await probeSshHost(SSH, {
      controlPath: null,
      sshCommand: 'ssh',
      run: async () => ({ stdout: `${SSH_PROBE_MARKER}\nhost=box\nuser=me\ninstalled=0\n`, stderr: '' })
    })
    expect(ok).toEqual({ ok: true, probe: { hostname: 'box', user: 'me', installed: false } })
    const refused = await probeSshHost(SSH, {
      controlPath: null,
      sshCommand: 'ssh',
      run: async () => { throw Object.assign(new Error('Command failed'), { stderr: 'banner\nme@box: Permission denied (publickey,password).\n' }) }
    })
    expect(refused).toEqual({ ok: false, error: 'me@box: Permission denied (publickey,password).' })
    const garbled = await probeSshHost(SSH, { controlPath: null, sshCommand: 'ssh', run: async () => ({ stdout: 'hello', stderr: '' }) })
    expect(garbled.ok).toBe(false)
  })
})
