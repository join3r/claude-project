import { spawn } from 'child_process'
import fs from 'fs'
import net from 'net'
import os from 'os'
import path from 'path'
import { atomicWriteFileSync } from '../atomic-write'
import { shellWord } from './ssh-config'

/**
 * How ssh reaches the desktop's socket for a server: `nc -U <socket>` where nc
 * speaks Unix sockets (macOS, OpenBSD netcat on Debian and Ubuntu), else a tiny
 * Node script run by this app's own binary as Node (`ELECTRON_RUN_AS_NODE`).
 * GNU and busybox netcat have no `-U`, and nmap's ncat reads `-U` as UDP, so nc
 * is tried for real against a scratch socket rather than trusted by name.
 */

const NC_CANDIDATES = ['/usr/bin/nc', '/bin/nc', '/usr/local/bin/nc', '/opt/homebrew/bin/nc']
const PROBE_TIMEOUT_MS = 2000
export const NODE_PROXY_SCRIPT = 'devtool-ssh-proxy.cjs'

/** The fallback ProxyCommand's script: pipes ssh's stdin and stdout to the socket in argv[2]. */
export const NODE_PROXY_SOURCE = `// Written by DevTool: ssh's ProxyCommand for Open in IDE on a DevTool server.
'use strict'
const net = require('net')
const socket = net.connect(process.argv[2])
process.stdin.pipe(socket)
socket.pipe(process.stdout)
socket.on('error', (err) => {
  process.stderr.write('devtool-ssh-proxy: ' + err.message + ' (is DevTool running?)\\n')
  process.exit(1)
})
socket.on('close', () => process.exit(0))
`

/** Whether `nc` connects to a Unix socket with `-U`, tried against a scratch listener. */
export async function ncSpeaksUnix(nc: string, timeoutMs = PROBE_TIMEOUT_MS): Promise<boolean> {
  if (!fs.existsSync(nc)) return false
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dt-nc-'))
  const socket = path.join(dir, 'p.sock')
  const server = net.createServer()
  try {
    const connected = new Promise<boolean>((resolve) => {
      server.once('connection', (conn) => {
        conn.destroy()
        resolve(true)
      })
      setTimeout(() => resolve(false), timeoutMs).unref()
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(socket, () => resolve())
    })
    const child = spawn(nc, ['-U', socket], { stdio: ['pipe', 'ignore', 'ignore'] })
    child.on('error', () => {})
    // An nc without -U exits at once with a usage error; one that connected may
    // have its exit seen first, so a connection still gets a moment to land.
    const exited = new Promise<boolean>((resolve) => child.once('exit', () => setTimeout(() => resolve(false), 150)))
    const ok = await Promise.race([connected, exited])
    child.kill()
    return ok
  } catch {
    return false
  } finally {
    server.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

/** The first nc that speaks Unix sockets, or null. */
export async function findUnixNc(candidates: string[] = NC_CANDIDATES, pathEnv = process.env.PATH ?? ''): Promise<string | null> {
  const seen = new Set<string>()
  const all = [...candidates, ...pathEnv.split(path.delimiter).filter(Boolean).map((dir) => path.join(dir, 'nc'))]
  for (const nc of all) {
    if (seen.has(nc)) continue
    seen.add(nc)
    if (await ncSpeaksUnix(nc)) return nc
  }
  return null
}

export type ProxyCommandFor = (socketPath: string) => string

/**
 * Builds the ProxyCommand for a socket: nc when it speaks Unix sockets, else the
 * Node script (written into `sshDir`) run by `execPath` as Node.
 */
export function proxyCommandFactory(options: { nc: string | null; execPath: string; sshDir: string }): ProxyCommandFor {
  if (options.nc) {
    const nc = options.nc
    return (socketPath) => `${shellWord(nc)} -U ${shellWord(socketPath)}`
  }
  const script = path.join(options.sshDir, NODE_PROXY_SCRIPT)
  atomicWriteFileSync(script, NODE_PROXY_SOURCE, 0o600)
  // `exec VAR=1 cmd` isn't a thing (ssh runs `exec <ProxyCommand>`), so env sets it.
  return (socketPath) => `/usr/bin/env ELECTRON_RUN_AS_NODE=1 ${shellWord(options.execPath)} ${shellWord(script)} ${shellWord(socketPath)}`
}
