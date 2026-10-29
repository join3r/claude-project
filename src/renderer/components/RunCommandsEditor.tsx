import React from 'react'
import { ArrowDown, ArrowUp, Plus, X } from 'lucide-react'
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

const iconBtn = [
  'flex items-center justify-center size-(--ctl-h-sm) shrink-0 rounded-md bg-transparent border-0 cursor-pointer text-text-muted',
  'hover:text-text hover:bg-sel disabled:opacity-30 disabled:cursor-default disabled:hover:bg-transparent'
].join(' ')

/**
 * Named commands, one row each (name, command line), in the order Run offers
 * them: add, remove, move up and down. `namePlaceholder` hints at the names
 * that mean something here (a stream's override of `run`).
 */
export default function RunCommandsEditor({ value, onChange, namePlaceholder = 'run', onEnter }: {
  value: RunCommandDraft[]
  onChange: (next: RunCommandDraft[]) => void
  namePlaceholder?: string
  /** Enter in a field: save. */
  onEnter?: () => void
}): React.ReactElement {
  const update = (index: number, patch: Partial<RunCommandDraft>) =>
    onChange(value.map((row, i) => (i === index ? { ...row, ...patch } : row)))
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
        <div key={row.id} className="flex items-center gap-1.5" data-testid="run-command-row">
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
      <button
        type="button"
        className="self-start flex items-center gap-1.5 h-(--ctl-h-sm) px-2 rounded-md bg-transparent border-0 cursor-pointer text-xs text-text-muted hover:text-text hover:bg-sel"
        onClick={() => onChange([...value, { id: newRunCommandId(), name: '', command: '' }])}
        data-testid="run-command-add"
      >
        <Plus size={12} /> Add command
      </button>
    </div>
  )
}
