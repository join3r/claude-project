// src/renderer/palette/types.ts
import type { AppActions } from '../hooks/useAppState'

export type Prefix = '>' | '@' | '#' | ':'
export type ParsedInput = {
  prefix: Prefix | null
  allProjects: boolean
  query: string
}

export type EntityKind = 'project' | 'task' | 'tab' | 'note' | 'command'

export interface PaletteEntity {
  kind: EntityKind
  id: string
  title: string
  subtitle?: string
  searchable: string
  scopeProjectId?: string
  shortcut?: string
}

export interface ScoredResult {
  entity: PaletteEntity
  score: number
  matchSpans: [number, number][]
}

export interface AppCtx {
  actions: AppActions
}

export interface Command {
  id: string
  title: string
  aliases?: string[]
  shortcut?: string
  when?: (ctx: AppCtx) => boolean
  run: (ctx: AppCtx) => void | Promise<void>
}
