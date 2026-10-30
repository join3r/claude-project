/**
 * The desk's ⌘K bar (change 5 of the redesign), as pure logic: what the input
 * means and what the list shows. One input replaces the palette, the ⌘P
 * switcher, New task and New stream:
 *
 * - Plain words jump somewhere (tasks, projects, streams, running apps, queued
 *   prompts) or start a task with those words as its prompt.
 * - `@project` and `#stream` pick where the task goes and narrow the matches. A
 *   token that names nothing stays part of the prompt ("fix #123").
 * - `>` lists commands, `/` files and notes, `*` widens matches to all projects.
 *
 * Without tokens the task goes where you are: the open task's project and
 * stream, else the column's scope, else the project you last fired into.
 */
import type { DeskScope, Project, QueuedPrompt, Stream, Task } from '../../../shared/types'
import { isEphemeralProject, isShellCommandProject } from '../../../shared/types'
import { findMainStream, findStreamOfTask, findTaskInProject } from '../../../shared/streams'
import { promptQueue, queuedPromptStream } from '../../../shared/prompt-queue'
import { fuzzyMatch, FUZZY_SCORE_FLOOR } from '../../palette/fuzzy'
import { computeFrecencyMultiplier, type FrecencyState } from '../../palette/frecency'
import type { InboxApp } from '../inbox'

export type BarMode = 'plain' | 'command' | 'files'

/** A whitespace-separated piece of the input, with where it sits (for highlighting). */
export interface BarPiece {
  text: string
  start: number
  end: number
}

export interface ParsedBar {
  mode: BarMode
  allProjects: boolean
  /** The pieces after the mode sigil, `*` left out. */
  pieces: BarPiece[]
  /** The `@x` / `#x` piece being typed at the very end (no space after it yet). */
  completing: BarPiece | null
}

/** Split the input: a leading `>` or `/` picks the mode; a `*` (alone or leading) means all projects. */
export function parseBar(input: string): ParsedBar {
  let offset = input.length - input.trimStart().length
  let mode: BarMode = 'plain'
  if (input[offset] === '>') { mode = 'command'; offset++ }
  else if (input[offset] === '/') { mode = 'files'; offset++ }
  let allProjects = false
  const pieces: BarPiece[] = []
  const re = /\S+/g
  re.lastIndex = offset
  let match: RegExpExecArray | null
  while ((match = re.exec(input))) {
    let text = match[0]
    let start = match.index
    if (text === '*') { allProjects = true; continue }
    // `*foo` straight after the sigil (or at the start): the classic palette's `>*query`.
    if (text.startsWith('*') && pieces.length === 0 && !allProjects) {
      allProjects = true
      text = text.slice(1)
      start++
    }
    pieces.push({ text, start, end: start + text.length })
  }
  const last = pieces[pieces.length - 1]
  const completing = last && last.end === input.length && (last.text.startsWith('@') || last.text.startsWith('#')) ? last : null
  return { mode, allProjects, pieces, completing }
}

/** How a project or stream is written as a token: lower case, spaces as dashes. */
export function tokenKey(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, '-')
}

/** The best of `items` for a token's text: an exact key, else a key it starts, else one containing it. */
function matchToken<T>(items: readonly T[], text: string, name: (item: T) => string): T | undefined {
  const want = text.toLowerCase()
  if (!want) return undefined
  return items.find(item => tokenKey(name(item)) === want)
    ?? items.find(item => tokenKey(name(item)).startsWith(want))
    ?? items.find(item => tokenKey(name(item)).includes(want))
}

/** Where the window is: the open task, the column's scope, the project last fired into. */
export interface BarHere {
  projectId: string | null
  taskId: string | null
  scope: DeskScope | null
  lastProjectId: string | null
}

export interface BarTarget {
  project: Project
  /** Absent means the project's main stream. */
  stream: Stream | undefined
}

export interface ResolvedBar extends ParsedBar {
  /** The project an `@` token named. */
  project: Project | null
  /** The stream a `#` token named (in `project`, or found in another project). */
  stream: { project: Project; stream: Stream } | null
  /** Every piece that isn't a resolved token: the prompt, or what to match. */
  query: string
  /** The pieces that resolved as tokens, for highlighting. */
  tokens: Array<BarPiece & { kind: 'project' | 'stream' }>
  /** Where ↵ starts the task (and ⌘↵ queues it). */
  target: BarTarget | null
}

/**
 * Resolve the tokens against `projects` (the ones you added, in order) and work
 * out where a task would go. The last `@`/`#` that names something wins.
 */
export function resolveBar(input: string, projects: readonly Project[], here: BarHere): ResolvedBar {
  const parsed = parseBar(input)
  const tokens: ResolvedBar['tokens'] = []
  const used = new Set<BarPiece>()
  let project: Project | null = null
  for (const piece of parsed.pieces) {
    if (!piece.text.startsWith('@')) continue
    const found = matchToken(projects, piece.text.slice(1), p => p.name)
    if (!found) continue
    project = found
    used.add(piece)
    tokens.push({ ...piece, kind: 'project' })
  }

  const hereProject = defaultProject(projects, here)
  let stream: ResolvedBar['stream'] = null
  for (const piece of parsed.pieces) {
    if (!piece.text.startsWith('#')) continue
    const text = piece.text.slice(1)
    // In the named project only; without one, where you are first, then anywhere.
    const searchIn = project ? [project] : [...(hereProject ? [hereProject] : []), ...projects.filter(p => p !== hereProject)]
    let hit: ResolvedBar['stream'] = null
    for (const candidate of searchIn) {
      const found = matchToken(candidate.streams, text, s => s.name)
      if (found) { hit = { project: candidate, stream: found }; break }
    }
    if (!hit) continue
    stream = hit
    used.add(piece)
    tokens.push({ ...piece, kind: 'stream' })
  }

  // A bare `@`/`#` is a token about to be typed, not part of the prompt.
  const query = parsed.pieces
    .filter(piece => !used.has(piece) && piece.text !== '@' && piece.text !== '#')
    .map(piece => piece.text).join(' ')
  return { ...parsed, project, stream, query, tokens, target: barTarget(projects, here, project, stream) }
}

function defaultProject(projects: readonly Project[], here: BarHere): Project | undefined {
  const pick = (id: string | null | undefined): Project | undefined => (id ? projects.find(p => p.id === id) : undefined)
  const taskProject = here.taskId ? pick(here.projectId) : undefined
  return (taskProject && findTaskInProject(taskProject, here.taskId) ? taskProject : undefined)
    ?? pick(here.scope?.projectId) ?? pick(here.projectId) ?? pick(here.lastProjectId) ?? projects[0]
}

function barTarget(
  projects: readonly Project[],
  here: BarHere,
  named: Project | null,
  namedStream: ResolvedBar['stream']
): BarTarget | null {
  const project = named ?? namedStream?.project ?? defaultProject(projects, here)
  if (!project) return null
  if (namedStream && namedStream.project === project) return { project, stream: namedStream.stream }
  // The stream you are in, when the task goes to the project you are in.
  if (project.id === here.projectId && here.taskId) {
    const open = findStreamOfTask(project, here.taskId)
    if (open) return { project, stream: open }
  }
  if (here.scope?.projectId === project.id && here.scope.streamId) {
    const scoped = project.streams.find(s => s.id === here.scope?.streamId)
    if (scoped) return { project, stream: scoped }
  }
  return { project, stream: undefined }
}

/** "devtool › 0.7.0", or just "devtool" for main. */
export function targetLabel(target: BarTarget): string {
  return target.stream && !target.stream.isMain ? `${target.project.name} › ${target.stream.name}` : target.project.name
}

/** The stream a target's queue entry runs in, by name ("main" when none). */
export function targetStreamName(target: BarTarget): string {
  return target.stream?.name ?? findMainStream(target.project)?.name ?? 'main'
}

/** ⌘↵ adds to the project's prompt queue, which runs Claude chat tasks: not for a custom-shell project. */
export function canQueue(target: BarTarget | null): boolean {
  return !!target && !isShellCommandProject(target.project)
}

/** The queue entry ⌘↵ adds: the main stream's entries carry no stream. */
export function queuedPromptFor(target: BarTarget, id: string, text: string): QueuedPrompt {
  return { id, text, ...(target.stream && !target.stream.isMain ? { streamId: target.stream.id } : {}) }
}

export type BarItem =
  | { kind: 'start'; id: 'start'; target: BarTarget }
  | { kind: 'queue'; id: 'queue'; target: BarTarget }
  | { kind: 'complete'; id: string; sigil: '@' | '#'; value: string; project: Project; stream?: Stream }
  | { kind: 'task'; id: string; title: string; project: Project; stream: Stream | undefined; task: Task }
  | { kind: 'project'; id: string; title: string; project: Project }
  | { kind: 'stream'; id: string; title: string; project: Project; stream: Stream }
  | { kind: 'app'; id: string; title: string; app: InboxApp }
  | { kind: 'queued'; id: string; title: string; project: Project; stream: Stream | undefined; item: QueuedPrompt }
  | { kind: 'command'; id: string; title: string; shortcut?: string }
  | { kind: 'note'; id: string; title: string; projectId: string; noteId: string; detail?: string }
  | { kind: 'file'; id: string; title: string; projectId: string; path: string }

export interface BarSection {
  key: 'start' | 'complete' | 'recent' | 'matches' | 'commands' | 'notes' | 'files'
  label: string | null
  items: BarItem[]
}

export interface BarSources {
  /** Every project, ad-hoc ones too (their tasks are reachable). */
  projects: readonly Project[]
  /** The projects you added, in order: what `@` completes and tasks start in. */
  composeProjects: readonly Project[]
  apps: readonly InboxApp[]
  commands: ReadonlyArray<{ id: string; title: string; searchable: string; shortcut?: string }>
  notes: Readonly<Record<string, ReadonlyArray<{ id: string; name: string; content: string }>>>
  /** The target project's files (relative paths), once loaded; `/` mode only. */
  files: readonly string[] | null
}

type Ranked = { item: BarItem; score: number }

/**
 * Fuzzy match on `searchable`, weighted by recent use. An empty query keeps
 * everything: used items first (most used/recent on top), then the rest in order.
 */
function rank(query: string, items: ReadonlyArray<{ item: BarItem; searchable: string }>, frecency: FrecencyState, now: number): BarItem[] {
  if (!query) {
    const used = items.filter(c => frecency[c.item.id])
      .sort((a, b) => computeFrecencyMultiplier(frecency[b.item.id], now) - computeFrecencyMultiplier(frecency[a.item.id], now))
    return [...used, ...items.filter(c => !frecency[c.item.id])].map(c => c.item)
  }
  const out: Ranked[] = []
  for (const candidate of items) {
    const match = fuzzyMatch(query, candidate.searchable)
    if (!match || match.score < FUZZY_SCORE_FLOOR) continue
    out.push({ item: candidate.item, score: match.score * computeFrecencyMultiplier(frecency[candidate.item.id], now) })
  }
  return out.sort((a, b) => b.score - a.score).map(r => r.item)
}

const notEphemeral = (p: Project): boolean => !isEphemeralProject(p)

/** Tasks, projects, streams, running apps and queued prompts the matches may show. */
function jumpCandidates(bar: ResolvedBar, sources: BarSources, here: BarHere): Array<{ item: BarItem; searchable: string }> {
  // Matches cover the named project (or stream), else the column's scope, else everything; `*` is everything.
  const scopeId = bar.allProjects ? null : bar.stream?.project.id ?? bar.project?.id ?? here.scope?.projectId ?? null
  const inScope = (p: Project): boolean => !scopeId || p.id === scopeId
  const streamOk = (s: Stream | undefined): boolean => bar.allProjects || !bar.stream || s?.id === bar.stream.stream.id
  const out: Array<{ item: BarItem; searchable: string }> = []
  for (const project of sources.projects) {
    if (!inScope(project)) continue
    for (const stream of project.streams) {
      if (!streamOk(stream)) continue
      for (const task of stream.tasks) {
        out.push({ item: { kind: 'task', id: `task:${project.id}:${task.id}`, title: task.name, project, stream, task }, searchable: `${task.name} ${project.name}` })
      }
    }
  }
  if (!bar.project || bar.allProjects) {
    for (const project of sources.projects.filter(notEphemeral)) {
      out.push({ item: { kind: 'project', id: `project:${project.id}`, title: project.name, project }, searchable: project.name })
    }
  }
  for (const project of sources.projects.filter(notEphemeral)) {
    if (!inScope(project)) continue
    for (const stream of project.streams) {
      if (stream.isMain || bar.stream?.stream.id === stream.id) continue
      out.push({ item: { kind: 'stream', id: `stream:${project.id}:${stream.id}`, title: stream.name, project, stream }, searchable: `${stream.name} ${project.name}` })
    }
    for (const item of promptQueue(project)) {
      const stream = queuedPromptStream(project, item)
      if (!streamOk(stream)) continue
      out.push({ item: { kind: 'queued', id: `queued:${project.id}:${item.id}`, title: item.text, project, stream, item }, searchable: item.text })
    }
  }
  for (const app of sources.apps) {
    if (!inScope(app.project) || !streamOk(app.stream)) continue
    out.push({
      item: { kind: 'app', id: `app:${app.project.id}:${app.stream.id}:${app.run.commandId}`, title: app.run.name, app },
      searchable: `${app.run.name} logs ${app.project.name} ${app.stream.name}`
    })
  }
  return out
}

/**
 * Plain words that are better read as "go there" than as a prompt: a few words
 * that a match's title contains whole ("devtool", "run commands").
 */
export function prefersJump(query: string, best: BarItem | undefined): boolean {
  if (!best || !('title' in best)) return false
  const words = query.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0 || words.length > 4) return false
  return best.title.toLowerCase().includes(query.trim().toLowerCase())
}

/** What `@…` / `#…` at the end of the input could become. */
function completions(bar: ResolvedBar, sources: BarSources, here: BarHere): BarItem[] {
  const piece = bar.completing
  if (!piece) return []
  const partial = piece.text.slice(1).toLowerCase()
  const fits = (name: string): boolean => !partial || !!fuzzyMatch(partial, tokenKey(name))
  if (piece.text.startsWith('@')) {
    return sources.composeProjects
      .filter(p => fits(p.name))
      .map(p => ({ kind: 'complete' as const, id: `complete:@${p.id}`, sigil: '@' as const, value: tokenKey(p.name), project: p }))
  }
  // Streams of the project the task would go to first (its main too), then other projects' streams.
  const home = bar.project ?? bar.target?.project ?? defaultProject(sources.composeProjects, here)
  const others = bar.project ? [] : sources.composeProjects.filter(p => p !== home)
  const out: BarItem[] = []
  for (const project of [...(home ? [home] : []), ...others]) {
    for (const stream of project.streams) {
      if (project !== home && stream.isMain) continue
      if (!fits(stream.name)) continue
      out.push({ kind: 'complete', id: `complete:#${stream.id}`, sigil: '#', value: tokenKey(stream.name), project, stream })
    }
  }
  return out
}

const MATCH_LIMIT = 8
const COMMAND_LIMIT = 3

/** The list under the input, section by section. The first item is what ↵ does. */
export function barSections(bar: ResolvedBar, sources: BarSources, here: BarHere, frecency: FrecencyState, now: number): BarSection[] {
  const sections: BarSection[] = []
  const complete = completions(bar, sources, here)
  if (complete.length > 0) sections.push({ key: 'complete', label: bar.completing?.text.startsWith('@') ? 'Projects' : 'Streams', items: complete.slice(0, MATCH_LIMIT) })

  const commands = sources.commands.map(c => ({
    item: { kind: 'command' as const, id: c.id, title: c.title, ...(c.shortcut ? { shortcut: c.shortcut } : {}) },
    searchable: c.searchable
  }))

  if (bar.mode === 'command') {
    sections.push({ key: 'commands', label: null, items: rank(bar.query, commands, frecency, now).slice(0, 50) })
    return sections
  }

  if (bar.mode === 'files') {
    const projectId = bar.target?.project.id ?? null
    const notes: Array<{ item: BarItem; searchable: string }> = []
    for (const [id, list] of Object.entries(sources.notes)) {
      if (!bar.allProjects && id !== projectId) continue
      const project = sources.projects.find(p => p.id === id)
      for (const note of list) {
        notes.push({
          item: { kind: 'note', id: `note:${id}:${note.id}`, title: note.name, projectId: id, noteId: note.id, ...(bar.allProjects && project ? { detail: project.name } : {}) },
          searchable: `${note.name} ${note.content.replace(/\s+/g, ' ').slice(0, 80)}`
        })
      }
    }
    const rankedNotes = rank(bar.query, notes, frecency, now).slice(0, MATCH_LIMIT)
    if (rankedNotes.length > 0) sections.push({ key: 'notes', label: 'Notes', items: rankedNotes })
    if (projectId && sources.files) {
      const files = sources.files.map(path => ({
        item: { kind: 'file' as const, id: `file:${projectId}:${path}`, title: path, projectId, path },
        searchable: path
      }))
      const rankedFiles = rank(bar.query, files, frecency, now).slice(0, 30)
      if (rankedFiles.length > 0) sections.push({ key: 'files', label: 'Files', items: rankedFiles })
    }
    return sections
  }

  const jumps = jumpCandidates(bar, sources, here)
  if (!bar.query) {
    // Nothing typed: recent places. With a token: what is in that project or stream.
    const scoped = !!(bar.project || bar.stream || bar.allProjects)
    const recent = scoped
      ? rank('', jumps, frecency, now)
      : rank('', [...jumps, ...commands].filter(c => frecency[c.item.id]), frecency, now)
    if (recent.length > 0) sections.push({ key: 'recent', label: scoped ? 'In here' : 'Recent', items: recent.slice(0, scoped ? 12 : MATCH_LIMIT) })
    return sections
  }

  const matches = rank(bar.query, jumps, frecency, now).slice(0, MATCH_LIMIT)
  const start: BarSection | null = bar.target
    ? {
        key: 'start',
        label: null,
        items: [
          { kind: 'start', id: 'start', target: bar.target },
          ...(canQueue(bar.target) ? [{ kind: 'queue' as const, id: 'queue' as const, target: bar.target }] : [])
        ]
      }
    : null
  const matchSection: BarSection | null = matches.length > 0 ? { key: 'matches', label: 'Matches', items: matches } : null
  const ordered = prefersJump(bar.query, matches[0]) ? [matchSection, start] : [start, matchSection]
  for (const section of ordered) if (section) sections.push(section)
  const rankedCommands = rank(bar.query, commands, frecency, now).slice(0, COMMAND_LIMIT)
  if (rankedCommands.length > 0) sections.push({ key: 'commands', label: 'Commands', items: rankedCommands })
  return sections
}

/** The input with the `@…`/`#…` being typed replaced by a finished token and a space. */
export function completeToken(input: string, piece: BarPiece, sigil: '@' | '#', value: string): string {
  return `${input.slice(0, piece.start)}${sigil}${value} ${input.slice(piece.end)}`
}
