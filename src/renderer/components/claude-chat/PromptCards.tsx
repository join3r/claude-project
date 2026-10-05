import React, { useMemo, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { CHAT_PERMISSION_MODES, type ChatPrompt, type ChatPromptResponse } from '../../../shared/claude-chat'
import { summarizeTool } from '../../../shared/agent-activity'
import {
  canAlwaysAllow,
  dismissQuestionResponse,
  joinAnswerLabels,
  planApprovalResponse,
  planFeedbackResponse,
  planText,
  promptQuestions,
  questionAnswerResponse,
  type PromptQuestion
} from '../../../shared/chat-prompts'
import { renderChatMarkdown } from './markdown'
import DiffView from './DiffView'
import { diffLines, editPairs } from './diff'

interface Props {
  prompt: ChatPrompt
  onRespond: (response: ChatPromptResponse) => void
  /** The session's permission mode, so a card doesn't offer the one already on. */
  permissionMode?: string
}

const btn = 'inline-flex items-center h-(--ctl-h-sm) px-2.5 rounded-md border-[0.5px] text-sm cursor-pointer transition-colors duration-(--motion-fast) disabled:opacity-50 disabled:cursor-not-allowed'
export const primaryBtn = `${btn} border-transparent bg-accent text-accent-ink hover:brightness-105`
export const secondaryBtn = `${btn} border-border bg-surface-2 text-text hover:bg-surface-3`
export const quietBtn = `${btn} border-transparent bg-transparent text-text-muted hover:text-text hover:bg-surface-2`

interface CardProps {
  title: string
  /** One line shown beside the title while the card is collapsed. */
  summary?: string
  children: React.ReactNode
  /** The actions: pinned below the body, which scrolls when the dock runs out of room. */
  footer: React.ReactNode
}

function Card({ title, summary, children, footer }: CardProps): React.ReactElement {
  // Collapsing gets a tall card out of the way so the conversation above it can be read.
  const [collapsed, setCollapsed] = useState(false)
  return (
    <div className="min-h-0 flex flex-col rounded-lg border border-[color-mix(in_srgb,var(--color-status-attention)_45%,var(--color-border))] bg-surface shadow-pop overflow-hidden">
      <button
        type="button"
        aria-expanded={!collapsed}
        title={collapsed ? 'Show' : 'Collapse'}
        onClick={() => setCollapsed((c) => !c)}
        className={`shrink-0 w-full px-3 pt-2 ${collapsed ? 'pb-2' : 'pb-1'} text-left text-sm font-medium text-text flex items-center gap-2 cursor-pointer`}
      >
        <span className="w-1.5 h-1.5 rounded-full bg-status-attention shrink-0" />
        <span className="truncate shrink-0 max-w-[60%]">{title}</span>
        {collapsed && summary && <span className="min-w-0 truncate font-normal text-text-muted">{summary}</span>}
        <ChevronDown size={13} className={`ml-auto shrink-0 text-text-subtle transition-transform duration-(--motion-fast) ${collapsed ? 'rotate-180' : ''}`} />
      </button>
      {!collapsed && (
        <>
          <div className="min-h-0 overflow-y-auto px-3 pb-2 flex flex-col gap-2">{children}</div>
          <div className="shrink-0 px-3 pb-2.5 flex flex-col gap-2">{footer}</div>
        </>
      )}
    </div>
  )
}

export default function PromptCard({ prompt, onRespond, permissionMode }: Props): React.ReactElement {
  if (prompt.kind === 'question') return <QuestionCard prompt={prompt} onRespond={onRespond} />
  if (prompt.kind === 'plan') return <PlanCard prompt={prompt} onRespond={onRespond} />
  return <PermissionCard prompt={prompt} onRespond={onRespond} permissionMode={permissionMode} />
}

/** Modes that already skip this prompt's kind of question: no point offering to switch to them. */
const NO_AUTO_OFFER = new Set(['auto', 'bypassPermissions'])

function PermissionCard({ prompt, onRespond, permissionMode }: Props): React.ReactElement {
  const [denying, setDenying] = useState(false)
  const [reason, setReason] = useState('')
  const input = prompt.input
  const pairs = editPairs(prompt.toolName, input)
  const canAlways = canAlwaysAllow(prompt)
  const always = canAlways ? describeSuggestions(prompt.suggestions) : ''
  const offerAuto = !NO_AUTO_OFFER.has(permissionMode ?? 'default')
  const label = summarizeTool(prompt.toolName, input)
  let detail: React.ReactNode = null
  if ((prompt.toolName === 'Bash' || prompt.toolName === 'PowerShell') && typeof input.command === 'string') {
    detail = <pre className="chat-pre text-text">{input.command}</pre>
  } else if (pairs) {
    detail = (
      <>
        {typeof input.file_path === 'string' && <div className="text-xs text-text-subtle font-mono truncate">{input.file_path}</div>}
        {pairs.map((pair, index) => <DiffView key={index} lines={diffLines(pair.before, pair.after)} />)}
      </>
    )
  } else if (Object.keys(input).length > 0) {
    detail = <pre className="chat-pre text-text-muted">{JSON.stringify(input, null, 2)}</pre>
  }
  const footer = denying ? (
    <form
      className="flex gap-1.5"
      onSubmit={(e) => {
        e.preventDefault()
        onRespond({ behavior: 'deny', message: reason })
      }}
    >
      <input
        autoFocus
        className="flex-1 min-w-0 h-(--ctl-h-sm) px-2 rounded-md border-[0.5px] border-border bg-field text-sm text-text outline-none focus:border-border-focus"
        placeholder="Tell Claude what to do instead (optional)"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setDenying(false) } }}
      />
      <button type="submit" className={secondaryBtn}>Deny</button>
    </form>
  ) : (
    <>
      <div className="flex flex-wrap gap-1.5">
        <button type="button" className={primaryBtn} onClick={() => onRespond({ behavior: 'allow' })}>Allow</button>
        {canAlways && (
          <button type="button" className={secondaryBtn} onClick={() => onRespond({ behavior: 'allow', always: true })} title={always}>
            Always allow
          </button>
        )}
        {offerAuto && (
          <button
            type="button"
            className={secondaryBtn}
            title="Allow this, then let Claude's classifier approve safe actions for the rest of this session"
            onClick={() => onRespond({ behavior: 'allow', mode: 'auto' })}
          >
            Allow, switch to Auto
          </button>
        )}
        <button type="button" className={quietBtn} onClick={() => setDenying(true)}>Deny…</button>
      </div>
      {always && <div className="text-xs text-text-subtle whitespace-pre-line">Always allow: {always}</div>}
    </>
  )
  return (
    <Card title={prompt.title ?? `Allow ${prompt.toolName}?`} summary={label} footer={footer}>
      {!pairs && <div className="text-sm text-text">{label}</div>}
      {prompt.description && !pairs && prompt.description !== label && <div className="text-sm text-text-muted">{prompt.description}</div>}
      {prompt.reason && <div className="text-xs text-text-subtle">{prompt.reason}</div>}
      {prompt.blockedPath && <div className="text-xs text-text-subtle">Outside the project: <span className="font-mono">{prompt.blockedPath}</span></div>}
      {detail && <div className="max-h-56 overflow-auto">{detail}</div>}
    </Card>
  )
}

const DESTINATION_LABEL: Record<string, string> = {
  session: 'for this session',
  localSettings: 'in .claude/settings.local.json',
  projectSettings: 'in .claude/settings.json',
  userSettings: 'in ~/.claude/settings.json'
}

function modeLabel(mode: string): string {
  return CHAT_PERMISSION_MODES.find((m) => m.value === mode)?.label ?? mode
}

/** What "Always allow" would change, from Claude's own suggestions. */
function describeSuggestions(suggestions: unknown[] | undefined): string {
  const parts: string[] = []
  for (const raw of suggestions ?? []) {
    const s = raw as { type?: string; mode?: string; rules?: { toolName?: string; ruleContent?: string }[]; destination?: string }
    if (s.type === 'setMode' && s.mode) parts.push(`switch to ${modeLabel(s.mode)} for this session`)
    if (s.type === 'addRules' && s.rules) {
      for (const rule of s.rules) parts.push(`${rule.toolName}${rule.ruleContent ? `(${rule.ruleContent})` : ''}${s.destination ? ` ${DESTINATION_LABEL[s.destination] ?? `in ${s.destination}`}` : ''}`)
    }
    if (s.type === 'addDirectories' && Array.isArray((s as { directories?: unknown }).directories)) {
      for (const dir of (s as { directories: string[] }).directories) parts.push(`access to ${dir}`)
    }
  }
  return parts.join('\n')
}

function QuestionCard({ prompt, onRespond }: Props): React.ReactElement {
  const questions = useMemo<PromptQuestion[]>(() => promptQuestions(prompt.input), [prompt.input])
  const [picked, setPicked] = useState<Record<number, string[]>>({})
  const [other, setOther] = useState<Record<number, string>>({})

  const answerFor = (index: number): string => {
    const labels = [...(picked[index] ?? [])]
    const extra = other[index]?.trim()
    if (extra) labels.push(extra)
    return joinAnswerLabels(labels)
  }
  const complete = questions.every((_, index) => answerFor(index).length > 0)

  const toggle = (index: number, label: string, multi: boolean): void => {
    setPicked((prev) => {
      const current = prev[index] ?? []
      if (!multi) return { ...prev, [index]: current[0] === label ? [] : [label] }
      return { ...prev, [index]: current.includes(label) ? current.filter((l) => l !== label) : [...current, label] }
    })
    if (!multi) setOther((prev) => ({ ...prev, [index]: '' }))
  }

  const submit = (): void => {
    const answers: Record<string, string> = {}
    questions.forEach((q, index) => { answers[q.question] = answerFor(index) })
    onRespond(questionAnswerResponse(prompt, answers))
  }

  const summary = questions.length > 1 ? `${questions[0]?.question} (+${questions.length - 1} more)` : questions[0]?.question
  const footer = (
    <div className="flex gap-1.5">
      <button type="button" className={primaryBtn} disabled={!complete} onClick={submit}>Answer</button>
      <button type="button" className={quietBtn} onClick={() => onRespond(dismissQuestionResponse())}>Skip</button>
    </div>
  )

  return (
    <Card title="Claude has a question" summary={summary} footer={footer}>
      {questions.map((q, index) => (
        <div key={index} className="flex flex-col gap-1.5">
          <div className="text-base text-text">
            {q.header && <span className="text-xs uppercase tracking-wide text-text-subtle mr-2">{q.header}</span>}
            {q.question}
          </div>
          <div className="flex flex-col gap-1">
            {q.options.map((option) => {
              const selected = (picked[index] ?? []).includes(option.label)
              return (
                <button
                  key={option.label}
                  type="button"
                  onClick={() => toggle(index, option.label, q.multiSelect === true)}
                  className={`text-left rounded-md border-[0.5px] px-2.5 py-1.5 cursor-pointer transition-colors duration-(--motion-fast) ${selected ? 'border-border-focus bg-sel' : 'border-border bg-surface-2 hover:bg-surface-3'}`}
                >
                  <div className="text-sm text-text">{q.multiSelect ? (selected ? '☑ ' : '☐ ') : ''}{option.label}</div>
                  {option.description && <div className="text-xs text-text-muted">{option.description}</div>}
                </button>
              )
            })}
            <input
              className="h-(--ctl-h-sm) px-2 rounded-md border-[0.5px] border-border bg-field text-sm text-text outline-none focus:border-border-focus"
              placeholder="Other…"
              value={other[index] ?? ''}
              onChange={(e) => {
                const value = e.target.value
                setOther((prev) => ({ ...prev, [index]: value }))
                if (!q.multiSelect && value) setPicked((prev) => ({ ...prev, [index]: [] }))
              }}
              onKeyDown={(e) => { if (e.key === 'Enter' && complete) submit() }}
            />
          </div>
        </div>
      ))}
    </Card>
  )
}

function PlanCard({ prompt, onRespond }: Props): React.ReactElement {
  const [feedback, setFeedback] = useState('')
  const [revising, setRevising] = useState(false)
  const plan = planText(prompt.input)
  const html = useMemo(() => renderChatMarkdown(plan || '_No plan text._'), [plan])
  const footer = revising ? (
    <form
      className="flex gap-1.5"
      onSubmit={(e) => {
        e.preventDefault()
        onRespond(planFeedbackResponse(feedback))
      }}
    >
      <input
        autoFocus
        className="flex-1 min-w-0 h-(--ctl-h-sm) px-2 rounded-md border-[0.5px] border-border bg-field text-sm text-text outline-none focus:border-border-focus"
        placeholder="What should change?"
        value={feedback}
        onChange={(e) => setFeedback(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setRevising(false) } }}
      />
      <button type="submit" className={secondaryBtn}>Send feedback</button>
    </form>
  ) : (
    <div className="flex flex-wrap gap-1.5">
      <button
        type="button"
        className={primaryBtn}
        onClick={() => onRespond(planApprovalResponse(prompt, false))}
      >
        Approve
      </button>
      <button
        type="button"
        className={secondaryBtn}
        title="Approve, and accept file edits without asking for the rest of this session"
        onClick={() => onRespond(planApprovalResponse(prompt, true))}
      >
        Approve, auto-accept edits
      </button>
      <button type="button" className={quietBtn} onClick={() => setRevising(true)}>Keep planning…</button>
    </div>
  )
  return (
    <Card title="Plan ready for review" summary={planSummary(plan)} footer={footer}>
      <div
        className="note-preview chat-md rounded-md bg-surface-2 border-[0.5px] border-border px-3 py-2 text-base"
        // Sanitized by DOMPurify in renderChatMarkdown.
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </Card>
  )
}

/** The plan's first line of text, without its Markdown heading marks. */
function planSummary(plan: string): string | undefined {
  const line = plan.split('\n').map((l) => l.trim()).find(Boolean)
  return line?.replace(/^#+\s*/, '')
}
