import { describeActivity, type AgentActivity } from '../../shared/agent-activity'
import { isSettled, isSnoozed, isUnread, statusTabs, taskStatus } from '../../shared/inbox-state'
import {
  isSpentEphemeralProject,
  type Project,
  type ProjectsData,
  type Stream,
  type Tab,
  type TabStatusValue,
  type Task
} from '../../shared/types'
import { findStreamOfTask, taskTabs } from '../../shared/streams'
import { INBOX_TAB_TYPES } from '../../../protocol/ts/index.ts'
import type {
  Inbox as MobileInbox,
  InboxPin as MobileInboxPin,
  InboxProject as MobileInboxProject,
  InboxStream as MobileInboxStream,
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
  const topic = shortLabel(activity?.title ?? activity?.lastPrompt)
  if (topic) out.topic = topic
  return out
}

/**
 * The task's triage state as the desktop inbox reads it (SPEC.md §4.4), through the
 * same predicates, so the phone groups it the way the window does. A snooze wins over
 * a settle, as in `partitionInbox`.
 */
function addTriage(out: Omit<MobileInboxTask, 'tabs'>, task: Task, now: number): void {
  const inbox = task.inbox
  if (!inbox) return
  if (inbox.eventAt !== undefined) out.eventAt = inbox.eventAt
  if (isUnread(task)) out.unread = true
  if (isSnoozed(task, now)) {
    if (inbox.snoozeUntilAttention) out.snoozeUntilAttention = true
    else if (inbox.snoozedUntil !== undefined) out.snoozedUntil = inbox.snoozedUntil
  } else if (isSettled(task) && inbox.settledAt !== undefined) {
    out.settledAt = inbox.settledAt
  }
}

/**
 * The task's one status (SPEC.md §4.4), from its status tabs only (main tab and
 * agent tabs, `statusTabs`), as the desktop Inbox and sidebar read it: an extra
 * terminal's bell lights only its own tab. `since` is the oldest change into that
 * status, `activity` the label of the first tab in it that has one.
 */
function taskStatusFields(task: Task, lookup: InboxTabLookup): Pick<MobileInboxTask, 'status' | 'since' | 'activity'> {
  const tabs = statusTabs(task)
  const statuses: Record<string, TabStatusValue> = {}
  for (const tab of tabs) statuses[tab.id] = lookup.statusOf(tab.id)
  const status = taskStatus(task, statuses)
  const out: Pick<MobileInboxTask, 'status' | 'since' | 'activity'> = { status: status ?? 'idle' }
  if (!status) return out
  const inStatus = tabs.filter((tab) => statuses[tab.id] === status)
  const sinces = inStatus.map((tab) => lookup.sinceOf(tab.id)).filter((since): since is number => since !== null)
  if (sinces.length > 0) out.since = Math.min(...sinces)
  for (const tab of inStatus) {
    const label = shortLabel(describeActivity(lookup.activityOf(tab.id) ?? undefined, status))
    if (label) {
      out.activity = label
      break
    }
  }
  return out
}

function buildTask(stream: Stream, task: Task, lookup: InboxTabLookup, now: number): MobileInboxTask {
  const out: Omit<MobileInboxTask, 'tabs'> = {
    id: task.id,
    name: task.name,
    streamId: stream.id,
    streamName: stream.name,
    ...taskStatusFields(task, lookup)
  }
  if (task.lastInteractedAt !== undefined) out.lastInteractedAt = task.lastInteractedAt
  if (task.inbox?.attentionAt !== undefined) out.attentionAt = task.inbox.attentionAt
  addTriage(out, task, now)
  const tabs = taskTabs(task)
    .filter(isMobileTab)
    .map((tab) => buildTab(tab, lookup))
  return { ...out, tabs }
}

function buildStream(stream: Stream): MobileInboxStream {
  const out: MobileInboxStream = { id: stream.id, name: stream.name }
  if (stream.isMain) out.main = true
  if (stream.workspace) out.branch = stream.workspace.branchName
  return out
}

/** Hidden (`hideFromMobile`) and spent ephemeral projects never reach a phone. */
export function isVisibleOnMobile(project: Project): boolean {
  return !project.hideFromMobile && !isSpentEphemeralProject(project)
}

/**
 * Archived streams and tasks live outside `project.streams` (`archive/<id>.json`),
 * so only open ones are ever sent.
 */
function buildProject(project: Project, lookup: InboxTabLookup, now: number): MobileInboxProject {
  const lastStream = project.streams.find((stream) => stream.id === project.lastStreamId)
  return {
    id: project.id,
    name: project.name,
    ...(project.emoji ? { emoji: project.emoji } : {}),
    remote: !!project.ssh,
    streams: project.streams.map(buildStream),
    ...(lastStream ? { lastStreamId: lastStream.id } : {}),
    tasks: project.streams.flatMap((stream) => stream.tasks.map((task) => buildTask(stream, task, lookup, now)))
  }
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
 * The sidebar's Pinned list, in its order, cut to what the phone sees: a pin whose
 * project is hidden or spent, or whose stream or task is gone (archived too), is
 * left out. A task pin names the stream that holds the task now.
 */
function buildPinned(data: ProjectsData, visible: readonly Project[]): MobileInboxPin[] {
  const byId = new Map(visible.map((project) => [project.id, project]))
  const seen = new Set<string>()
  const out: MobileInboxPin[] = []
  for (const item of data.pinnedItems ?? []) {
    const project = byId.get(item.projectId)
    if (!project) continue
    let pin: MobileInboxPin
    let key: string
    if (item.type === 'project') {
      pin = { projectId: project.id }
      key = `project:${project.id}`
    } else if (item.type === 'stream') {
      if (!project.streams.some((stream) => stream.id === item.streamId)) continue
      pin = { projectId: project.id, streamId: item.streamId }
      key = `stream:${project.id}:${item.streamId}`
    } else {
      const stream = findStreamOfTask(project, item.taskId)
      if (!stream) continue
      pin = { projectId: project.id, streamId: stream.id, taskId: item.taskId }
      key = `task:${project.id}:${item.taskId}`
    }
    if (seen.has(key)) continue
    seen.add(key)
    out.push(pin)
  }
  return out
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
  const visible = orderedProjects(data).filter(isVisibleOnMobile)
  const inbox: MobileInbox = {
    desktop: { id: desktop.id, name: desktop.name },
    generatedAt: now,
    projects: visible.map((project) => buildProject(project, lookup, now))
  }
  const pinned = buildPinned(data, visible)
  if (pinned.length > 0) inbox.pinned = pinned
  return inbox
}

/** Everything but `generatedAt`: equal keys mean the phone would see nothing new. */
export function inboxContentKey(inbox: MobileInbox): string {
  return JSON.stringify({ desktop: inbox.desktop, projects: inbox.projects, pinned: inbox.pinned })
}
