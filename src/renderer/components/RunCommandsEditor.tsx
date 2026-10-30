import React, { useEffect, useRef, useState } from 'react'
import { ArrowDown, ArrowUp, Loader2, Plus, Sparkles, X } from 'lucide-react'
import { newRunCommandId } from '../../shared/stream-run'
import type { RunCommand } from '../../shared/types'
import { Field } from './ui'

/** A draft list being edited: rows may still be blank. */
export type RunCommandDraft = RunCommand

/** The rows worth saving: name and command both set, trimmed. */
export function cleanRunCommandDrafts(drafts: readonly RunCommandDraft[]): RunCommand[] {
  return drafts
    .map(d => ({ id: d.id, name: d.name.trim(), command: d.command.trim() }))
    .filter(d => d.name && d.command)
}

/** Why the drafts can't be saved: a name used twice (names are matched without case). */
export function runCommandDraftsProblem(drafts: readonly RunCommandDraft[]): string | null {
  const seen = new Set<string>()
  for (const { name } of cleanRunCommandDrafts(drafts)) {
    const key = name.toLowerCase()
    if (seen.has(key)) return `Two commands are named “${name}”.`
    seen.add(key)
  }
  return null
}

/** What Suggest gets back (main's `run-command-suggester.ts`). */
export type RunCommandSuggestion = { ok: true; commands: Array<{ name: string; command: string }> } | { ok: false; error: string }

/**
 * Suggested commands into the drafts: one named like a row (without case) sets
 * that row's command, the others are added at the end. One the same as an
 * `inherited` command (a stream's project command) is left out. `changed` holds
 * the ids of the rows set or added.
 */
export function mergeSuggestedCommands(
  drafts: readonly RunCommandDraft[],
  suggested: ReadonlyArray<{ name: string; command: string }>,
  inherited: ReadonlyArray<{ name: string; command: string }> = []
): { next: RunCommandDraft[]; changed: string[] } {
  const next = drafts.filter(d => d.name.trim() || d.command.trim()).map(d => ({ ...d }))
  const changed: string[] = []
  for (const { name, command } of suggested) {
    const key = name.trim().toLowerCase()
    const row = next.find(d => d.name.trim().toLowerCase() === key)
    if (row) {
      if (row.command.trim() === command) continue
      row.command = command
      changed.push(row.id)
      continue
    }
    if (inherited.some(c => c.name.trim().toLowerCase() === key && c.command.trim() === command)) continue
    const id = newRunCommandId()
    next.push({ id, name, command })
    changed.push(id)
  }
  return { next, changed }
}

type SuggestState = { phase: 'idle' } | { phase: 'busy' } | { phase: 'done'; count: number } | { phase: 'failed'; error: string }

const iconBtn = [
  'flex items-center justify-center size-(--ctl-h-sm) shrink-0 rounded-md bg-transparent border-0 cursor-pointer text-text-muted',
  'hover:text-text hover:bg-sel disabled:opacity-30 disabled:cursor-default disabled:hover:bg-transparent'
].join(' ')

/**
 * Named commands, one row each (name, command line), in the order Run offers
 * them: add, remove, move up and down. `namePlaceholder` hints at the names
 * that mean something here (a stream's override of `run`). With `suggest`,
 * Suggest asks Claude for the commands and puts them in the rows, marked,
 * for the user to check before saving.
 */
export default function RunCommandsEditor({ value, onChange, namePlaceholder = 'run', onEnter, suggest, inherited }: {
  value: RunCommandDraft[]
  onChange: (next: RunCommandDraft[]) => void
  namePlaceholder?: string
  /** Enter in a field: save. */
  onEnter?: () => void
  /** Asks Claude for commands given the rows set now; absent hides Suggest. */
  suggest?: (current: Array<{ name: string; command: string }>) => Promise<RunCommandSuggestion>
  /** Commands the rows add to (a stream's project commands): a suggestion the same as one is left out. */
  inherited?: ReadonlyArray<{ name: string; command: string }>
}): React.ReactElement {
  const [suggestState, setSuggestState] = useState<SuggestState>({ phase: 'idle' })
  const [marked, setMarked] = useState<ReadonlySet<string>>(() => new Set())
  // The latest rows, for merging a reply that comes back after edits.
  const latest = useRef(value)
  latest.current = value
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])
  const runSuggest = () => {
    if (!suggest || suggestState.phase === 'busy') return
    setSuggestState({ phase: 'busy' })
    const current = value.map(d => ({ name: d.name.trim(), command: d.command.trim() })).filter(d => d.name && d.command)
    suggest(current).then(
      (result) => {
        if (!alive.current) return
        if (!result.ok) return setSuggestState({ phase: 'failed', error: result.error })
        const { next, changed } = mergeSuggestedCommands(latest.current, result.commands, inherited)
        if (changed.length > 0) onChange(next)
        setMarked(new Set(changed))
        setSuggestState({ phase: 'done', count: changed.length })
      },
      (err: unknown) => {
        if (alive.current) setSuggestState({ phase: 'failed', error: err instanceof Error ? err.message : String(err) })
      }
    )
  }
  const update = (index: number, patch: Partial<RunCommandDraft>) =>
    onChange(value.map((row, i) => (i === index ? { ...row, ...patch } : row)))
  const linkBtn = 'flex items-center gap-1.5 h-(--ctl-h-sm) px-2 rounded-md bg-transparent border-0 cursor-pointer text-xs text-text-muted hover:text-text hover:bg-sel disabled:opacity-50 disabled:cursor-default'
  const move = (index: number, by: -1 | 1) => {
    const next = [...value]
    const [row] = next.splice(index, 1)
    next.splice(index + by, 0, row)
    onChange(next)
  }
  const keyDown = (e: React.KeyboardEvent) => { if (e.key === 'Enter' && onEnter) onEnter() }
  return (
    <div className="flex flex-col gap-1.5" data-testid="run-commands-editor">
      {value.map((row, index) => (
        <div
          key={row.id}
          className={`flex items-center gap-1.5 rounded-md ${marked.has(row.id) ? 'bg-accent/10 outline outline-1 outline-accent/40' : ''}`}
          data-testid="run-command-row"
          data-suggested={marked.has(row.id) || undefined}
        >
          <Field
            className="w-[130px] shrink-0"
            value={row.name}
            onChange={(e) => update(index, { name: e.target.value })}
            onKeyDown={keyDown}
            placeholder={index === 0 ? namePlaceholder : 'name'}
            aria-label="Command name"
          />
          <Field
            className="flex-1 min-w-0 font-mono"
            value={row.command}
            onChange={(e) => update(index, { command: e.target.value })}
            onKeyDown={keyDown}
            placeholder={index === 0 ? 'e.g. npm run dev' : 'e.g. npm ci'}
            aria-label="Command line"
          />
          <button type="button" className={iconBtn} title="Move up" disabled={index === 0} onClick={() => move(index, -1)}>
            <ArrowUp size={12} />
          </button>
          <button type="button" className={iconBtn} title="Move down" disabled={index === value.length - 1} onClick={() => move(index, 1)}>
            <ArrowDown size={12} />
          </button>
          <button type="button" className={iconBtn} title="Remove" onClick={() => onChange(value.filter((_, i) => i !== index))}>
            <X size={12} />
          </button>
        </div>
      ))}
      <div className="flex items-center gap-1">
        <button
          type="button"
          className={linkBtn}
          onClick={() => onChange([...value, { id: newRunCommandId(), name: '', command: '' }])}
          data-testid="run-command-add"
        >
          <Plus size={12} /> Add command
        </button>
        {suggest && (
          <button
            type="button"
            className={linkBtn}
            onClick={runSuggest}
            disabled={suggestState.phase === 'busy'}
            title="Claude reads the project and fills in its install and run commands for you to check"
            data-testid="run-command-suggest"
          >
            {suggestState.phase === 'busy' ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}
            {suggestState.phase === 'busy' ? 'Claude is reading the project…' : 'Suggest with Claude'}
          </button>
        )}
      </div>
      {suggestState.phase === 'done' && (
        <div className="text-xs text-text-muted" data-testid="run-command-suggest-status">
          {suggestState.count > 0
            ? `Claude filled in ${suggestState.count === 1 ? '1 command' : `${suggestState.count} commands`}, marked above. Check them before saving: DevTool runs them as written.`
            : 'Claude has nothing to add here.'}
        </div>
      )}
      {suggestState.phase === 'failed' && (
        <div className="text-xs text-danger" data-testid="run-command-suggest-status">{suggestState.error}</div>
      )}
    </div>
  )
}
