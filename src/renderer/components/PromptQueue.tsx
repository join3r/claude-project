import React, { useLayoutEffect, useRef, useState } from 'react'
import { Pencil, Play, Plus, X } from 'lucide-react'
import { v4 as uuid } from 'uuid'
import { useApp } from '../context/AppContext'
import { GrpHead, RowAction, Switch } from './ui'
import type { Project, QueuedPrompt } from '../../shared/types'
import { featureUnavailableReason } from '../../shared/project-features'
import { findMainStream, findTaskInProject } from '../../shared/streams'
import { promptQueue, promptQueueWatchedTask } from '../../shared/prompt-queue'

/** `RowActions`, wide enough for Run: hidden at rest, fading in on row hover without moving. */
const rowActionsCls = 'shrink-0 flex items-center gap-0.5 max-w-0 overflow-hidden opacity-0 group-hover:max-w-[180px] group-hover:opacity-100 focus-within:max-w-[180px] focus-within:opacity-100 transition-opacity duration-(--motion-fast)'

const inputCls = 'flex-1 min-w-0 resize-none bg-transparent border-0 outline-none p-0 text-base text-text leading-snug placeholder:text-text-subtle'

/** A textarea that grows with its text, one line at rest. */
function useAutoGrow(ref: React.RefObject<HTMLTextAreaElement | null>, value: string): void {
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [ref, value])
}

function EditRow({ text, onSave, onCancel }: { text: string; onSave: (text: string) => void; onCancel: () => void }): React.ReactElement {
  const [value, setValue] = useState(text)
  const ref = useRef<HTMLTextAreaElement>(null)
  useAutoGrow(ref, value)
  useLayoutEffect(() => {
    ref.current?.focus()
    ref.current?.select()
  }, [])
  return (
    <textarea
      ref={ref}
      rows={1}
      aria-label="Edit prompt"
      className={`${inputCls} border-b border-border-focus`}
      value={value}
      onChange={e => setValue(e.target.value)}
      onBlur={() => onSave(value)}
      onKeyDown={e => {
        if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
          e.preventDefault()
          onSave(value)
        } else if (e.key === 'Escape') {
          e.preventDefault()
          onCancel()
        }
      }}
    />
  )
}

/**
 * Project Home's queue: prompts planned ahead, run one at a time as new Claude
 * chat tasks. Hover a prompt to run, edit or remove it; drag to reorder. With
 * "Run next automatically" on, main starts the next prompt once the task the
 * queue started last finishes (`main/prompt-queue-runner.ts`).
 */
export function PromptQueue({ project }: { project: Project }): React.ReactElement {
  const { updatePromptQueue, config } = useApp()
  const queue = promptQueue(project)
  const mainStreamId = findMainStream(project)?.id ?? project.streams[0]?.id ?? ''
  const [draft, setDraft] = useState('')
  const [draftStreamId, setDraftStreamId] = useState(mainStreamId)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [runningId, setRunningId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [dragId, setDragId] = useState<string | null>(null)
  const draftRef = useRef<HTMLTextAreaElement>(null)
  useAutoGrow(draftRef, draft)

  const autoRun = !!project.promptQueueAutoRun
  const watch = promptQueueWatchedTask(project)
  const watchedTask = watch ? findTaskInProject(project, watch.taskId) : undefined
  // Main decides for real; this only greys Run out ahead of a sure refusal. A
  // server project's Claude switch is the server's, so it isn't checked here.
  const blocked = (!project.host && config && !config.enableClaude ? 'Claude is turned off in Settings.' : null)
    ?? featureUnavailableReason(project, 'chat')
  const streamOptions = project.streams.length > 1 ? project.streams : []
  const draftStream = project.streams.some(s => s.id === draftStreamId) ? draftStreamId : mainStreamId

  const add = (): void => {
    const text = draft.trim()
    if (!text) return
    const item: QueuedPrompt = { id: uuid(), text, ...(draftStream !== mainStreamId ? { streamId: draftStream } : {}) }
    updatePromptQueue(project.id, { op: 'add', item })
    setDraft('')
  }

  const run = async (item: QueuedPrompt): Promise<void> => {
    setError(null)
    setRunningId(item.id)
    try {
      const result = await window.api.promptQueueRun(project.id, item.id)
      if (!result.ok) setError(result.error)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setRunningId(null)
    }
  }

  const hint = !autoRun || queue.length === 0
    ? null
    : watchedTask
      ? `The next prompt starts when "${watchedTask.name}" finishes.`
      : 'Run a prompt to start. The rest follow one at a time, each when the one before finishes.'

  return (
    <>
      <GrpHead
        actions={
          <label className="flex items-center gap-2 text-xs font-normal normal-case tracking-normal text-text-muted cursor-pointer">
            Run next automatically
            <Switch checked={autoRun} onChange={on => updatePromptQueue(project.id, { op: 'auto-run', on })} />
          </label>
        }
      >
        Queue{queue.length > 0 && <span className="ml-1.5 font-normal normal-case tracking-normal text-text-subtle">{queue.length}</span>}
      </GrpHead>
      <div className="bg-field border border-border rounded-lg overflow-hidden" data-testid="prompt-queue">
        {queue.map((item, index) => {
          const stream = item.streamId ? project.streams.find(s => s.id === item.streamId) : undefined
          const editing = editingId === item.id
          const next = autoRun && index === 0
          return (
            <div
              key={item.id}
              className={`group flex items-start gap-2 px-2 py-1.5 border-t border-hair first:border-t-0 hover:bg-surface-3 ${dragId === item.id ? 'opacity-50' : ''}`}
              draggable={!editing}
              onDragStart={e => { setDragId(item.id); e.dataTransfer.effectAllowed = 'move' }}
              onDragEnd={() => setDragId(null)}
              onDragOver={e => { if (dragId) e.preventDefault() }}
              onDrop={e => {
                e.preventDefault()
                if (dragId && dragId !== item.id) updatePromptQueue(project.id, { op: 'move', id: dragId, toIndex: index })
                setDragId(null)
              }}
              data-testid={`prompt-queue-item-${index}`}
            >
              <span className="w-4 shrink-0 text-right text-xs text-text-subtle tabular-nums leading-snug pt-px">{index + 1}</span>
              <div className="flex-1 min-w-0 flex flex-col gap-0.5">
                {editing ? (
                  <EditRow
                    text={item.text}
                    onSave={text => {
                      updatePromptQueue(project.id, { op: 'edit', id: item.id, text })
                      setEditingId(null)
                    }}
                    onCancel={() => setEditingId(null)}
                  />
                ) : (
                  <span
                    className="text-base text-text leading-snug whitespace-pre-wrap break-words line-clamp-3 cursor-default"
                    title={item.text}
                    onDoubleClick={() => setEditingId(item.id)}
                  >
                    {item.text}
                  </span>
                )}
                {(next || stream) && (
                  <span className="flex items-center gap-2 text-xs text-text-subtle">
                    {next && <span className="text-accent">next</span>}
                    {stream && !stream.isMain && <span className="font-mono truncate">→ {stream.name}</span>}
                  </span>
                )}
              </div>
              {!editing && (
                <span className={rowActionsCls}>
                  <RowAction title="Edit" onClick={() => setEditingId(item.id)}><Pencil size={13} /></RowAction>
                  <RowAction title="Remove from the queue" danger onClick={() => updatePromptQueue(project.id, { op: 'remove', id: item.id })}><X size={14} /></RowAction>
                  <button
                    type="button"
                    className="ml-0.5 inline-flex items-center gap-1 h-(--ctl-h-sm) px-2 rounded-md border-0 bg-accent text-accent-ink text-xs font-medium cursor-pointer hover:brightness-105 disabled:opacity-50 disabled:cursor-default"
                    title={blocked ?? 'Start a task with this prompt'}
                    disabled={!!blocked || runningId !== null}
                    onClick={() => { void run(item) }}
                  >
                    <Play size={10} fill="currentColor" /> {runningId === item.id ? 'Starting…' : 'Run'}
                  </button>
                </span>
              )}
            </div>
          )
        })}
        <div className={`flex items-start gap-2 px-2 py-1.5 ${queue.length > 0 ? 'border-t border-hair' : ''}`}>
          <Plus size={14} className="w-4 shrink-0 mt-0.5 text-text-subtle" aria-hidden />
          <textarea
            ref={draftRef}
            rows={1}
            aria-label="Plan a prompt"
            placeholder="Plan a prompt… Enter adds it to the queue"
            className={inputCls}
            value={draft}
            onChange={e => setDraft(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                add()
              }
            }}
          />
          {streamOptions.length > 0 && (
            <select
              aria-label="Stream"
              className="shrink-0 h-(--ctl-h-sm) px-1 rounded-md bg-bg border border-border font-mono text-xs text-text-muted cursor-pointer outline-none focus:border-border-focus"
              value={draftStream}
              onChange={e => setDraftStreamId(e.target.value)}
            >
              {streamOptions.map(stream => <option key={stream.id} value={stream.id}>{stream.name}</option>)}
            </select>
          )}
        </div>
      </div>
      {error && <div className="px-1 text-xs text-danger" role="alert">{error}</div>}
      {hint && <div className="px-1 text-xs text-text-subtle">{hint}</div>}
    </>
  )
}
