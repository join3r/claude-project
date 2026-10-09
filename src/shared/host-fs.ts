/**
 * Answers of the host channels that add a project to a host (a DevTool server,
 * or this desktop): `server-list-dirs`, `server-discover-repos` and
 * `server-clone-repo`. The first argument of each names the host (`local` or a
 * server id) for the desktop's router.
 */

export interface HostDirEntry {
  name: string
  /** Absolute, on the host. */
  path: string
  /** Has a `.git`. */
  git: boolean
}

export interface HostDirListing {
  /** The folder listed (absolute, `~` expanded). */
  path: string
  /** Null at the file system's root. */
  parent: string | null
  /** The host user's home dir. */
  home: string
  /** The listed folder itself has a `.git`. */
  git: boolean
  /** Its folders, by name. */
  entries: HostDirEntry[]
}

export interface HostRepoDiscovery {
  root: string
  repos: Array<{ name: string; path: string }>
  /** The walk hit its time or count limit; there may be more. */
  truncated: boolean
}

export interface HostCloneResult {
  /** The new clone's folder. */
  path: string
  name: string
}

/** The `server-clone-progress` push: one line of git's progress for the clone `opId`. */
export const CLONE_PROGRESS_CHANNEL = 'server-clone-progress'
