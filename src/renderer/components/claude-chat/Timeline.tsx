import React, { createContext, memo, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { Check, ChevronRight, CircleSlash, X } from 'lucide-react'
import type { ChatBashItem, ChatImage, ChatItem, ChatToolItem } from '../../../shared/claude-chat'
import { firstLine } from '../../../shared/agent-activity'
import { buildTimeline, summarizeGroup, type TimelineRow } from './timelineRows'
import { renderChatMarkdown } from './markdown'
import { diffLines, diffStats, editPairs } from './diff'
import DiffView from './DiffView'

interface Props {
  items: ChatItem[]
  busy: boolean
  compacting: boolean
  /** A prompt is open: the turn is waiting on you, not working. */
  waiting: boolean
  turnStartedAt?: number
  /** Links in messages open as DevTool browser tabs. */
  onOpenLink: (url: string) => void
  /** Tool calls whose task (a backgrounded agent or shell) still runs past its result. */
  taskTools?: ReadonlySet<string>
  /** Scroll to this tool call and flash it; a new `seq` asks again. */
  focus?: TimelineFocus | null
}

export interface TimelineFocus {
  toolId: string
  seq: number
}

interface TimelineContextValue {
  taskTools: ReadonlySet<string>
  focus: TimelineFocus | null
  /** True the first time a row claims a focus request; rows remounting later don't re-scroll. */
  claim: (focus: TimelineFocus) => boolean
}

const NO_TOOLS: ReadonlySet<string> = new Set()
const TimelineContext = createContext<TimelineContextValue>({ taskTools: NO_TOOLS, focus: null, claim: () => false })

const FLASH_MS = 1400

export default function Timeline({ items, busy, compacting, waiting, turnStartedAt, onOpenLink, taskTools = NO_TOOLS, focus = null }: Props): React.ReactElement {
  const rows = useMemo(() => buildTimeline(items, busy), [items, busy])
  const claimed = useRef(-1)
  const context = useMemo<TimelineContextValue>(() => ({
    taskTools,
    focus,
    claim: (request) => {
      if (claimed.current >= request.seq) return false
      claimed.current = request.seq
      return true
    }
  }), [taskTools, focus])
  const activeTool = useMemo(() => {
    for (let i = items.length - 1; i >= 0; i--) {
      const item = items[i]
      if (item.kind === 'tool' && (item.status === 'running' || item.status === 'pending')) return item
      if (item.kind === 'user') break
    }
    return null
  }, [items])

  return (
    <TimelineContext.Provider value={context}>
      <div
        className="flex flex-col gap-1.5"
        onClick={(e) => {
          const anchor = (e.target as HTMLElement).closest('a')
          const href = anchor?.getAttribute('href')
          if (!anchor || !href) return
          e.preventDefault()
          if (/^https?:\/\//i.test(href)) onOpenLink(href)
        }}
      >
        {rows.map((row) => <Row key={row.key} row={row} />)}
        {busy && <WorkingLine compacting={compacting} waiting={waiting} since={turnStartedAt} tool={activeTool} />}
      </div>
    </TimelineContext.Provider>
  )
}

const Row = memo(function Row({ row }: { row: TimelineRow }): React.ReactElement | null {
  if (row.type === 'group') return <ToolGroup tools={row.tools} />
  const { item } = row
  switch (item.kind) {
    case 'user':
      return <UserMessage item={item} />
    case 'text':
      return <AssistantText text={item.text} streaming={item.streaming} />
    case 'thinking':
      return <Thinking text={item.text} streaming={item.streaming} />
    case 'tool':
      return <ToolRow tool={item} />
    case 'notice':
      return <Notice text={item.text} tone={item.tone} />
    case 'bash':
      return <BashRow item={item} />
  }
})

/** A `!command` you ran: output open by default, since you asked to see it. */
function BashRow({ item }: { item: ChatBashItem }): React.ReactElement {
  const [open, setOpen] = useState(true)
  const failed = !item.running && item.exitCode !== undefined && item.exitCode !== 0
  const status: ChatToolItem['status'] = item.running ? 'running' : failed ? 'error' : 'done'
  const meta = [
    failed ? (item.exitCode === null ? 'killed' : `exit ${item.exitCode}`) : undefined,
    item.pendingContext ? 'Claude sees this with your next message' : undefined
  ].filter(Boolean).join(' · ')
  const hasOutput = Boolean(item.stdout || item.stderr)
  return (
    <div className="text-sm">
      <button type="button" className="chat-row-btn w-full" onClick={() => setOpen(!open)}>
        <StatusIcon status={status} />
        <span className="truncate font-mono text-text"><span className="text-accent">!</span> {firstLine(item.command, 200) ?? ''}</span>
        {meta && <span className="ml-auto pl-3 shrink-0 text-xs text-text-subtle">{meta}</span>}
      </button>
      {open && (item.command.includes('\n') || hasOutput) && (
        <div className="ml-5 mt-1 mb-1.5 flex flex-col gap-1">
          {item.command.includes('\n') && <Pre>{`$ ${item.command}`}</Pre>}
          {item.stdout && <Pre>{item.stdout}</Pre>}
          {item.stderr && <Pre tone={failed ? 'error' : undefined}>{item.stderr}</Pre>}
        </div>
      )}
      {open && !item.running && !hasOutput && <div className="ml-5 text-xs text-text-subtle">No output</div>}
    </div>
  )
}

function UserMessage({ item }: { item: Extract<ChatItem, { kind: 'user' }> }): React.ReactElement {
  return (
    <div className={`mt-3 first:mt-0 flex gap-2 ${item.queued ? 'opacity-60' : ''}`}>
      <div className="flex-1 min-w-0 rounded-lg bg-surface-2 border-[0.5px] border-border px-3 py-2 text-base text-text whitespace-pre-wrap break-words">
        {item.text || (item.images > 0 ? '' : ' ')}
        {item.images > 0 && (
          <span className="inline-block mt-0.5 mr-1 text-xs text-text-muted">
            {item.images === 1 ? '1 image' : `${item.images} images`}
          </span>
        )}
        {(item.queued || item.failed) && (
          <div className={`mt-1 text-xs ${item.failed ? 'text-danger' : 'text-text-muted'}`}>
            {item.failed ? 'Not delivered — Claude stopped before reading it' : 'Queued — Claude reads it at its next step'}
          </div>
        )}
      </div>
    </div>
  )
}

const AssistantText = memo(function AssistantText({ text, streaming }: { text: string; streaming?: boolean }): React.ReactElement {
  const html = useMemo(() => renderChatMarkdown(text), [text])
  return (
    <div className={`note-preview chat-md text-base text-text break-words${streaming ? ' chat-streaming' : ''}`}
      // Sanitized by DOMPurify in renderChatMarkdown.
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
})

/** Past this, a note is full summarized thinking rather than a progress update, and starts clamped. */
const LONG_THINKING = 280

/** Thinking with text: usually a one-line progress update between calls, shown as is. */
const Thinking = memo(function Thinking({ text, streaming }: { text: string; streaming?: boolean }): React.ReactElement {
  const [open, setOpen] = useState(false)
  const html = useMemo(() => renderChatMarkdown(text), [text])
  const long = text.length > LONG_THINKING
  return (
    <div
      className={`note-preview chat-md text-sm text-text-muted break-words${streaming ? ' chat-streaming' : ''}${long && !open ? ' line-clamp-3 cursor-pointer' : ''}`}
      title={long && !open ? 'Show all' : undefined}
      onClick={long && !open ? () => setOpen(true) : undefined}
      // Sanitized by DOMPurify in renderChatMarkdown.
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
})

function Notice({ text, tone }: { text: string; tone: 'muted' | 'warning' | 'error' }): React.ReactElement {
  const color = tone === 'error'
    ? 'text-danger border-[color-mix(in_srgb,var(--color-danger)_35%,transparent)] bg-[color-mix(in_srgb,var(--color-danger)_8%,transparent)]'
    : tone === 'warning'
      ? 'text-warn border-[color-mix(in_srgb,var(--color-warn)_35%,transparent)] bg-[color-mix(in_srgb,var(--color-warn)_8%,transparent)]'
      : 'text-text-muted border-transparent'
  return (
    <div className={`text-sm whitespace-pre-wrap break-words rounded-md border px-2 py-1 ${color}`}>{text}</div>
  )
}

function StatusIcon({ status }: { status: ChatToolItem['status'] }): React.ReactElement {
  switch (status) {
    case 'pending':
    case 'running':
      return <span className="w-3 h-3 flex items-center justify-center shrink-0"><span className="w-1.5 h-1.5 rounded-full bg-accent status-pulse" /></span>
    case 'waiting':
      return <span className="w-3 h-3 flex items-center justify-center shrink-0"><span className="w-1.5 h-1.5 rounded-full bg-status-attention" /></span>
    case 'done':
      return <Check size={12} className="shrink-0 text-text-subtle" />
    case 'error':
      return <X size={12} className="shrink-0 text-danger" />
    case 'denied':
      return <CircleSlash size={12} className="shrink-0 text-text-subtle" />
  }
}

function toolMeta(tool: ChatToolItem): string | undefined {
  const pairs = editPairs(tool.name, tool.input)
  if (pairs) {
    const stats = pairs.map((pair) => diffStats(diffLines(pair.before, pair.after)))
    const added = stats.reduce((sum, s) => sum + s.added, 0)
    const removed = stats.reduce((sum, s) => sum + s.removed, 0)
    return tool.name === 'Write' ? `${added} lines` : `+${added} −${removed}`
  }
  if ((tool.name === 'Agent' || tool.name === 'Task') && tool.childCount) {
    return tool.status === 'running' && tool.lastChild
      ? `${tool.lastChild} · ${tool.childCount} calls`
      : `${tool.childCount} calls`
  }
  if (tool.status === 'denied') return 'denied'
  return undefined
}

/**
 * A backgrounded agent or shell got its "running in the background" result
 * straight away; while its task runs, the row says so instead of showing done.
 */
function inBackground(tool: ChatToolItem, taskTools: ReadonlySet<string>): boolean {
  return tool.status === 'done' && taskTools.has(tool.id)
}

/** Scroll a row into view and flash it when the timeline is asked to focus its tool call. */
function useFocusFlash(toolId: string): { ref: React.RefObject<HTMLDivElement | null>; flash: boolean } {
  const { focus, claim } = useContext(TimelineContext)
  const ref = useRef<HTMLDivElement>(null)
  const [flash, setFlash] = useState(false)
  useEffect(() => {
    if (!focus || focus.toolId !== toolId || !claim(focus)) return
    ref.current?.scrollIntoView?.({ block: 'center', behavior: 'smooth' })
    setFlash(true)
    const timer = window.setTimeout(() => setFlash(false), FLASH_MS)
    return () => window.clearTimeout(timer)
  }, [focus, toolId, claim])
  return { ref, flash }
}

/** `inGroup`: the group row already shows the images. */
const ToolRow = memo(function ToolRow({ tool, inGroup }: { tool: ChatToolItem; inGroup?: boolean }): React.ReactElement {
  const isTodo = tool.name === 'TodoWrite'
  const [open, setOpen] = useState(false)
  const { taskTools } = useContext(TimelineContext)
  const { ref, flash } = useFocusFlash(tool.id)
  const background = inBackground(tool, taskTools)
  const meta = useMemo(() => toolMeta(tool), [tool])
  if (isTodo) return <TodoList tool={tool} />
  return (
    <div
      ref={ref}
      data-tool-id={tool.id}
      className={`text-sm rounded-sm transition-colors duration-(--motion-med) ${flash ? 'bg-sel' : ''}`}
    >
      <button type="button" className="chat-row-btn w-full" onClick={() => setOpen(!open)}>
        <StatusIcon status={background ? 'running' : tool.status} />
        <span className={`truncate ${tool.status === 'denied' ? 'text-text-subtle line-through decoration-text-subtle/50' : 'text-text-muted'}`}>{tool.label}</span>
        {(meta || background) && (
          <span className="ml-auto pl-3 shrink-0 text-xs text-text-subtle tabular-nums">
            {[background ? 'in background' : undefined, meta].filter(Boolean).join(' · ')}
          </span>
        )}
      </button>
      {open && <ToolDetail tool={tool} />}
      {!inGroup && tool.images && tool.images.length > 0 && <ToolImages images={tool.images} />}
    </div>
  )
})

/** Result images in one row of thumbnails; click one to see it full width below. */
function ToolImages({ images }: { images: ChatImage[] }): React.ReactElement {
  const [expanded, setExpanded] = useState<number | null>(null)
  const urls = useMemo(() => images.map((image) => `data:${image.mediaType};base64,${image.data}`), [images])
  const shown = expanded !== null ? urls[expanded] : undefined
  return (
    <div className="ml-5 mt-1 mb-1.5 flex flex-col gap-1.5">
      <div className="flex flex-wrap gap-1.5">
        {urls.map((url, index) => (
          <button
            key={index}
            type="button"
            className={`block rounded-md cursor-zoom-in ${index === expanded ? 'ring-1 ring-accent' : ''}`}
            title={index === expanded ? 'Hide' : 'Show full size'}
            onClick={() => setExpanded(index === expanded ? null : index)}
          >
            <img src={url} alt="" className="h-24 w-auto max-w-60 rounded-md border-[0.5px] border-border object-contain" />
          </button>
        ))}
      </div>
      {shown && (
        <button type="button" className="block max-w-full cursor-zoom-out" title="Hide" onClick={() => setExpanded(null)}>
          <img src={shown} alt="" className="max-w-full rounded-md border-[0.5px] border-border" />
        </button>
      )}
    </div>
  )
}

function ToolGroup({ tools }: { tools: ChatToolItem[] }): React.ReactElement {
  const [open, setOpen] = useState(false)
  const { taskTools, focus } = useContext(TimelineContext)
  const openedFor = useRef(-1)
  // Jumping to a call folded in here opens the group (once per request); the row
  // itself then scrolls and flashes.
  useEffect(() => {
    if (!focus || openedFor.current >= focus.seq || !tools.some((tool) => tool.id === focus.toolId)) return
    openedFor.current = focus.seq
    setOpen(true)
  }, [focus, tools])
  const running = tools.some((tool) => tool.status === 'running' || tool.status === 'pending' || inBackground(tool, taskTools))
  const failed = tools.some((tool) => tool.status === 'error')
  const images = useMemo(() => tools.flatMap((tool) => tool.images ?? []), [tools])
  return (
    <div className="text-sm">
      <button type="button" className="chat-row-btn w-full" onClick={() => setOpen(!open)}>
        <StatusIcon status={running ? 'running' : failed ? 'error' : 'done'} />
        <span className="text-text-muted truncate">{summarizeGroup(tools)}</span>
        <ChevronRight size={12} className={`ml-auto shrink-0 text-text-subtle transition-transform duration-(--motion-fast) ${open ? 'rotate-90' : ''}`} />
      </button>
      {open && (
        <div className="ml-5 mt-0.5 flex flex-col gap-0.5 border-l border-border pl-2">
          {tools.map((tool) => <ToolRow key={tool.id} tool={tool} inGroup />)}
        </div>
      )}
      {images.length > 0 && <ToolImages images={images} />}
    </div>
  )
}

function TodoList({ tool }: { tool: ChatToolItem }): React.ReactElement {
  const todos = Array.isArray(tool.input.todos) ? tool.input.todos as Record<string, unknown>[] : []
  return (
    <div className="text-sm rounded-md border-[0.5px] border-border bg-surface px-2.5 py-1.5 my-0.5">
      {todos.map((todo, index) => {
        const status = todo.status
        const text = String((status === 'in_progress' ? todo.activeForm : null) ?? todo.content ?? '')
        return (
          <div key={index} className="flex items-baseline gap-2 py-px">
            <span className={`w-3 shrink-0 text-center ${status === 'completed' ? 'text-success' : status === 'in_progress' ? 'text-accent' : 'text-text-subtle'}`}>
              {status === 'completed' ? '✓' : status === 'in_progress' ? '▸' : '○'}
            </span>
            <span className={status === 'completed' ? 'text-text-subtle line-through' : status === 'in_progress' ? 'text-text' : 'text-text-muted'}>{text}</span>
          </div>
        )
      })}
    </div>
  )
}

function Pre({ children, tone }: { children: React.ReactNode; tone?: 'error' }): React.ReactElement {
  return (
    <pre className={`chat-pre ${tone === 'error' ? 'text-danger' : 'text-text-muted'}`}>{children}</pre>
  )
}

function ToolDetail({ tool }: { tool: ChatToolItem }): React.ReactElement {
  const input = tool.input
  const pairs = editPairs(tool.name, input)
  const showResult = tool.result && !(pairs && tool.status === 'done')
  let body: React.ReactNode
  if (pairs) {
    body = (
      <>
        {typeof input.file_path === 'string' && <div className="text-xs text-text-subtle font-mono truncate">{input.file_path}</div>}
        {pairs.map((pair, index) => <DiffView key={index} lines={diffLines(pair.before, pair.after)} />)}
      </>
    )
  } else if ((tool.name === 'Bash' || tool.name === 'PowerShell') && typeof input.command === 'string') {
    body = <Pre>{`$ ${input.command}`}</Pre>
  } else if (typeof input.file_path === 'string' && Object.keys(input).length <= 3) {
    body = <div className="text-xs text-text-subtle font-mono truncate">{input.file_path}</div>
  } else if ((tool.name === 'Agent' || tool.name === 'Task') && typeof input.prompt === 'string') {
    body = <Pre>{input.prompt}</Pre>
  } else if (Object.keys(input).length > 0) {
    body = <Pre>{JSON.stringify(input, null, 2)}</Pre>
  }
  return (
    <div className="ml-5 mt-1 mb-1.5 flex flex-col gap-1">
      {body}
      {showResult && <Pre tone={tool.status === 'error' ? 'error' : undefined}>{tool.result}</Pre>}
    </div>
  )
}

function WorkingLine({ compacting, waiting, since, tool }: { compacting: boolean; waiting: boolean; since?: number; tool: ChatToolItem | null }): React.ReactElement {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [])
  const seconds = since ? Math.max(0, Math.floor((now - since) / 1000)) : null
  const elapsed = seconds === null ? '' : seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`
  const label = waiting ? 'Waiting for you' : compacting ? 'Compacting context' : tool ? tool.label : 'Working'
  return (
    <div className="flex items-center gap-2 text-sm text-text-muted py-0.5">
      <span className="w-3 h-3 flex items-center justify-center shrink-0">
        <span className={`w-1.5 h-1.5 rounded-full ${waiting ? 'bg-status-attention' : 'bg-accent status-pulse'}`} />
      </span>
      <span className="truncate">{label}</span>
      {elapsed && <span className="text-xs text-text-subtle tabular-nums">{elapsed}</span>}
      {!waiting && <span className="text-xs text-text-subtle">· esc to stop</span>}
    </div>
  )
}
