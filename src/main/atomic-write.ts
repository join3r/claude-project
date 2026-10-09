import fs from 'fs'
import path from 'path'

/**
 * Write `data` to `target` so a crash leaves either the old file or the new one,
 * never a truncated mix: write a sibling temp file, fsync it, rename over the target.
 * Same directory so the rename stays on one filesystem (and is atomic on POSIX).
 */
export function atomicWriteFileSync(target: string, data: string, mode?: number): void {
  const tmp = `${target}.tmp-${process.pid}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
  let fd: number | null = null
  try {
    // `mode` applies from creation, so a secret is never briefly world-readable.
    fd = fs.openSync(tmp, 'w', mode)
    fs.writeSync(fd, data)
    fs.fsyncSync(fd)
    fs.closeSync(fd)
    fd = null
    renameWithRetry(tmp, target)
  } catch (err) {
    if (fd !== null) {
      try { fs.closeSync(fd) } catch { /* already failing */ }
    }
    try { fs.unlinkSync(tmp) } catch { /* may not exist */ }
    throw err
  }
  if (process.platform !== 'win32') {
    // Persist the rename itself. Best effort: some filesystems refuse fsync on a dir.
    try {
      const dirFd = fs.openSync(path.dirname(target), 'r')
      try { fs.fsyncSync(dirFd) } finally { fs.closeSync(dirFd) }
    } catch { /* ignore */ }
  }
}

function renameWithRetry(from: string, to: string): void {
  // On Windows a reader (antivirus, indexer) holding the target briefly makes the
  // replace fail with EPERM/EBUSY; a short retry clears nearly all of those.
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(from, to)
      return
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (process.platform !== 'win32' || attempt >= 4 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) {
        throw err
      }
      const until = Date.now() + 20 * (attempt + 1)
      while (Date.now() < until) { /* brief sync backoff */ }
    }
  }
}
