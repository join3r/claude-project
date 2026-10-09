import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ArrowDown } from 'lucide-react'
import { useApp } from '../../context/AppContext'
import { useTabStatusStore } from '../../context/TabStatusContext'
import type { SshConfig } from '../../../shared/types'
import { classifyNotification, nextAiStatus, type AiNotificationKind, type AiStatusDecision, type AiStatusEvent } from '../../../shared/ai-status'
import { composerCommands, type ChatColdCache, type ChatImage, type ChatLoginMethod, type ChatPromptResponse } from '../../../shared/claude-chat'
import { parseExtraArgs } from '../aiToolTabUtils'
import { ensureHookListeners, hookStatusCallbacks } from '../hookStatusListeners'
import { normalizeBrowserUrl } from '../../browserUrl'
import { attachChat, forgetChat, getChatState, setChatEventHandler, useChatState } from './chatStore'
import Timeline, { type TimelineFocus } from './Timeline'
import TaskIndicator from './TaskIndicator'
import PromptCard from './PromptCards'
import SideQuestion, { type SideQuestionState } from './SideQuestion'
import ColdCacheNotice from './ColdCacheNotice'
import LoginCard from './LoginCard'
import PermissionsDialog from './PermissionsDialog'
import Composer from './Composer'
import { noteAgentTabTyped } from '../../agentLink/agentTabRecency'
import { takePendingPrompt } from '../promptBox'
import LinkContextMenu, { type LinkMenuState } from '../LinkContextMenu'
import { chatContextMenuAt } from './chatContextMenu'
import { handleCodeCopyClick, handleCodeRunClick } from './markdown'

interface Props {
  tabId: string
  visible: boolean
  sessionId?: string
  projectId: string
  taskId: string
  projectDir: string
  sshConfig?: SshConfig
  /** The project's extra Claude CLI args (shared with the terminal tab). */
  extraArgs?: string
}

/**
 * Claude Code as a chat: the same `claude` binary, login, settings and session
 * files as the terminal tab, driven from main through the Agent SDK. This
 * component only draws main's state and sends intents back; the process keeps
 * running while the tab is hidden, like a PTY.
 *
 * Status (the tab dot, the inbox) comes from the same hook events and the same
 * state machine as the terminal tab — main sends the SDK's in-process hooks on
 * the channels the curl hooks use.
 */
export default function ClaudeChatTab({ tabId, visible, sessionId, projectId, taskId, projectDir, sshConfig, extraArgs }: Props): React.ReactElement {
  const { addTab, updateTabSessionId, markTaskInteracted, markTaskEvent, convertClaudeTab } = useApp()
  const statusStore = useTabStatusStore()
  const state = useChatState(tabId)
  const attachedRef = useRef(false)
  const visibleRef = useRef(visible)
  visibleRef.current = visible
  const scrollRef = useRef<HTMLDivElement>(null)
  const stickRef = useRef(true)
  const [atBottom, setAtBottom] = useState(true)
  const [attachError, setAttachError] = useState<string | null>(null)
  const [focus, setFocus] = useState<TimelineFocus | null>(null)
  const focusSeq = useRef(0)
  const [side, setSide] = useState<SideQuestionState | null>(null)
  const sideSeq = useRef(0)
  const [linkMenu, setLinkMenu] = useState<LinkMenuState | null>(null)
  const [permissionsOpen, setPermissionsOpen] = useState(false)

  const applyStatus = useCallback((event: AiStatusEvent, notificationKind?: AiNotificationKind, backgroundTasks?: number): AiStatusDecision => {
    const current = statusStore.getStatus(tabId)
    const decision = nextAiStatus(current, event, {
      isHookTab: true,
      visible: visibleRef.current,
      windowFocused: document.hasFocus(),
      notificationKind,
      backgroundTasks
    })
    if (decision !== 'keep') statusStore.setStatus(tabId, decision, event)
    return decision
  }, [statusStore, tabId])

  // Status from hooks — identical to the terminal Claude tab.
  useEffect(() => {
    hookStatusCallbacks.set(tabId, {
      onWorking: () => { applyStatus('hook-working') },
      onStopped: (backgroundTasks) => {
        applyStatus('hook-stopped', undefined, backgroundTasks)
        markTaskEvent(projectId, taskId)
      },
      onNotification: (body) => {
        const decision = applyStatus('hook-notification', classifyNotification(body))
        if (decision === 'attention') markTaskEvent(projectId, taskId, 'attention')
        else if (decision === null) markTaskEvent(projectId, taskId)
      },
      onActivity: (statusEvent) => {
        if (!statusEvent) return
        const decision = applyStatus(statusEvent)
        if (decision === 'attention') markTaskEvent(projectId, taskId, 'attention')
      },
      onSessionStart: (body) => {
        const next = body.session_id
        if (typeof next === 'string' && next && next !== sessionId) updateTabSessionId(projectId, taskId, tabId, next)
      }
    })
    ensureHookListeners()
    setChatEventHandler(tabId, (event) => {
      // A process that died on its own (crash, ssh drop) is the terminal tab's "exited".
      if (event.t === 'process' && event.state === 'exited' && event.error) {
        applyStatus('exit')
        markTaskEvent(projectId, taskId)
      }
      if (event.t === 'process' && event.state === 'starting' && statusStore.getStatus(tabId) === 'exited') {
        statusStore.setStatus(tabId, null, 'chat-restart')
      }
    })
  }, [tabId, projectId, taskId, sessionId, applyStatus, markTaskEvent, updateTabSessionId, statusStore])

  // Attach once the tab is first shown; stay attached while hidden (the process runs on).
  useEffect(() => {
    if (!visible || attachedRef.current || !sessionId) return
    attachedRef.current = true
    setAttachError(null)
    attachChat(tabId, {
      cwd: projectDir,
      sessionId,
      projectId,
      sshConfig,
      extraArgs: parseExtraArgs(extraArgs)
    }).then(() => {
      // A window attaching mid-turn (reload, a second window) learns the status from
      // the snapshot: the hook events that set it went by before it was listening.
      const snapshot = getChatState(tabId)
      if (snapshot.pending.length > 0) applyStatus('hook-needs-input')
      else if (snapshot.busy || Object.values(snapshot.tasks).some((task) => task.background && task.status === 'running' && (task.kind === 'subagent' || task.kind === 'workflow'))) {
        applyStatus('hook-working')
      }
      // Opened from an empty task's prompt box: apply its choices, then send.
      const first = takePendingPrompt(tabId)
      if (!first) return
      markTaskInteracted(projectId, taskId)
      void (async () => {
        if (first.mode) await window.api.chatSetMode(tabId, first.mode)
        if (first.model) await window.api.chatSetModel(tabId, first.model)
        if (first.effort) await window.api.chatSetEffort(tabId, first.effort)
        await window.api.chatSend(tabId, first.text, first.images)
      })().catch((err: unknown) => {
        setAttachError(err instanceof Error ? err.message : String(err))
      })
    }).catch((err: unknown) => {
      attachedRef.current = false
      setAttachError(err instanceof Error ? err.message : String(err))
    })
  }, [visible, tabId, sessionId, projectDir, projectId, sshConfig, extraArgs, applyStatus, markTaskInteracted, taskId])

  useEffect(() => {
    if (visible) applyStatus('visit')
  }, [visible, applyStatus])

  // Closing (or converting) the tab ends its process and forgets this window's copy.
  useEffect(() => {
    const handler = (e: Event): void => {
      if ((e as CustomEvent).detail?.tabId !== tabId) return
      window.api.chatClose(tabId)
      forgetChat(tabId)
      hookStatusCallbacks.delete(tabId)
      statusStore.removeTab(tabId)
      attachedRef.current = false
    }
    window.addEventListener('tab-removed', handler)
    return () => window.removeEventListener('tab-removed', handler)
  }, [tabId, statusStore])

  // Follow the conversation while you are at the bottom; leave it alone once you scroll up.
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el || !visible) return
    if (stickRef.current) el.scrollTop = el.scrollHeight
  }, [state.items, state.pending, state.busy, visible])

  // A growing composer (or prompt card) shrinks the timeline from below: keep the
  // bottom edge where it was, so the last line stays in view instead of going under it.
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    let height = el.clientHeight
    const observer = new ResizeObserver(() => {
      const next = el.clientHeight
      // Hidden tabs report 0; their next show is handled by the follow effect.
      if (next === 0 || height === 0) { height = next; return }
      if (stickRef.current) el.scrollTop = el.scrollHeight
      else if (next !== height) el.scrollTop += height - next
      height = next
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  const onScroll = (): void => {
    const el = scrollRef.current
    if (!el) return
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40
    stickRef.current = bottom
    if (bottom !== atBottom) setAtBottom(bottom)
  }

  const jumpToBottom = (): void => {
    const el = scrollRef.current
    if (!el) return
    stickRef.current = true
    setAtBottom(true)
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
  }

  const send = useCallback((text: string, images: ChatImage[]) => {
    markTaskInteracted(projectId, taskId)
    stickRef.current = true
    void window.api.chatSend(tabId, text, images).catch((err: unknown) => {
      setAttachError(err instanceof Error ? err.message : String(err))
    })
  }, [tabId, projectId, taskId, markTaskInteracted])

  // One side question at a time, like the CLI: a new one replaces the last, and a
  // dismissed one's late answer is dropped.
  const askSideQuestion = useCallback((question: string) => {
    sideSeq.current += 1
    const id = sideSeq.current
    setSide({ id, question, status: 'asking' })
    const settle = (next: Partial<SideQuestionState>): void => {
      setSide((current) => (current?.id === id ? { ...current, ...next } : current))
    }
    window.api.chatSideQuestion(tabId, question).then((answer) => {
      if (answer.response === null) settle({ status: 'error', error: 'No answer came back.' })
      else settle({ status: 'done', answer: answer.response })
    }).catch((err: unknown) => {
      const raw = err instanceof Error ? err.message : String(err)
      settle({ status: 'error', error: raw.replace(/^Error invoking remote method '[^']+': (?:Error: )?/u, '') })
    })
  }, [tabId])

  // `!command`: main runs it; its row lands in the timeline like any event.
  const runBash = useCallback((command: string) => {
    markTaskInteracted(projectId, taskId)
    stickRef.current = true
    void window.api.chatBash(tabId, command).catch((err: unknown) => {
      setAttachError(err instanceof Error ? err.message : String(err))
    })
  }, [tabId, projectId, taskId, markTaskInteracted])

  const commands = useMemo(() => composerCommands(state.commands), [state.commands])

  const reportError = useCallback((err: unknown) => {
    setAttachError(err instanceof Error ? err.message : String(err))
  }, [])
  const login = useCallback((method: ChatLoginMethod) => {
    void window.api.chatLogin(tabId, method).catch(reportError)
  }, [tabId, reportError])
  const logout = useCallback(() => {
    if (!window.confirm('Sign out of Claude? Every Claude tab and terminal on this machine uses the same login.')) return
    void window.api.chatLogout(tabId).catch(reportError)
  }, [tabId, reportError])

  const respond = useCallback((promptId: string, response: ChatPromptResponse) => {
    markTaskInteracted(projectId, taskId)
    void window.api.chatRespond(tabId, promptId, response)
  }, [tabId, projectId, taskId, markTaskInteracted])

  const openLink = useCallback((url: string) => {
    addTab(projectId, taskId, { withTab: tabId }, 'browser', { url: normalizeBrowserUrl(url) })
  }, [addTab, projectId, taskId, tabId])

  const openContextMenu = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const menu = chatContextMenuAt(e.target as Element, e.currentTarget, window.getSelection(), e.clientX, e.clientY)
    if (!menu) return
    e.preventDefault()
    setLinkMenu(menu)
  }, [])

  const openInTerminal = useCallback(() => {
    convertClaudeTab(projectId, taskId, tabId, 'claude')
  }, [convertClaudeTab, projectId, taskId, tabId])

  const loadFiles = useCallback(
    () => window.api.chatListFiles(projectDir, projectId, sshConfig),
    [projectDir, projectId, sshConfig]
  )

  const { toolIndex } = state
  // A subagent's own shells are part of its row, not tasks of their own.
  const tasks = useMemo(() => {
    const all = state.tasks
    if (!Object.values(all).some((task) => task.nested)) return all
    return Object.fromEntries(Object.entries(all).filter(([, task]) => !task.nested))
  }, [state.tasks])
  const taskTools = useMemo(() => {
    const ids = new Set<string>()
    for (const task of Object.values(tasks)) {
      if (task.status === 'running' && task.toolUseId) ids.add(task.toolUseId)
    }
    return ids
  }, [tasks])

  const reportTaskError = useCallback((err: unknown) => {
    setAttachError(err instanceof Error ? err.message : String(err))
  }, [])
  const stopTask = useCallback((taskId: string) => {
    void window.api.chatStopTask(tabId, taskId).catch(reportTaskError)
  }, [tabId, reportTaskError])
  const backgroundTask = useCallback((toolUseId: string) => {
    void window.api.chatBackgroundTask(tabId, toolUseId).catch(reportTaskError)
  }, [tabId, reportTaskError])
  const canJump = useCallback((toolUseId: string) => toolIndex[toolUseId] !== undefined, [toolIndex])
  const jumpToTool = useCallback((toolUseId: string) => {
    if (toolIndex[toolUseId] === undefined) return
    // Looking back up the conversation: stop following the bottom.
    stickRef.current = false
    focusSeq.current += 1
    setFocus({ toolId: toolUseId, seq: focusSeq.current })
  }, [toolIndex])

  const [dismissedCache, setDismissedCache] = useState<ChatColdCache | null>(null)
  const coldCache = state.coldCache && state.coldCache !== dismissedCache ? state.coldCache : null

  const hasTasks = Object.keys(tasks).length > 0
  const empty = state.items.length === 0 && !state.busy
  const starting = state.process === 'starting' && state.items.length === 0

  return (
    <div
      className="absolute inset-0 flex-col bg-bg"
      style={{ display: visible ? 'flex' : 'none' }}
      onKeyDownCapture={() => noteAgentTabTyped(taskId, tabId)}
      onClick={(e) => { if (handleCodeCopyClick(e.target) || handleCodeRunClick(e.target, runBash)) e.preventDefault() }}
      onContextMenu={openContextMenu}
    >
      <div className="flex-1 min-h-0 relative">
        <div className="absolute top-2 right-3 z-(--z-sticky)">
          <TaskIndicator tasks={tasks} onStop={stopTask} onBackground={backgroundTask} onJump={jumpToTool} canJump={canJump} />
        </div>
        <div ref={scrollRef} onScroll={onScroll} className="h-full overflow-y-auto relative">
          {/* Room for the task pill so it never covers the first message. */}
          <div className={`max-w-[860px] mx-auto px-5 pb-3 ${hasTasks ? 'pt-11' : 'pt-4'}`}>
            {empty ? (
              <div className="pt-[18vh] text-center select-none">
                <div className="text-2xl text-accent mb-2">&#10022;</div>
                <div className="text-md text-text">{starting ? 'Starting Claude…' : 'What should Claude work on?'}</div>
                <div className="text-sm text-text-subtle mt-1 font-mono truncate">{projectDir || sshConfig?.remoteDir || '~'}</div>
              </div>
            ) : (
              <Timeline
                items={state.items}
                busy={state.busy}
                compacting={state.compacting}
                waiting={state.pending.length > 0}
                turnStartedAt={state.turnStartedAt}
                onOpenLink={openLink}
                taskTools={taskTools}
                focus={focus}
              />
            )}
          </div>
        </div>
      </div>
      {/* Capped at half the tab so a tall prompt card can't push the conversation out of
          view: the prompt stack is what gives (its cards scroll inside); the composer keeps its size. */}
      <div className="max-w-[860px] w-full max-h-[50%] min-h-0 mx-auto px-5 pb-3 flex flex-col gap-2 relative">
        {!atBottom && (
          <button
            type="button"
            onClick={jumpToBottom}
            className="absolute -top-9 left-1/2 -translate-x-1/2 h-6 px-2.5 inline-flex items-center gap-1 rounded-full border-[0.5px] border-border bg-surface-2 text-xs text-text-muted shadow-pop cursor-pointer hover:text-text"
          >
            <ArrowDown size={11} /> Latest
          </button>
        )}
        {attachError && (
          <div className="text-sm text-danger rounded-md border border-[color-mix(in_srgb,var(--color-danger)_35%,transparent)] px-2 py-1">{attachError}</div>
        )}
        {state.pending.length > 0 && (
          <div className="min-h-0 flex flex-col gap-2">
            {state.pending.map((prompt) => (
              <PromptCard key={prompt.id} prompt={prompt} permissionMode={state.info.permissionMode} onRespond={(response) => respond(prompt.id, response)} />
            ))}
          </div>
        )}
        {coldCache && <ColdCacheNotice cache={coldCache} onDismiss={() => setDismissedCache(coldCache)} />}
        {state.login && (
          <LoginCard
            login={state.login}
            onSubmitCode={(code) => { void window.api.chatLoginCode(tabId, code).catch(reportError) }}
            onRetry={login}
            onOpenUrl={(url) => { void window.api.openExternal(url).catch(reportError) }}
            onDismiss={() => { void window.api.chatLoginDismiss(tabId) }}
          />
        )}
        {side && <SideQuestion side={side} onDismiss={() => setSide(null)} onOpenLink={openLink} />}
        <Composer
          busy={state.busy}
          info={state.info}
          usage={state.usage}
          models={state.models}
          commands={commands}
          loadFiles={loadFiles}
          onSend={send}
          onSideQuestion={askSideQuestion}
          onBash={runBash}
          onPermissions={() => setPermissionsOpen(true)}
          onLogin={login}
          onLogout={logout}
          onStop={() => { void window.api.chatInterrupt(tabId) }}
          onSetModel={(model) => { void window.api.chatSetModel(tabId, model) }}
          onSetMode={(mode) => { void window.api.chatSetMode(tabId, mode) }}
          onSetEffort={(effort) => { void window.api.chatSetEffort(tabId, effort) }}
          onOpenInTerminal={openInTerminal}
          focusSignal={visible}
          tabId={tabId}
        />
      </div>
      <LinkContextMenu menu={linkMenu} onClose={() => setLinkMenu(null)} onOpenInApp={openLink} />
      {permissionsOpen && (
        <PermissionsDialog
          cwd={sshConfig ? null : projectDir}
          projectId={projectId}
          permissionMode={state.info.permissionMode}
          onClose={() => setPermissionsOpen(false)}
          onOpenInTerminal={openInTerminal}
        />
      )}
    </div>
  )
}
