import { describeActivity, type AgentActivity } from '../../shared/agent-activity'
import {
  isHomeTask,
  isSpentEphemeralProject,
  type Project,
  type ProjectsData,
  type Tab,
  type TabStatusValue,
  type Task
} from '../../shared/types'
import { INBOX_TAB_TYPES } from '../../../protocol/ts/index.ts'
import type {
  Inbox as MobileInbox,
  InboxProject as MobileInboxProject,
  InboxTab as MobileInboxTab,
  InboxTask as MobileInboxTask
} from '../../../protocol/ts/index.ts'

type MobileTabType = typeof INBOX_TAB_TYPES[number]
const MOBILE_TAB_TYPES: ReadonlySet<string> = new Set<string>(INBOX_TAB_TYPES)

/** A phone row is one line; the sidebar's label can carry a 160-char prompt. */
const ACTIVITY_LIMIT = 100

/** What main knows about each tab's process — `TabActivityRegistry` in production. */
export interface InboxTabLookup {
  statusOf: (tabId: string) => TabStatusValue
  activityOf: (tabId: string) => AgentActivity | null
  sinceOf: (tabId: string) => number | null
}

function isMobileTab(tab: Tab): tab is Tab & { type: MobileTabType } {
  return MOBILE_TAB_TYPES.has(tab.type)
}

function shortLabel(label: string | undefined): string | undefined {
  if (!label) return undefined
  return label.length > ACTIVITY_LIMIT ? `${label.slice(0, ACTIVITY_LIMIT - 1)}…` : label
}

function buildTab(tab: Tab & { type: MobileTabType }, lookup: InboxTabLookup): MobileInboxTab {
  const status = lookup.statusOf(tab.id)
  const out: MobileInboxTab = {
    id: tab.id,
    type: tab.type,
    title: tab.title,
    status: status ?? 'idle'
  }
  const since = lookup.sinceOf(tab.id)
  if (since !== null) out.since = since
  const activity = lookup.activityOf(tab.id)
  const label = shortLabel(describeActivity(activity ?? undefined, status))
  if (label) out.activity = label
  return out
}

function buildTask(task: Task, lookup: InboxTabLookup): MobileInboxTask {
  const tabs = [...(task.tabs?.left ?? []), ...(task.tabs?.right ?? [])]
    .filter(isMobileTab)
    .map((tab) => buildTab(tab, lookup))
  const out: MobileInboxTask = { id: task.id, name: task.name, tabs }
  if (task.lastInteractedAt !== undefined) out.lastInteractedAt = task.lastInteractedAt
  if (task.inbox?.attentionAt !== undefined) out.attentionAt = task.inbox.attentionAt
  if (task.workspace) out.branch = task.workspace.branchName
  return out
}

/** Hidden (`hideFromMobile`) and spent ephemeral projects never reach a phone. */
export function isVisibleOnMobile(project: Project): boolean {
  return !project.hideFromMobile && !isSpentEphemeralProject(project)
}

function buildProject(project: Project, lookup: InboxTabLookup): MobileInboxProject {
  const out: MobileInboxProject = {
    id: project.id,
    name: project.name,
    remote: !!project.ssh,
    tasks: (project.tasks ?? []).filter((task) => !isHomeTask(task)).map((task) => buildTask(task, lookup))
  }
  if (project.emoji) out.emoji = project.emoji
  return out
}

/** Projects in `projectOrder`, then any the order does not mention (it should mention all). */
function orderedProjects(data: ProjectsData): Project[] {
  const byId = new Map(data.projects.map((project) => [project.id, project]))
  const ordered: Project[] = []
  const seen = new Set<string>()
  for (const id of data.projectOrder ?? []) {
    const project = byId.get(id)
    if (!project || seen.has(id)) continue
    seen.add(id)
    ordered.push(project)
  }
  for (const project of data.projects) {
    if (!seen.has(project.id)) ordered.push(project)
  }
  return ordered
}

/**
 * The phone's read-only picture of this desktop (SPEC.md §4.4). Pure: hidden and
 * spent projects are filtered here, before anything is encrypted, and only agent
 * and terminal tabs make it out.
 */
export function buildInbox(
  data: ProjectsData,
  lookup: InboxTabLookup,
  desktop: { id: string; name: string },
  now: number
): MobileInbox {
  return {
    desktop: { id: desktop.id, name: desktop.name },
    generatedAt: now,
    projects: orderedProjects(data).filter(isVisibleOnMobile).map((project) => buildProject(project, lookup))
  }
}

/** Everything but `generatedAt`: equal keys mean the phone would see nothing new. */
export function inboxContentKey(inbox: MobileInbox): string {
  return JSON.stringify({ desktop: inbox.desktop, projects: inbox.projects })
}
