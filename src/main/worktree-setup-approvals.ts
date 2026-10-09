import fs from 'fs'
import path from 'path'

/**
 * Which `.devtool/worktree.json` contents the user has allowed to run `setup`
 * commands. The commands come from the repository, so a clone (or a pulled
 * commit) must not run code on its own: each repo's config is approved by its
 * exact content (sha256 of the file), and an edit asks again.
 *
 * Kept in DevTool's config dir, never in the repo. Keyed by the repo's git
 * common dir, which every worktree of it shares.
 */
export interface SetupApprovals {
  isApproved(repoKey: string, hash: string): boolean
  approve(repoKey: string, hash: string): void
}

/** Per repo, a stream branch may carry a different config than main; keep a few approved versions. */
const MAX_HASHES_PER_REPO = 20

interface ApprovalsFile {
  version: 1
  /** repoKey -> approved hashes, oldest first. */
  repos: Record<string, string[]>
}

export const SETUP_APPROVALS_FILE = 'worktree-setup-approvals.json'

/** `<config dir>/worktree-setup-approvals.json`. An unreadable file approves nothing. */
export class FileSetupApprovals implements SetupApprovals {
  private readonly file: string

  constructor(configDir: string) {
    this.file = path.join(configDir, SETUP_APPROVALS_FILE)
  }

  isApproved(repoKey: string, hash: string): boolean {
    return this.load().repos[repoKey]?.includes(hash) ?? false
  }

  approve(repoKey: string, hash: string): void {
    const data = this.load()
    const hashes = (data.repos[repoKey] ?? []).filter(h => h !== hash)
    hashes.push(hash)
    data.repos[repoKey] = hashes.slice(-MAX_HASHES_PER_REPO)
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    const tmp = `${this.file}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8')
    fs.renameSync(tmp, this.file)
  }

  private load(): ApprovalsFile {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Partial<ApprovalsFile>
      if (parsed?.version !== 1 || typeof parsed.repos !== 'object' || parsed.repos === null) return { version: 1, repos: {} }
      const repos: Record<string, string[]> = {}
      for (const [key, value] of Object.entries(parsed.repos)) {
        if (Array.isArray(value)) repos[key] = value.filter((h): h is string => typeof h === 'string')
      }
      return { version: 1, repos }
    } catch {
      return { version: 1, repos: {} }
    }
  }
}

/** Approvals that live as long as the object; tests, and the default when no store is wired. */
export class MemorySetupApprovals implements SetupApprovals {
  private readonly approved = new Set<string>()

  isApproved(repoKey: string, hash: string): boolean {
    return this.approved.has(`${repoKey}\0${hash}`)
  }

  approve(repoKey: string, hash: string): void {
    this.approved.add(`${repoKey}\0${hash}`)
  }
}
