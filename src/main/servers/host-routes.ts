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
  /**
   * This desktop and every online server; the answers (records keyed by tab or
   * task id) are merged, each server's keeping only the ids it owns.
   */
  | { merge: 'tabs' | 'tasks' }
  /**
   * The first key that names a known project, task or tab picks the host; none
   * means this desktop. Tab and task keys are remembered for the host found, so
   * a tab keeps its host after it leaves the data (closing it still reaches it).
   * An id this desktop owns always routes here; an id two servers claim, nowhere but here.
   * `remote`: `call` (default) runs the channel there; `skip` answers
   * `skipAnswer` without calling; `custom` hands it to a desktop handler.
   * `pin`: `set` pins the tab (the route's tab key) to the host found by its
   * project, so later tab-keyed calls and the server's pushes for it can't be
   * redirected by projects data; `clear` unpins it (the process ends).
   */
  | { by: RouteKey[]; remote?: 'call' | 'skip' | 'custom'; skipAnswer?: unknown; pin?: 'set' | 'clear' }
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
  'get-agent-activity': { merge: 'tabs' },
  'get-tab-statuses': { merge: 'tabs' },
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
  'chat-attach': { by: [{ projectField: [1, 'projectId'] }, { tab: 0 }], pin: 'set' },
  'chat-detach': tab0,
  // A server chat's images are scaled down here first (desktop-routing.ts).
  'chat-send': { by: [{ tab: 0 }], remote: 'custom' },
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
  'chat-close': { by: [{ tab: 0 }], pin: 'clear' },
  'chat-list-files': projectAt(1),
  'chat-permissions-read': projectAt(1),
  'chat-permissions-update': projectAt(5),

  // terminals (ipc/terminals.ts)
  'scrollback-save': tab0,
  'scrollback-load': tab0,
  'scrollback-delete': tab0,
  // A window's unload saves every xterm it shows; a server tab's PTY keeps its own scrollback.
  'scrollback-save-sync': { by: [{ tab: 0 }], remote: 'skip', skipAnswer: true },
  'pty-spawn': { by: [{ project: 7 }, { tab: 0 }], pin: 'set' },
  'pty-write': tab0,
  'pty-resize': tab0,
  'pty-kill': { by: [{ tab: 0 }], pin: 'clear' },

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
  'notebook-kernel-start': { by: [{ project: 1 }, { tab: 0 }], pin: 'set' },
  'notebook-kernel-execute': tab0,
  'notebook-kernel-interrupt': tab0,
  'notebook-kernel-restart': { by: [{ project: 1 }, { tab: 0 }], pin: 'set' },
  'notebook-kernel-shutdown': { by: [{ tab: 0 }], pin: 'clear' },

  // phones pair with this desktop
  'mobile-get-state': 'local',
  'mobile-set-enabled': 'local',
  'mobile-set-relay-url': 'local',
  'mobile-start-pairing': 'local',
  'mobile-cancel-pairing': 'local',
  'mobile-accept': 'local',
  'mobile-reject': 'local',
  'mobile-revoke': 'local',
  // a server's phones (Settings › Servers › Pair a phone): the first argument names the host
  'server-mobile-get-state': { by: [{ host: 0 }] },
  'server-mobile-start-pairing': { by: [{ host: 0 }] },
  'server-mobile-cancel-pairing': { by: [{ host: 0 }] },
  'server-mobile-accept': { by: [{ host: 0 }] },
  'server-mobile-reject': { by: [{ host: 0 }] },
  'server-mobile-revoke': { by: [{ host: 0 }] },

  // task worktrees and landing (ipc/task-worktrees.ts, ipc/task-landing.ts)
  'task-worktree-ensure': project0,
  'task-worktree-decide': task0,
  'task-worktree-dismiss': task0,
  'task-worktree-states': { merge: 'tasks' },
  'stream-worktree-setup-run': project0,
  'task-land': project0,
  'task-landing-retry': project0,
  'task-landing-abort': project0,
  'task-landing-fix': project0,
  'task-update-from-stream': project0,
  'task-stream-ahead': project0,
  'task-landing-preview': project0,
  // Project Home's queue (ipc/prompt-queue.ts)
  'prompt-queue-run': project0,
  'task-worktree-close': project0,
  // a task's title from its first prompt (ipc/task-names.ts): this desktop's claude names it
  'task-name-suggest': 'local',

  // adding a server project (ipc/host-fs.ts): the first argument names the host
  'server-list-dirs': { by: [{ host: 0 }] },
  'server-discover-repos': { by: [{ host: 0 }] },
  'server-clone-repo': { by: [{ host: 0 }] },

  // agent CLIs on a host, and its login env after an install (ipc/host-agents.ts): the first argument names the host
  'host-agent-clis': { by: [{ host: 0 }] },
  'host-refresh-env': { by: [{ host: 0 }] },

  // Open in IDE's key on a server (ipc/host-ssh.ts): the desktop's main calls these, never a window
  'host-ssh-authorize-key': { by: [{ host: 0 }] },
  'host-ssh-revoke-key': { by: [{ host: 0 }] }
}

/**
 * What a desktop does with each push from a server (`event` messages). Only
 * these channels are forwarded, and only about what that server owns; anything
 * else is dropped and logged. A server's pushes about its own settings, phones
 * and SSH never reach the windows, nor anything about this desktop's tabs.
 *
 * - `projects`: taken into ServerProjects as that server's source, whatever
 *   source the push names.
 * - `pinned-tab`: args[0] is a tab pinned to that server (it spawned or
 *   attached there: terminal output, chat events, kernel events).
 * - `server-tab`: args[0] is a tab of that server (pinned there, or only that
 *   server's data has it): hooks and agent activity.
 * - `server-task`: args[0] is a task only that server's data has.
 * - `server-project`: args[0] is a project only that server's data has.
 * - `removal`: args[0] is `{projectId, taskId, tabIds}` of that server's project;
 *   tab ids it doesn't own are left out.
 * - `tab-list`: args[0] is `{tabIds}`, cut down to that server's tabs.
 * - `own-window`: to the one window it names, never a broadcast (a clone's progress).
 * - `server-self`: about the server itself (its phones). Windows get it with the
 *   id of the server it came from in front, `(serverId, ...args)`, so a server
 *   only ever speaks for itself.
 */
export type ServerEventScope =
  | 'projects'
  | 'pinned-tab'
  | 'server-tab'
  | 'server-task'
  | 'server-project'
  | 'removal'
  | 'tab-list'
  | 'own-window'
  | 'server-self'

export const SERVER_EVENTS: Readonly<Record<string, ServerEventScope>> = {
  'projects-updated': 'projects',
  'pty-data': 'pinned-tab',
  'pty-exit': 'pinned-tab',
  'pty-size-sync': 'pinned-tab',
  'chat-event': 'pinned-tab',
  'notebook-kernel-event': 'pinned-tab',
  'hook-session-start': 'server-tab',
  'hook-working': 'server-tab',
  'hook-stopped': 'server-tab',
  'hook-notification': 'server-tab',
  'hook-activity': 'server-tab',
  'agent-activity': 'server-tab',
  'tab-host-status': 'server-tab',
  'task-worktree-state': 'server-task',
  'task-landing-state': 'server-task',
  'archive-changed': 'server-project',
  'tasks-removed': 'removal',
  'tabs-removed': 'removal',
  'tabs-restart': 'tab-list',
  'server-clone-progress': 'own-window',
  'server-mobile-state-changed': 'server-self'
}

/**
 * Pushes a server sends that are about it alone (its config, notes, SSH): never
 * forwarded. A server's phones reach windows as `server-mobile-state-changed`;
 * `mobile-state-changed` is a desktop's own Settings › Mobile.
 */
export const SERVER_PRIVATE_EVENTS: readonly string[] = [
  'config-updated',
  'notes-updated',
  'mobile-state-changed',
  'ssh-status-changed',
  'ssh-tunnel-status-changed'
]
