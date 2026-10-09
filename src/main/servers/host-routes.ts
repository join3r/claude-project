/**
 * Which host serves each host IPC channel on a desktop (plan step 6): this
 * desktop's own HostServices, or the DevTool server a project lives on. The
 * router (`host-router.ts`) reads the route key out of the call's arguments; the
 * server then runs the same channel with the same arguments as that window
 * (protocol/SERVER.md §5).
 *
 * Every channel `HostServices.registerIpcHandlers` registers needs an entry
 * (`tests/host-router.test.ts` checks it, and the router refuses to register one
 * without), so a new channel can't silently skip routing.
 */

/** Where in a call's arguments the route key is. */
export type RouteKey =
  /** `args[i]` is a project id (optional: absent means this desktop). */
  | { project: number }
  /** `args[i][field]` is a project id. */
  | { projectField: [number, string] }
  /** `args[i]` is a task id. */
  | { task: number }
  /** `args[i]` is a tab id. */
  | { tab: number }
  /** `args[i]` names the host itself: `local`, or a server id (also a projects source). */
  | { host: number }

export type HostRoute =
  /** Always this desktop (its config, notes, SSH, phones). */
  | 'local'
  /** The desktop answers itself, merging every source (`load-projects`). */
  | 'desktop'
  /** This desktop and every online server; the answers (records) are merged. */
  | 'merge'
  /**
   * The first key that names a known project, task or tab picks the host; none
   * means this desktop. Tab and task keys are remembered for the host found, so
   * a tab keeps its host after it leaves the data (closing it still reaches it).
   * `remote`: `call` (default) runs the channel there; `skip` answers
   * `skipAnswer` without calling; `custom` hands it to a desktop handler.
   */
  | { by: RouteKey[]; remote?: 'call' | 'skip' | 'custom'; skipAnswer?: unknown }
  /**
   * `args[i]` is a list of tab ids: each host gets its own part. `everyServer`:
   * every online server is called, with an empty list if it has none (a window's
   * dirty tabs: an empty list clears what it reported before).
   */
  | { splitTabs: number; everyServer?: boolean }

const tab0: HostRoute = { by: [{ tab: 0 }] }
const task0: HostRoute = { by: [{ task: 0 }] }
const project0: HostRoute = { by: [{ project: 0 }] }
const projectAt = (i: number): HostRoute => ({ by: [{ project: i }] })
const workspaceRequest: HostRoute = { by: [{ projectField: [0, 'projectId'] }] }

export const HOST_ROUTES: Readonly<Record<string, HostRoute>> = {
  // app state (ipc/app-state.ts)
  'load-projects': 'desktop',
  'save-projects': { by: [{ host: 0 }], remote: 'custom' },
  'save-projects-slice': 'local',
  'get-agent-activity': 'merge',
  'report-dirty-tabs': { splitTabs: 0, everyServer: true },
  'tabs-restart': { splitTabs: 0 },
  'report-tab-status': tab0,
  'backup-projects-now': 'local',
  'load-config': 'local',
  'save-config': 'local',
  'notes-load': 'local',
  'notes-save': 'local',
  'palette-frecency:load': 'local',
  'palette-frecency:save': 'local',

  // SSH projects are this desktop's (ipc/ssh.ts)
  'ssh-connect': 'local',
  'ssh-status': 'local',
  'ssh-set-tunnel': 'local',
  'ssh-tunnel-status': 'local',

  // agents and chats (ipc/agents.ts)
  'hooks-inject': { by: [{ project: 2 }, { tab: 1 }] },
  'hooks-cleanup': { by: [{ project: 2 }, { tab: 1 }] },
  'hooks-cleanup-remote': 'local',
  'codex-read-session': projectAt(2),
  'claude-session-exists': projectAt(2),
  'task-move-prepare': projectAt(4),
  'chat-attach': { by: [{ projectField: [1, 'projectId'] }, { tab: 0 }] },
  'chat-detach': tab0,
  'chat-send': tab0,
  'chat-bash': tab0,
  'chat-login': tab0,
  'chat-login-code': tab0,
  'chat-login-dismiss': tab0,
  'chat-logout': tab0,
  'chat-side-question': tab0,
  'chat-interrupt': tab0,
  'chat-stop-task': tab0,
  'chat-background-task': tab0,
  'chat-respond': tab0,
  'chat-set-model': tab0,
  'chat-set-mode': tab0,
  'chat-set-effort': tab0,
  'chat-stop': tab0,
  'chat-close': tab0,
  'chat-list-files': projectAt(1),
  'chat-permissions-read': projectAt(1),
  'chat-permissions-update': projectAt(5),

  // terminals (ipc/terminals.ts)
  'scrollback-save': tab0,
  'scrollback-load': tab0,
  'scrollback-delete': tab0,
  // A window's unload saves every xterm it shows; a server tab's PTY keeps its own scrollback.
  'scrollback-save-sync': { by: [{ tab: 0 }], remote: 'skip', skipAnswer: true },
  'pty-spawn': { by: [{ project: 7 }, { tab: 0 }] },
  'pty-write': tab0,
  'pty-resize': tab0,
  'pty-kill': tab0,

  // workspaces (ipc/workspaces.ts)
  'workspace-list-branches': workspaceRequest,
  'workspace-create': workspaceRequest,
  'workspace-delete': workspaceRequest,
  'workspace-restore': workspaceRequest,

  // archive (ipc/archive.ts)
  'archive-load': project0,
  'archive-add-tasks': project0,
  'archive-add-stream': project0,
  'archive-remove': project0,
  'archive-delete-tabs': { splitTabs: 0 },
  'archive-transcript': projectAt(2),

  // file browser and git (ipc/file-browser.ts, ipc/git.ts): the project id is the last argument
  'fb-read-directory': projectAt(2),
  'fb-read-file': projectAt(2),
  'fb-write-file': projectAt(3),
  'fb-create-file': projectAt(3),
  'fb-create-directory': projectAt(3),
  'fb-rename': projectAt(3),
  'fb-delete': projectAt(2),
  'git-project-posture': projectAt(1),
  'git-commit-history': projectAt(1),
  'fb-git-status': projectAt(1),
  'fb-git-diff': projectAt(2),
  'fb-git-stage': projectAt(3),
  'fb-git-unstage': projectAt(3),
  'fb-git-discard': projectAt(3),
  'fb-git-pull': projectAt(2),
  'fb-git-commit': projectAt(3),
  'fb-git-push': projectAt(2),

  // notebooks and conda (ipc/notebooks.ts)
  'conda-list-envs': project0,
  'notebook-kernel-start': { by: [{ project: 1 }, { tab: 0 }] },
  'notebook-kernel-execute': tab0,
  'notebook-kernel-interrupt': tab0,
  'notebook-kernel-restart': { by: [{ project: 1 }, { tab: 0 }] },
  'notebook-kernel-shutdown': tab0,

  // phones pair with this desktop (step 10 pairs them with servers)
  'mobile-get-state': 'local',
  'mobile-set-enabled': 'local',
  'mobile-set-relay-url': 'local',
  'mobile-start-pairing': 'local',
  'mobile-cancel-pairing': 'local',
  'mobile-accept': 'local',
  'mobile-reject': 'local',
  'mobile-revoke': 'local',

  // task worktrees and landing (ipc/task-worktrees.ts, ipc/task-landing.ts)
  'task-worktree-ensure': project0,
  'task-worktree-decide': task0,
  'task-worktree-dismiss': task0,
  'task-worktree-states': 'merge',
  'stream-worktree-setup-run': project0,
  'task-land': project0,
  'task-landing-retry': project0,
  'task-landing-abort': project0,
  'task-landing-fix': project0,
  'task-update-from-stream': project0,
  'task-stream-ahead': project0,
  'task-landing-preview': project0,
  'task-worktree-close': project0,

  // adding a server project (ipc/host-fs.ts): the first argument names the host
  'server-list-dirs': { by: [{ host: 0 }] },
  'server-discover-repos': { by: [{ host: 0 }] },
  'server-clone-repo': { by: [{ host: 0 }] }
}

/**
 * What a desktop does with each push from a server (`event` messages):
 * `forward` it to the window it names (or every window for `*`), take a
 * `projects` update into ServerProjects, or `drop` what is about the server's
 * own settings and phones, which a desktop must not adopt. Unknown channels are
 * dropped (and logged): a newer server may push things this desktop can't read.
 */
export const SERVER_EVENTS: Readonly<Record<string, 'forward' | 'projects' | 'drop'>> = {
  'projects-updated': 'projects',
  'pty-data': 'forward',
  'pty-exit': 'forward',
  'pty-size-sync': 'forward',
  'hook-session-start': 'forward',
  'hook-working': 'forward',
  'hook-stopped': 'forward',
  'hook-notification': 'forward',
  'hook-activity': 'forward',
  'agent-activity': 'forward',
  'chat-event': 'forward',
  'tasks-removed': 'forward',
  'tabs-removed': 'forward',
  'tabs-restart': 'forward',
  'archive-changed': 'forward',
  'task-worktree-state': 'forward',
  'task-landing-state': 'forward',
  'notebook-kernel-event': 'forward',
  'server-clone-progress': 'forward',
  'config-updated': 'drop',
  'notes-updated': 'drop',
  'mobile-state-changed': 'drop',
  'ssh-status-changed': 'drop',
  'ssh-tunnel-status-changed': 'drop'
}
