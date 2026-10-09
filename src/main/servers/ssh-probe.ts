import { parseSshProbe, sshProbeScript } from '../../shared/project-move'
import type { SshHostProbeResult } from '../../shared/servers'
import type { SshConfig } from '../../shared/types'
import { sshTrustArgs } from '../ssh-connection-manager'

export type RunSsh = (file: string, args: string[], options: { timeout: number }) => Promise<{ stdout: string; stderr: string }>

/**
 * ssh's arguments for the probe of an SSH project's machine. Through the
 * project's ControlMaster when it is up (no new login); otherwise a fresh
 * connection that never asks anything (`BatchMode`): a host that needs a
 * password just answers "no probe", and the dialog asks the user instead.
 */
export function buildSshProbeArgs(ssh: SshConfig, controlPath: string | null): string[] {
  const args = [
    ...(controlPath ? ['-S', controlPath, '-o', 'ControlMaster=no'] : []),
    ...sshTrustArgs(),
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=10',
    '-T',
    '-p', String(ssh.port || 22)
  ]
  if (ssh.keyFile) args.push('-i', ssh.keyFile)
  args.push(`${ssh.username}@${ssh.host}`, sshProbeScript())
  return args
}

/** Asks an SSH project's machine about itself and any DevTool server installed there. */
export async function probeSshHost(
  ssh: SshConfig,
  options: { controlPath: string | null; sshCommand: string; run: RunSsh }
): Promise<SshHostProbeResult> {
  try {
    const { stdout } = await options.run(options.sshCommand, buildSshProbeArgs(ssh, options.controlPath), { timeout: 20_000 })
    const probe = parseSshProbe(stdout)
    return probe ? { ok: true, probe } : { ok: false, error: 'The host gave no answer DevTool understands.' }
  } catch (err) {
    const stderr = (err as { stderr?: unknown }).stderr
    const detail = typeof stderr === 'string' && stderr.trim() ? stderr.trim().split('\n').pop()! : err instanceof Error ? err.message : String(err)
    return { ok: false, error: detail.slice(0, 300) }
  }
}
