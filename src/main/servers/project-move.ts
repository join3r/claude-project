import type { ArchivedTask, ProjectArchive } from '../../shared/archive'
import type { HostDirListing } from '../../shared/host-fs'
import { canMoveToServer, projectTabIds, serverArchiveFrom, serverPathForRemoteDir, serverProjectFrom } from '../../shared/project-move'
import type { ProjectMoveResult } from '../../shared/servers'
import type { Project, ProjectsData, SshConfig } from '../../shared/types'

/** The part of ServerProjects a move uses. */
export interface MoveServerProjects {
  isOnline(serverId: string): boolean
  reserveIncoming(serverId: string, projectId: string): void
  endIncoming(projectId: string): void
  writeProjects(serverId: string, change: { add?: Project[]; remove?: string[] }): Promise<void>
}

export interface ProjectMoverDeps {
  /** This desktop's own projects and what goes with them. */
  local: {
    peek(): ProjectsData
    commit(data: ProjectsData): void
    archive(projectId: string): ProjectArchive
    /** Of these tabs, the ones with a process (PTY or chat) running here. */
    liveTabs(tabIds: string[]): string[]
    /**
     * End the project's tabs here: PTYs and chats stop without telling the
     * windows, Claude's hooks leave the remote settings (over the project's SSH
     * connection, still up), local scrollback and activity go.
     */
    endTabs(project: Project): Promise<void>
  }
  servers: MoveServerProjects
  /** A call on a server as desktop main (`main`), not as a window. */
  call(serverId: string, ch: string, args: unknown[]): Promise<unknown>
  /** The router's pins: a tab that ran here must not keep routing here. */
  unpin(tabId: string): void
  /**
   * Every window drops its copies of these tabs without ending anything (main
   * did); they mount again on the server. `resume`: agent tabs that were running,
   * which start again on their own there instead of waiting for a click.
   */
  tabsMoved(event: { tabIds: string[]; resume: string[] }): void
  /** Close the project's SSH connection: its ControlMaster, tunnel and SOCKS proxy. */
  closeSsh(projectId: string, ssh: SshConfig): Promise<void>
  log(message: string): void
}

/** At most this much archive per link call (a link message holds 4 MiB). */
const ARCHIVE_CHUNK_BYTES = 1024 * 1024

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Agent tabs that wait for a click before resuming a session (Claude Code, Pi): the rest start on their own. */
const LAZY_AGENT_TABS = new Set(['claude', 'pi'])

/**
 * Move to a DevTool server (plan step 11): an SSH project of this desktop
 * becomes a project of the server running on that same machine, with every id
 * kept. The order matters, because this desktop drops a server project whose
 * ids collide with its own, and routes a tab by whoever owns its id:
 *
 * 1. The server gets the project first, reserved (`reserveIncoming`), so it stays
 *    out of every window and of routing while the local copy exists, and is
 *    never dropped as a collision. Then the archive (tasks and streams closed
 *    over SSH) goes to the server's own archive, through the server's
 *    `archive-add-*` channels. Any failure up to here removes the project from
 *    the server again and leaves everything as it was.
 * 2. The windows drop their copies of the project's tabs; the local PTYs and
 *    chats end; the router's pins go.
 * 3. One local commit removes the SSH project. It still counts the server's copy
 *    as foreign, so the local order, pins and tags keep naming it, and the same
 *    commit reveals the server's copy to every window. Tabs mount again there,
 *    keyed by their new host, and spawn on the server.
 * 4. The project's SSH connection closes.
 */
export class ProjectMover {
  private readonly moving = new Set<string>()

  constructor(private readonly deps: ProjectMoverDeps) {}

  async move(projectId: string, serverId: string): Promise<ProjectMoveResult> {
    if (this.moving.has(projectId)) throw new Error('This project is already moving.')
    this.moving.add(projectId)
    try {
      return await this.run(projectId, serverId)
    } finally {
      this.moving.delete(projectId)
    }
  }

  private async run(projectId: string, serverId: string): Promise<ProjectMoveResult> {
    const { deps } = this
    const project = deps.local.peek().projects.find(p => p.id === projectId)
    if (!project) throw new Error('That project is gone.')
    if (!canMoveToServer(project) || !project.ssh) throw new Error('Only an SSH project can move to a DevTool server.')
    const ssh = project.ssh
    if (!deps.servers.isOnline(serverId)) throw new Error('The server is not connected. Wait until it is online, then try again.')

    const directory = await this.serverDirectory(serverId, ssh)
    const moved = serverProjectFrom(project, directory)
    const archive = serverArchiveFrom(deps.local.archive(projectId), project)
    deps.log(`projectMove start project=${projectId} server=${serverId} dir=${directory} archive=${archive.tasks.length}+${archive.streams.length}`)

    // 1. The server first, reserved.
    deps.servers.reserveIncoming(serverId, projectId)
    let step: 'projects' | 'archive' = 'projects'
    try {
      await deps.servers.writeProjects(serverId, { add: [moved] })
      step = 'archive'
      await this.copyArchive(serverId, projectId, archive)
    } catch (err) {
      // Even a write that failed may have landed (the link dropped before the answer).
      await this.rollBack(serverId, projectId, true)
      deps.log(`projectMove failed project=${projectId} server=${serverId} step=${step} error=${errorText(err)}`)
      throw new Error(`The server did not take the project: ${errorText(err)}`, { cause: err })
    }

    // 2. End the tabs here.
    const tabIds = projectTabIds(project)
    const tabTypes = new Map(project.streams.flatMap(s => s.tasks.flatMap(t => t.panes.flatMap(p => p.tabs.map(tab => [tab.id, tab.type] as const)))))
    const live = deps.local.liveTabs(tabIds)
    deps.tabsMoved({ tabIds, resume: live.filter(id => LAZY_AGENT_TABS.has(tabTypes.get(id) ?? '')) })
    try {
      await deps.local.endTabs(project)
    } catch (err) {
      deps.log(`projectMove endTabs project=${projectId} error=${errorText(err)}`)
    }
    for (const tabId of tabIds) deps.unpin(tabId)

    // 3. The switch: one commit removes the local copy and reveals the server's.
    try {
      const data = deps.local.peek()
      deps.local.commit({ ...data, projects: data.projects.filter(p => p.id !== projectId) })
    } catch (err) {
      await this.rollBack(serverId, projectId, true)
      deps.log(`projectMove failed project=${projectId} server=${serverId} step=local error=${errorText(err)}`)
      throw new Error(`DevTool could not save its projects: ${errorText(err)}`, { cause: err })
    }
    deps.servers.endIncoming(projectId)

    // 4. The SSH connection is no longer needed.
    try {
      await deps.closeSsh(projectId, ssh)
    } catch (err) {
      deps.log(`projectMove closeSsh project=${projectId} error=${errorText(err)}`)
    }
    deps.log(`projectMove done project=${projectId} server=${serverId} tabs=${tabIds.length} restarted=${live.length}`)
    return { projectId, serverId, directory, restarted: live }
  }

  /**
   * The project's folder as the server sees it (`~` expanded). The server lists
   * it, which also proves it runs on the machine the project reached over SSH.
   */
  private async serverDirectory(serverId: string, ssh: SshConfig): Promise<string> {
    const wanted = serverPathForRemoteDir(ssh.remoteDir)
    let listing: HostDirListing
    try {
      listing = await this.deps.call(serverId, 'server-list-dirs', [serverId, wanted]) as HostDirListing
    } catch (err) {
      throw new Error(`The server has no folder ${wanted}, so it doesn't run on ${ssh.host}. Pick the server on that machine. (${errorText(err)})`, { cause: err })
    }
    if (!listing || typeof listing.path !== 'string' || !listing.path.startsWith('/')) throw new Error(`The server did not resolve ${wanted}.`)
    return listing.path
  }

  /** Streams first (each takes its own Done row along), then the tasks, in calls that fit a link message. */
  private async copyArchive(serverId: string, projectId: string, archive: ProjectArchive): Promise<void> {
    for (const entry of archive.streams) {
      await this.deps.call(serverId, 'archive-add-stream', [projectId, entry])
    }
    let chunk: ArchivedTask[] = []
    let bytes = 0
    const flush = async (): Promise<void> => {
      if (chunk.length === 0) return
      await this.deps.call(serverId, 'archive-add-tasks', [projectId, chunk])
      chunk = []
      bytes = 0
    }
    for (const entry of archive.tasks) {
      const size = JSON.stringify(entry).length
      if (chunk.length > 0 && (bytes + size > ARCHIVE_CHUNK_BYTES || chunk.length >= 500)) await flush()
      chunk.push(entry)
      bytes += size
    }
    await flush()
  }

  /** Takes the project off the server again (its archive there goes with it) and ends the reservation. */
  private async rollBack(serverId: string, projectId: string, written: boolean): Promise<void> {
    if (written && this.deps.servers.isOnline(serverId)) {
      try {
        await this.deps.servers.writeProjects(serverId, { remove: [projectId] })
      } catch (err) {
        this.deps.log(`projectMove rollBack project=${projectId} server=${serverId} error=${errorText(err)}`)
      }
    }
    this.deps.servers.endIncoming(projectId)
  }
}
