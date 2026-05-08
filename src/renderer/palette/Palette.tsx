// src/renderer/palette/Palette.tsx
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useApp } from '../context/AppContext'
import { commandRegistry } from './CommandRegistry'
import { fuzzyMatch, FUZZY_SCORE_FLOOR } from './fuzzy'
import { computeFrecencyMultiplier, recordUse, recentIds, type FrecencyState } from './frecency'
import { parsePrefix } from './parsePrefix'
import { paletteEvents } from './paletteEvents'
import { projectsToEntities } from './sources/projects'
import { tasksToEntities } from './sources/tasks'
import { openTabsToEntities } from './sources/openTabs'
import { notesToEntities } from './sources/notes'
import './sources/commands' // side-effect: register commands
import { PaletteFooter } from './PaletteFooter'
import { PaletteList } from './PaletteList'
import { usePaletteHotkey } from './usePaletteHotkey'
import type { PaletteEntity, ScoredResult, Prefix, EntityKind } from './types'

type FooterPrefix = Prefix | '*'

const KIND_FOR_PREFIX: Record<Prefix, EntityKind> = {
  '>': 'command',
  '@': 'task',
  '#': 'note',
  ':': 'tab'
}

export function Palette(): React.ReactElement | null {
  const actions = useApp()
  const [open, setOpen] = useState(false)
  const [input, setInput] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [frecency, setFrecency] = useState<FrecencyState>({})
  const inputRef = useRef<HTMLInputElement>(null)
  const saveTimer = useRef<number | null>(null)
  const lastFocusedRef = useRef<HTMLElement | null>(null)

  const toggle = useCallback(() => setOpen(o => !o), [])
  usePaletteHotkey(toggle)

  // Load frecency once
  useEffect(() => {
    const api = (window as any).api
    if (!api?.paletteFrecencyLoad) return
    api.paletteFrecencyLoad().then((file: any) => {
      if (file && file.entries) setFrecency(file.entries)
    })
  }, [])

  // Persist frecency (debounced)
  useEffect(() => {
    if (saveTimer.current) window.clearTimeout(saveTimer.current)
    saveTimer.current = window.setTimeout(() => {
      const api = (window as any).api
      if (api?.paletteFrecencySave) {
        api.paletteFrecencySave({ version: 1, entries: frecency })
      }
    }, 1000)
    return () => { if (saveTimer.current) window.clearTimeout(saveTimer.current) }
  }, [frecency])

  // Reset input/selection when opening; focus input. On close, restore focus.
  useEffect(() => {
    if (open) {
      const prev = document.activeElement
      lastFocusedRef.current = prev instanceof HTMLElement ? prev : null
      setInput('')
      setSelectedIndex(0)
      const t = window.setTimeout(() => inputRef.current?.focus(), 0)
      return () => window.clearTimeout(t)
    } else {
      const target = lastFocusedRef.current
      if (target && document.body.contains(target)) {
        const t = window.setTimeout(() => target.focus(), 0)
        return () => window.clearTimeout(t)
      }
    }
  }, [open])

  // Listen for "Search All Projects" command setting the prefix
  useEffect(() => {
    const off = paletteEvents.on('palette-prefix-set', (p: string) => {
      if (!open) setOpen(true)
      setInput(prev => p + (prev.startsWith(p) ? prev.slice(p.length) : prev))
    })
    return off
  }, [open])

  const parsed = useMemo(() => parsePrefix(input), [input])

  const entities = useMemo<PaletteEntity[]>(() => {
    if (!open) return []
    const projectsEnts = projectsToEntities(actions)
    const tasksEnts = tasksToEntities(actions, { allProjects: parsed.allProjects })
    const openTabsEnts = openTabsToEntities(actions, { allProjects: parsed.allProjects })
    const notesEnts = notesToEntities(actions, { allProjects: parsed.allProjects })
    const ctx = { actions }
    const commandsEnts: PaletteEntity[] = commandRegistry.getAvailable(ctx).map(c => ({
      kind: 'command' as const,
      id: `command:${c.id}`,
      title: c.title,
      searchable: [c.title, ...(c.aliases ?? [])].join(' '),
      shortcut: c.shortcut
    }))

    if (parsed.prefix !== null) {
      const wantedKind = KIND_FOR_PREFIX[parsed.prefix]
      return [...projectsEnts, ...tasksEnts, ...openTabsEnts, ...notesEnts, ...commandsEnts]
        .filter(e => e.kind === wantedKind)
    }
    return [...commandsEnts, ...tasksEnts, ...openTabsEnts, ...projectsEnts, ...notesEnts]
  }, [open, actions, parsed.prefix, parsed.allProjects])

  const results = useMemo<ScoredResult[]>(() => {
    if (!open) return []
    const now = Date.now()
    if (parsed.query.length === 0) {
      const recent = recentIds(frecency, 8)
      const byId = new Map(entities.map(e => [e.id, e]))
      return recent
        .map(id => byId.get(id))
        .filter((e): e is PaletteEntity => !!e)
        .map(e => ({ entity: e, score: 1, matchSpans: [] }))
    }
    const scored: ScoredResult[] = []
    for (const e of entities) {
      const m = fuzzyMatch(parsed.query, e.searchable)
      if (!m || m.score < FUZZY_SCORE_FLOOR) continue
      const titleMatch = fuzzyMatch(parsed.query, e.title)
      const spans = titleMatch?.spans ?? []
      const mult = computeFrecencyMultiplier(frecency[e.id], now)
      scored.push({ entity: e, score: m.score * mult, matchSpans: spans })
    }
    return scored.sort((a, b) => b.score - a.score).slice(0, 50)
  }, [open, entities, parsed.query, frecency])

  useEffect(() => { setSelectedIndex(0) }, [results.length])

  const commit = useCallback((idx: number) => {
    const r = results[idx]
    if (!r) return
    const e = r.entity
    const id = e.id
    setFrecency(prev => recordUse(prev, id, Date.now()))

    if (e.kind === 'command') {
      const cmdId = id.slice('command:'.length)
      const cmd = commandRegistry.getById(cmdId)
      if (cmd) Promise.resolve(cmd.run({ actions })).catch(() => {})
    } else if (e.kind === 'project') {
      const projectId = id.slice('project:'.length)
      actions.selectProjectHome(projectId)
    } else if (e.kind === 'task') {
      const [, projectId, taskId] = id.split(':')
      actions.switchToTask(projectId, taskId)
    } else if (e.kind === 'tab') {
      const [, projectId, taskId, pane, tabId] = id.split(':')
      actions.switchToTask(projectId, taskId)
      actions.setActiveTab(projectId, taskId, pane as 'left' | 'right', tabId)
    } else if (e.kind === 'note') {
      const [, projectId, noteId] = id.split(':')
      const taskId = actions.selectedTaskId
      if (taskId) actions.openOrFocusNoteTab(projectId, taskId, 'left', noteId)
    }
    setOpen(false)
  }, [results, actions])

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { setOpen(false); return }
    if (e.key === 'ArrowDown') { e.preventDefault(); setSelectedIndex(i => Math.min(i + 1, Math.max(0, results.length - 1))); return }
    if (e.key === 'ArrowUp') { e.preventDefault(); setSelectedIndex(i => Math.max(0, i - 1)); return }
    if (e.key === 'Enter') { e.preventDefault(); commit(selectedIndex); return }
  }

  const onClickPrefix = (p: FooterPrefix) => {
    setInput(prev => {
      const cur = parsePrefix(prev)
      if (p === '*') {
        const newAll = !cur.allProjects
        const head = (cur.prefix ?? '') + (newAll ? '*' : '')
        return head + (cur.query ? cur.query : '')
      }
      if (cur.prefix === p) {
        const head = cur.allProjects ? '*' : ''
        return head + (cur.query ? cur.query : '')
      }
      const head = p + (cur.allProjects ? '*' : '')
      return head + (cur.query ? cur.query : '')
    })
    requestAnimationFrame(() => {
      const el = inputRef.current
      if (!el) return
      el.focus()
      const end = el.value.length
      el.setSelectionRange(end, end)
    })
  }

  if (!open) return null

  const scopeLabel = parsed.allProjects ? 'all projects' : 'current project'

  return createPortal(
    <div
      className="fixed inset-0 z-50 bg-black/40 flex items-start justify-center pt-[15vh]"
      onMouseDown={e => { if (e.target === e.currentTarget) setOpen(false) }}
    >
      <div className="w-[min(600px,90vw)] bg-surface text-text rounded-lg shadow-xl border border-border overflow-hidden">
        <div className="px-3 py-2 flex items-center gap-2 border-b border-border">
          <span aria-hidden>🔍</span>
          <input
            ref={inputRef}
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="type to search…"
            className="flex-1 bg-transparent border-0 outline-none text-text placeholder:text-text-subtle"
          />
          <span className="text-xs text-text-subtle font-mono">↑↓ ↵ esc</span>
        </div>
        <PaletteList
          results={results}
          selectedIndex={selectedIndex}
          scopeLabel={scopeLabel}
          onSelect={setSelectedIndex}
          onCommit={commit}
        />
        <PaletteFooter
          activePrefix={parsed.prefix}
          allProjects={parsed.allProjects}
          onClickPrefix={onClickPrefix}
        />
      </div>
    </div>,
    document.body
  )
}
