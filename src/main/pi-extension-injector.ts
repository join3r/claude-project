import fs from 'fs'
import path from 'path'

/**
 * Injection helpers for the pi status extension (resources/pi-status-extension.mjs).
 *
 * Unlike Claude (which mutates the project's .claude/settings.local.json), pi loads
 * our status extension via a `-e <path>` CLI flag. Locally that path is the file the
 * build copies next to the main bundle; remotely we base64-write the same file to the
 * remote host (reusing the SSH command channel, exactly like Claude's remote hooks).
 */

/**
 * Absolute path to the bundled pi status extension (copied to out/main at build time).
 *
 * In a packaged app __dirname lives inside app.asar, but pi is an external process that
 * can't read paths inside the asar archive — so the file is unpacked (see package.json
 * `asarUnpack`) and we point at its real on-disk location under app.asar.unpacked. In dev
 * there is no asar, so the replacement is a no-op.
 */
export function piExtensionLocalPath(): string {
  const p = path.join(__dirname, 'pi-status-extension.mjs')
  const packed = `app.asar${path.sep}`
  return p.includes(packed) ? p.replace(packed, `app.asar.unpacked${path.sep}`) : p
}

/** Deterministic remote path for the extension, unique per remote user to avoid /tmp clashes. */
export function piExtensionRemotePath(username: string): string {
  return `/tmp/devtool-${username}/pi-status-extension.mjs`
}

/** Shell-quote a value for safe interpolation into a remote shell command. */
function shellQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'"
}

/**
 * Build a shell script that writes the pi status extension to `remoteExtPath` on the
 * remote host. Mirrors hook-injector's base64 + python3 approach so it rides the same
 * SSH command prefix as the launch, with no extra round trips and no shell-quoting hazard.
 */
export function buildRemotePiExtensionScript(remoteExtPath: string): string {
  const b64 = fs.readFileSync(piExtensionLocalPath()).toString('base64')
  const dir = path.posix.dirname(remoteExtPath)
  return `mkdir -p ${shellQuote(dir)} && python3 -c "
import base64
open(${shellQuote(remoteExtPath)}, 'wb').write(base64.b64decode('${b64}'))
"`
}
