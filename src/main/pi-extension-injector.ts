import fs from 'fs'

/**
 * Injection helpers for the pi status extension (resources/pi-status-extension.mjs).
 *
 * Unlike Claude (which mutates the project's .claude/settings.local.json), pi loads
 * our status extension via a `-e <path>` CLI flag. Locally that path is the file the
 * build copies next to the main bundle (`HostEnv.resourcePath`); remotely we
 * base64-write the same file under the remote home (reusing the SSH command channel,
 * exactly like Claude's remote hooks).
 */

/** The extension's file name next to the main bundle. */
export const PI_EXTENSION_RESOURCE = 'pi-status-extension.mjs'

/** Remote dir (under $HOME) for the copied extension. Mode 0700 on the remote. */
export const PI_REMOTE_EXTENSION_DIR = '.devtool-remote'

export const PI_REMOTE_EXTENSION_FILE = 'pi-status-extension.mjs'

/**
 * Path expression the remote bash login shell expands. Must not be single-quoted
 * in `buildSpawnArgs` or `$HOME` stays literal.
 */
export function piExtensionRemotePath(): string {
  return `$HOME/${PI_REMOTE_EXTENSION_DIR}/${PI_REMOTE_EXTENSION_FILE}`
}

/** Shell-quote a value for safe interpolation into a remote shell command. */
function shellQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'"
}

/**
 * Build a shell script that writes the pi status extension under the remote home.
 * Uses $HOME (not /tmp) so a shared host cannot plant the file via a world-writable
 * directory. `chmod 700` makes the dir owner-only.
 */
export function buildRemotePiExtensionScript(sourcePath: string): string {
  const b64 = fs.readFileSync(sourcePath).toString('base64')
  const dirExpr = `"$HOME/${PI_REMOTE_EXTENSION_DIR}"`
  const homeRel = `~/${PI_REMOTE_EXTENSION_DIR}/${PI_REMOTE_EXTENSION_FILE}`
  return `mkdir -p ${dirExpr} && chmod 700 ${dirExpr} && python3 -c "
import base64, os
path = os.path.expanduser(${shellQuote(homeRel)})
open(path, 'wb').write(base64.b64decode('${b64}'))
"`
}
