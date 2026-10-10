import React, { useLayoutEffect, useRef, useState } from 'react'
import { Pencil, Play, Plus, X } from 'lucide-react'
import { v4 as uuid } from 'uuid'
import { useApp } from '../context/AppContext'
import { GrpHead, RowAction, Switch } from './ui'
import type { Project, QueuedPrompt, Stream } from '../../shared/types'
import { featureUnavailableReason } from '../../shared/project-features'
import { findMainStream, findTaskInProject } from '../../shared/streams'
import { promptQueue, promptQueueWatchedTask, streamPromptQueue } from '../../shared/prompt-queue'

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

interface RowProps {
  project: Project
  item: QueuedPrompt
  index: number
  next: boolean
  editing: boolean
  dragging: boolean
  runLabel: string
  runDisabled: boolean
  runTitle: string
  onEdit: (editing: boolean) => void
  onRun: () => void
  onDragStart: () => void
  onDragEnd: () => void
  /** Null while what is dragged can't land here (another stream's prompt). */
  onDrop: (() => void) | null
}

function QueueRow({ project, item, index, next, editing, dragging, runLabel, runDisabled, runTitle, onEdit, onRun, onDragStart, onDragEnd, onDrop }: RowProps): React.ReactElement {
  const { updatePromptQueue } = useApp()
  return (
    <div
      className={`group flex items-start gap-2 px-2 py-1.5 border-t border-hair first:border-t-0 hover:bg-surface-3 ${dragging ? 'opacity-50' : ''}`}
      draggable={!editing}
      onDragStart={e => { onDragStart(); e.dataTransfer.effectAllowed = 'move' }}
      onDragEnd={onDragEnd}
      onDragOver={e => { if (onDrop) e.preventDefault() }}
      onDrop={e => {
        e.preventDefault()
        onDrop?.()
      }}
      data-testid={`prompt-queue-item-${item.id}`}
    >
      <span className="w-4 shrink-0 text-right text-xs text-text-subtle tabular-nums leading-snug pt-px">{index + 1}</span>
      <div className="flex-1 min-w-0 flex flex-col gap-0.5">
        {editing ? (
          <EditRow
            text={item.text}
            onSave={text => {
              updatePromptQueue(project.id, { op: 'edit', id: item.id, text })
              onEdit(false)
            }}
            onCancel={() => onEdit(false)}
          />
        ) : (
          <span
            className="text-base text-text leading-snug whitespace-pre-wrap break-words line-clamp-3 cursor-default"
            title={item.text}
            onDoubleClick={() => onEdit(true)}
          >
            {item.text}
          </span>
        )}
        {next && <span className="text-xs text-accent">next</span>}
      </div>
      {!editing && (
        <span className={rowActionsCls}>
          <RowAction title="Edit" onClick={() => onEdit(true)}><Pencil size={13} /></RowAction>
          <RowAction title="Remove from the queue" danger onClick={() => updatePromptQueue(project.id, { op: 'remove', id: item.id })}><X size={14} /></RowAction>
          <button
            type="button"
            className="ml-0.5 inline-flex items-center gap-1 h-(--ctl-h-sm) px-2 rounded-md border-0 bg-accent text-accent-ink text-xs font-medium cursor-pointer hover:brightness-105 disabled:opacity-50 disabled:cursor-default"
            title={runTitle}
            disabled={runDisabled}
            onClick={onRun}
          >
            <Play size={10} fill="currentColor" /> {runLabel}
          </button>
        </span>
      )}
    </div>
  )
}

function AutoRunSwitch({ project, stream }: { project: Project; stream: Stream }): React.ReactElement {
  const { updatePromptQueue } = useApp()
  return (
    <label className="flex items-center gap-2 text-xs font-normal normal-case tracking-normal text-text-muted cursor-pointer">
      Run next automatically
      <Switch
        checked={!!stream.promptQueueAutoRun}
        onChange={on => updatePromptQueue(project.id, { op: 'auto-run', streamId: stream.id, on })}
      />
    </label>
  )
}

/** What a stream's auto-run is waiting for, under its prompts. */
function autoRunHint(project: Project, stream: Stream, count: number, blocked: string | null): string | null {
  if (!stream.promptQueueAutoRun) return null
  const watch = promptQueueWatchedTask(stream)
  const watchedTask = watch ? findTaskInProject(project, watch.taskId) : undefined
  if (count === 0) return watchedTask ? null : 'A prompt added here starts right away.'
  if (watchedTask) return `The next prompt starts when "${watchedTask.name}" finishes or you mark it Done for now.`
  return blocked
}

/**
 * Project Home's queue: prompts planned ahead, run as new Claude chat tasks. Each
 * stream runs its own prompts one at a time, with its own "Run next automatically"
 * — streams are separate branches, so they run side by side. Hover a prompt to
 * run, edit or remove it; drag to reorder within its stream. Main starts the next
 * prompt once nothing the stream's queue started is still running
 * (`main/prompt-queue-runner.ts`).
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
  const [drag, setDrag] = useState<{ id: string; streamId: string } | null>(null)
  const draftRef = useRef<HTMLTextAreaElement>(null)
  useAutoGrow(draftRef, draft)

  // Main decides for real; this only greys Run out ahead of a sure refusal. A
  // server project's Claude switch is the server's, so it isn't checked here.
  const blocked = (!project.host && config && !config.enableClaude ? 'Claude is turned off in Settings.' : null)
    ?? featureUnavailableReason(project, 'chat')
  const split = project.streams.length > 1
  const draftStream = project.streams.some(s => s.id === draftStreamId) ? draftStreamId : mainStreamId
  const groups = project.streams
    .map(stream => ({ stream, items: streamPromptQueue(project, stream.id) }))
    .filter(group => !split || group.items.length > 0 || group.stream.promptQueueAutoRun)

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

  const single = split ? null : groups[0]
  const singleHint = single ? autoRunHint(project, single.stream, single.items.length, blocked) : null

  return (
    <>
      <GrpHead actions={single && <AutoRunSwitch project={project} stream={single.stream} />}>
        Queue{queue.length > 0 && <span className="ml-1.5 font-normal normal-case tracking-normal text-text-subtle">{queue.length}</span>}
      </GrpHead>
      <div className="bg-field border border-border rounded-lg overflow-hidden" data-testid="prompt-queue">
        {groups.map(({ stream, items }) => {
          const hint = split ? autoRunHint(project, stream, items.length, blocked) : null
          return (
            <div key={stream.id} className="border-t border-hair first:border-t-0" data-testid={`prompt-queue-stream-${stream.id}`}>
              {split && (
                <div className="flex items-center gap-2 px-2 pt-1.5 pb-1 bg-surface-2">
                  <span className="flex-1 min-w-0 flex items-baseline gap-1.5">
                    <span className="font-mono text-xs text-text-muted truncate">{stream.name}</span>
                    {items.length > 0 && <span className="text-xs text-text-subtle tabular-nums">{items.length}</span>}
                  </span>
                  <AutoRunSwitch project={project} stream={stream} />
                </div>
              )}
              {hint && <div className="px-2 pb-1 bg-surface-2 text-xs text-text-subtle">{hint}</div>}
              {items.map((item, index) => (
                <QueueRow
                  key={item.id}
                  project={project}
                  item={item}
                  index={index}
                  next={!!stream.promptQueueAutoRun && index === 0}
                  editing={editingId === item.id}
                  dragging={drag?.id === item.id}
                  runLabel={runningId === item.id ? 'Starting…' : 'Run'}
                  runDisabled={!!blocked || runningId !== null}
                  runTitle={blocked ?? 'Start a task with this prompt'}
                  onEdit={editing => setEditingId(editing ? item.id : null)}
                  onRun={() => { void run(item) }}
                  onDragStart={() => setDrag({ id: item.id, streamId: stream.id })}
                  onDragEnd={() => setDrag(null)}
                  onDrop={drag && drag.streamId === stream.id ? () => {
                    // The queue is one list: landing on this prompt takes its place in it.
                    if (drag.id !== item.id) updatePromptQueue(project.id, { op: 'move', id: drag.id, toIndex: queue.findIndex(q => q.id === item.id) })
                    setDrag(null)
                  } : null}
                />
              ))}
            </div>
          )
        })}
        <div className={`flex items-start gap-2 px-2 py-1.5 ${queue.length > 0 || (split && groups.length > 0) ?'border-t border-hair' : ''}`}>
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
          {split && (
            <select
              aria-label="Stream"
              className="shrink-0 max-w-[160px] h-(--ctl-h-sm) px-1 rounded-md bg-bg border border-border font-mono text-xs text-text-muted cursor-pointer outline-none focus:border-border-focus"
              value={draftStream}
              onChange={e => setDraftStreamId(e.target.value)}
            >
              {project.streams.map(stream => <option key={stream.id} value={stream.id}>{stream.name}</option>)}
            </select>
          )}
        </div>
      </div>
      {error && <div className="px-1 text-xs text-danger" role="alert">{error}</div>}
      {singleHint && <div className="px-1 text-xs text-text-subtle">{singleHint}</div>}
    </>
  )
}
