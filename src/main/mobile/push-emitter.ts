import { isHomeTask, type Project, type ProjectsData, type Task } from '../../shared/types'
import type { ChatEvent, ChatItem, ChatPrompt, ChatState } from '../../shared/claude-chat'
import { promptQuestions } from '../../shared/chat-prompts'
import { summarizeTool } from '../../shared/agent-activity'
import { b64uDecode, sealPushPayload, type PushPayload, type PushPayloadKind } from '../../../protocol/ts/index.ts'
import { projectTasks, taskTabs } from '../../shared/streams'
import { isVisibleOnMobile } from './inbox'
import type { MobilePushRegistration } from './pairings-store'
import type { PushOutcome } from './mobile-service'

/**
 * Decides what is worth a push (SPEC.md §7.6) and seals it for each phone (§7.5).
 * It watches every chat, not only the ones a phone has open: a prompt in a chat
 * nobody is looking at is exactly what a push is for.
 */

export interface PushEmitterDeps {
  chats: { watch(watcher: (tabId: string, event: ChatEvent, state: ChatState) => void): () => void }
  projects: { peek(): ProjectsData }
  /** Phones with a push registration. */
  targets(): { phoneId: string; push: MobilePushRegistration }[]
  /** The tab a phone has open in a live session: it is already looking, so no push. */
  openTab(phoneId: string): string | null
  send(phoneId: string, data: string): Promise<PushOutcome>
  desktopId(): string | null
  now(): number
  log(message: string): void
}

interface TabState {
  busy: boolean
  /** Prompt IDs already seen, so each one pushes once. */
  prompts: Set<string>
  /** Phones whose `chat.send` started the running turn. */
  turnOwners: Set<string>
}

const FALLBACK_DONE = 'Finished'
const PLAN_BODY = 'Plan ready for review'

export class PushEmitter {
  private readonly tabs = new Map<string, TabState>()
  private stopWatching: (() => void) | null = null

  constructor(private readonly deps: PushEmitterDeps) {}

  start(): void {
    if (this.stopWatching) return
    this.stopWatching = this.deps.chats.watch((tabId, _event, state) => this.observe(tabId, state))
  }

  stop(): void {
    this.stopWatching?.()
    this.stopWatching = null
    this.tabs.clear()
  }

  /** The chat bridge is about to send a phone's message into `tabId`. */
  phoneSent(phoneId: string, tabId: string): void {
    this.tabState(tabId).turnOwners.add(phoneId)
  }

  private tabState(tabId: string): TabState {
    let state = this.tabs.get(tabId)
    if (!state) {
      state = { busy: false, prompts: new Set(), turnOwners: new Set() }
      this.tabs.set(tabId, state)
    }
    return state
  }

  private observe(tabId: string, chat: ChatState): void {
    const tab = this.tabState(tabId)
    const fresh = chat.pending.filter((p) => !tab.prompts.has(p.id))
    // Forget answered prompts so the set can't grow without bound.
    tab.prompts = new Set(chat.pending.map((p) => p.id))

    const finished = tab.busy && !chat.busy
    tab.busy = chat.busy
    const owners = finished ? [...tab.turnOwners] : []
    if (finished) tab.turnOwners.clear()

    if (fresh.length === 0 && owners.length === 0) return
    const place = this.place(tabId)
    if (!place) return
    for (const prompt of fresh) this.pushPrompt(place, tabId, prompt)
    if (owners.length > 0) this.pushDone(place, tabId, chat, owners)
  }

  private pushPrompt(title: string, tabId: string, prompt: ChatPrompt): void {
    const kind: PushPayloadKind = prompt.kind
    const body = prompt.kind === 'permission'
      ? summarizeTool(prompt.toolName, prompt.input)
      : prompt.kind === 'question'
        ? promptQuestions(prompt.input)[0]?.question || 'Claude has a question'
        : PLAN_BODY
    const wanted = prompt.kind === 'permission' ? 'permission' : 'question'
    for (const target of this.deps.targets()) {
      if (!target.push.kinds.includes(wanted)) continue
      this.deliver(target, { kind, tab: tabId, prompt: prompt.id, title, body })
    }
  }

  private pushDone(title: string, tabId: string, chat: ChatState, owners: string[]): void {
    const body = lastAssistantLine(chat.items) || FALLBACK_DONE
    for (const target of this.deps.targets()) {
      if (!owners.includes(target.phoneId) || !target.push.kinds.includes('done')) continue
      this.deliver(target, { kind: 'done', tab: tabId, title, body })
    }
  }

  private deliver(
    target: { phoneId: string; push: MobilePushRegistration },
    fields: { kind: PushPayloadKind; tab: string; prompt?: string; title: string; body: string }
  ): void {
    if (this.deps.openTab(target.phoneId) === fields.tab) return
    const desktop = this.deps.desktopId()
    if (!desktop) return
    const payload: PushPayload = { v: 1, desktop, at: this.deps.now(), ...fields }
    let data: string
    try {
      data = sealPushPayload(b64uDecode(target.push.key), b64uDecode(target.push.keyId), payload)
    } catch (err) {
      this.deps.log(`push seal phone=${target.phoneId} error=${err instanceof Error ? err.message : String(err)}`)
      return
    }
    void this.deps.send(target.phoneId, data).then((outcome) => {
      if (outcome !== 'ok') this.deps.log(`push kind=${fields.kind} phone=${target.phoneId} outcome=${outcome}`)
    })
  }

  /** "project / task" for a chat tab on mobile, or null when it isn't one (hidden, gone). */
  private place(tabId: string): string | null {
    const found = findChatTab(this.deps.projects.peek(), tabId)
    return found ? `${found.project.name} / ${found.task.name}` : null
  }
}

function findChatTab(data: ProjectsData, tabId: string): { project: Project; task: Task } | null {
  for (const project of data.projects) {
    if (!isVisibleOnMobile(project)) continue
    for (const task of projectTasks(project)) {
      if (isHomeTask(task)) continue
      const tab = taskTabs(task).find((t) => t.id === tabId)
      if (tab) return tab.type === 'claude-chat' ? { project, task } : null
    }
  }
  return null
}

/** The first non-empty line of the last assistant text, if any. */
function lastAssistantLine(items: ChatItem[]): string {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]
    if (item.kind === 'user') return ''
    if (item.kind !== 'text') continue
    const line = item.text.split('\n').map((l) => l.trim()).find((l) => l.length > 0)
    if (line) return line
  }
  return ''
}
