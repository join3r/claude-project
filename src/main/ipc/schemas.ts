import type {
  NotesRecord,
  ProjectsData,
  SshConfig,
  TunnelConfig,
  WindowViewState,
  WorkspaceCreateRequest,
  WorkspaceDeleteRequest,
  WorkspaceListBranchesRequest,
  WorkspaceRestoreRequest
} from '../../shared/types'
import type { ChatImage, ChatPromptResponse } from '../../shared/claude-chat'
import type { ChatTabConfig } from '../claude-chat/chat-manager'
import type { FrecencyFile } from '../palette-frecency-storage'
import { IpcValidationError, v, type Validator } from './validate'

/**
 * Ids that end up in file names (`scrollback/<tabId>.txt`), session partitions
 * and log lines: no path separators, no NUL, not `.`/`..`.
 */
export const safeId: Validator<string> = (value, path) => {
  const id = v.string({ nonEmpty: true, max: 256 })(value, path)
  if (/[\\/\0:]/.test(id) || id === '.' || id === '..') {
    throw new IpcValidationError(`Invalid IPC argument ${path}: not a valid id`)
  }
  return id
}

export const str = v.string()
export const optStr = v.optional(v.string())
export const nonEmptyStr = v.string({ nonEmpty: true })
export const optSafeId = v.optional(safeId)
export const stringList = v.array(v.string())
export const port = v.number({ int: true, min: 0, max: 65535 })

export const sshConfig = v.object({
  host: v.string({ nonEmpty: true }),
  port,
  username: v.string(),
  keyFile: optStr,
  // Declared required, but old projects.json entries may predate it — the
  // consumers already treat an empty/missing value as "the remote home".
  remoteDir: optStr
}) as Validator<SshConfig>
export const optSshConfig = v.optional(sshConfig)

export const tunnelConfig: Validator<TunnelConfig> = v.object({
  host: v.string({ nonEmpty: true }),
  sourcePort: port,
  destinationPort: port
})

const nullableStr = v.nullable(v.string())

const taskViewState = v.object({
  fileBrowserOpen: v.optional(v.boolean()),
  fileBrowserActiveTab: v.optional(v.literal('files', 'git', 'notes'))
}, 'passthrough')

export const windowViewState: Validator<WindowViewState> = v.object({
  selectedProjectId: nullableStr,
  selectedTaskId: nullableStr,
  expandedProjectIds: stringList,
  streamExpansion: v.optional(v.record(v.boolean())),
  taskStates: v.record(taskViewState),
  fileBrowserOpen: v.boolean(),
  fileBrowserWidth: v.number(),
  fileBrowserActiveTab: v.literal('files', 'git', 'notes'),
  sidebarWidth: v.number(),
  sidebarTab: v.literal('projects', 'inbox')
}, 'passthrough')

const workspaceConfig = v.object({
  worktreePath: v.string(),
  branchName: v.string(),
  baseBranch: v.string(),
  relativeProjectPath: v.optional(v.string())
}, 'passthrough')

const taskShape = v.object({
  id: v.string({ nonEmpty: true }),
  workspace: v.optional(workspaceConfig),
  sharesStreamWorktree: v.optional(v.literal(true)),
  landing: v.optional(v.plainObject())
}, 'passthrough')

/**
 * Structural check only: `Storage.normalizeProjectsData` does the semantic
 * clean-up on commit. The fields checked are the ones main itself reads —
 * in particular directories and worktree paths, which feed the file-browser
 * allow-list. Windows only ever hold the Project › Stream › Task shape (storage
 * migrates older files on load), so that is the only one a save may carry.
 */
const projectShape = v.object({
  id: v.string({ nonEmpty: true }),
  directory: v.optional(v.string()),
  ssh: v.optional(v.plainObject()),
  streams: v.array(v.object({
    id: v.string({ nonEmpty: true }),
    workspace: v.optional(workspaceConfig),
    taskWorktrees: v.optional(v.literal(true)),
    tasks: v.array(taskShape)
  }, 'passthrough'))
}, 'passthrough')

export const revisionSave = <T>(data: Validator<T>): Validator<{ baseRevision: number; data: T }> =>
  v.object({ baseRevision: v.number({ int: true, min: 0 }), data }) as Validator<{ baseRevision: number; data: T }>

export const projectsData = v.object({
  projects: v.array(projectShape),
  tags: v.optional(v.array(v.plainObject())),
  projectOrder: v.optional(stringList),
  pinnedItems: v.optional(v.array(v.plainObject()))
}, 'passthrough') as unknown as Validator<ProjectsData>

/** A server's slice as a desktop saves it: its projects only (shared/projects-sources.ts). */
export const projectsSlice = v.object({
  projects: v.array(projectShape)
}, 'passthrough') as unknown as Validator<Pick<ProjectsData, 'projects'>>

export const notesRecord = v.record(v.array(v.object({
  id: v.string(),
  name: v.string(),
  content: v.string(),
  createdAt: v.number(),
  updatedAt: v.number()
}, 'passthrough'))) as Validator<NotesRecord>

export const frecencyFile: Validator<FrecencyFile> = v.object({
  version: v.literal(1),
  entries: v.record(v.object({ lastUsedAt: v.number(), useCount: v.number() }))
})

const workspaceTarget = {
  projectDir: v.string({ nonEmpty: true }),
  projectId: optSafeId,
  sshConfig: optSshConfig
}

export const workspaceListBranchesRequest = v.object(workspaceTarget) as Validator<WorkspaceListBranchesRequest>

export const workspaceCreateRequest = v.object({
  ...workspaceTarget,
  name: v.string({ nonEmpty: true }),
  baseBranch: v.string({ nonEmpty: true })
}) as Validator<WorkspaceCreateRequest>

export const workspaceDeleteRequest = v.object({
  ...workspaceTarget,
  worktreePath: v.string({ nonEmpty: true }),
  branchName: v.string(),
  baseBranch: v.string(),
  force: v.optional(v.boolean()),
  keepBranch: v.optional(v.boolean())
}) as Validator<WorkspaceDeleteRequest>

export const workspaceRestoreRequest = v.object({
  ...workspaceTarget,
  worktreePath: v.string({ nonEmpty: true }),
  branchName: v.string({ nonEmpty: true })
}) as Validator<WorkspaceRestoreRequest>

/** An archived task or stream, as a window builds it: checked for shape, kept whole. */
export const archivedTaskEntry = v.object({
  task: taskShape,
  streamId: v.string({ nonEmpty: true }),
  streamName: v.string(),
  dir: v.string(),
  archivedAt: v.number()
}, 'passthrough')

export const archivedStreamEntry = v.object({
  stream: v.object({
    id: v.string({ nonEmpty: true }),
    name: v.string(),
    workspace: v.optional(workspaceConfig),
    tasks: v.array(taskShape)
  }, 'passthrough'),
  doneTasks: v.array(archivedTaskEntry),
  dir: v.string(),
  archivedAt: v.number()
}, 'passthrough')

export const chatTabConfig = v.object({
  cwd: v.string(),
  sessionId: v.string({ nonEmpty: true }),
  projectId: optSafeId,
  sshConfig: optSshConfig,
  extraArgs: v.optional(stringList)
}) as Validator<ChatTabConfig>

// The composer also sends its own `id`/`preview` fields; they pass through as before.
export const chatImages = v.optional(v.array(v.object({
  mediaType: v.string(),
  data: v.string()
}, 'passthrough'))) as Validator<ChatImage[] | undefined>

export const chatPromptResponse = v.union(
  v.object({
    behavior: v.literal('allow'),
    always: v.optional(v.boolean()),
    mode: v.optional(v.string({ max: 40 })),
    updatedInput: v.optional(v.plainObject())
  }),
  v.object({
    behavior: v.literal('deny'),
    message: v.optional(v.string())
  })
) as Validator<ChatPromptResponse>

/** `chat-stop-task` / `chat-background-task`: the tab, then a task id or tool_use id. */
export const chatTaskArgs = [safeId, v.string({ nonEmpty: true, max: 256 })] as const

export const envRecord = v.optional(v.record(v.string()))
export const dimension = v.number({ int: true, min: 0, max: 10_000 })
