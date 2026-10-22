import fs from 'fs'
import os from 'os'
import path from 'path'

/**
 * Moves `fullPath` to the user's Trash the freedesktop.org way (what GNOME's and
 * KDE's file managers read): `$XDG_DATA_HOME/Trash/files/<name>` plus a
 * `.trashinfo` saying where it came from. For a DevTool server, which has no
 * Electron `shell.trashItem`. The Trash must be on the same file system: a
 * cross-device move fails rather than copying a whole project.
 */
export async function freedesktopTrash(fullPath: string, env: NodeJS.ProcessEnv = process.env, homeDir: string = os.homedir()): Promise<void> {
  const trash = path.join(env.XDG_DATA_HOME || path.join(homeDir, '.local', 'share'), 'Trash')
  const filesDir = path.join(trash, 'files')
  const infoDir = path.join(trash, 'info')
  await fs.promises.mkdir(filesDir, { recursive: true })
  await fs.promises.mkdir(infoDir, { recursive: true })

  const base = path.basename(fullPath)
  // Claim a free name through its .trashinfo (`wx`), as the spec asks.
  let name = base
  for (let n = 2; ; n++) {
    try {
      await fs.promises.writeFile(path.join(infoDir, `${name}.trashinfo`), trashInfo(fullPath), { flag: 'wx' })
      break
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST' || n > 1000) throw err
      name = `${base}.${n}`
    }
  }
  try {
    await fs.promises.rename(fullPath, path.join(filesDir, name))
  } catch (err) {
    await fs.promises.rm(path.join(infoDir, `${name}.trashinfo`), { force: true })
    if ((err as NodeJS.ErrnoException).code === 'EXDEV') {
      throw new Error(`${fullPath} is on another disk than the Trash (${trash}); move or delete it by hand.`, { cause: err })
    }
    throw err
  }
}

function trashInfo(fullPath: string): string {
  const encoded = fullPath.split('/').map(encodeURIComponent).join('/')
  const date = new Date().toISOString().slice(0, 19)
  return `[Trash Info]\nPath=${encoded}\nDeletionDate=${date}\n`
}
