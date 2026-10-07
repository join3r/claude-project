/**
 * How a project looks wherever one of its tasks or streams shows up outside its own
 * screen (§10): a tile (emoji, else initials, on a colour from the project id) and a
 * `project › stream` place. The desktop and the phone derive the same tile, checked
 * against `protocol/vectors/project-tile.json`. The desktop reaches this through
 * `src/shared/project-label.ts`.
 */

/** One tile colour, for each theme. Hex `#rrggbb`. */
export interface ProjectTileSwatch {
  name: string
  light: { bg: string; fg: string }
  dark: { bg: string; fg: string }
}

/** The fixed palette a project id hashes into. Order is part of the spec (§10). */
export const PROJECT_TILE_PALETTE: readonly ProjectTileSwatch[] = [
  { name: 'red', light: { bg: '#fde2e1', fg: '#b42318' }, dark: { bg: '#4a1d1b', fg: '#fca5a0' } },
  { name: 'orange', light: { bg: '#fde8d4', fg: '#b54708' }, dark: { bg: '#4a2a12', fg: '#fdba74' } },
  { name: 'amber', light: { bg: '#fbf0c8', fg: '#8a6100' }, dark: { bg: '#43360f', fg: '#fcd34d' } },
  { name: 'green', light: { bg: '#dcf3e2', fg: '#1f7a3d' }, dark: { bg: '#173d24', fg: '#86efac' } },
  { name: 'teal', light: { bg: '#d5f2ef', fg: '#0f766e' }, dark: { bg: '#123c39', fg: '#5eead4' } },
  { name: 'blue', light: { bg: '#dbe8fe', fg: '#1d4ed8' }, dark: { bg: '#1a2e55', fg: '#93c5fd' } },
  { name: 'violet', light: { bg: '#ebe3fd', fg: '#6d28d9' }, dark: { bg: '#33224f', fg: '#c4b5fd' } },
  { name: 'pink', light: { bg: '#fbe0ee', fg: '#be185d' }, dark: { bg: '#4a1a33', fg: '#f9a8d4' } }
]

export interface ProjectTile {
  /** Up to two initials; always set, so a failed emoji or icon can fall back to it. */
  text: string
  emoji?: string
  /** Index into `PROJECT_TILE_PALETTE`. */
  hue: number
}

export function projectTile(project: { id: string; name: string; emoji?: string }): ProjectTile {
  const emoji = project.emoji?.trim()
  return {
    text: projectInitials(project.name),
    ...(emoji ? { emoji } : {}),
    hue: projectHue(project.id)
  }
}

export function projectSwatch(tile: ProjectTile, theme: 'light' | 'dark'): { bg: string; fg: string } {
  return PROJECT_TILE_PALETTE[tile.hue % PROJECT_TILE_PALETTE.length][theme]
}

/** FNV-1a 32-bit over the UTF-8 bytes of `text`. */
export function fnv1a32(text: string): number {
  let hash = 0x811c9dc5
  for (const byte of new TextEncoder().encode(text)) {
    hash ^= byte
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash >>> 0
}

export function projectHue(projectId: string): number {
  return fnv1a32(projectId) % PROJECT_TILE_PALETTE.length
}

const WORD_CHAR = /[\p{L}\p{N}]/u
const LOWER = /\p{Ll}/u
const UPPER = /\p{Lu}/u

/**
 * Words are runs of letters and digits (anything else separates them), and a run
 * also breaks where a lowercase letter meets an uppercase one (`devTool`). Two or
 * more words give their first characters; one word its first two; none, the
 * name's first character; an empty name `?`. Works on code points, uppercased.
 */
export function projectInitials(name: string): string {
  const words: string[][] = []
  let word: string[] = []
  for (const ch of Array.from(name)) {
    if (!WORD_CHAR.test(ch)) {
      if (word.length) words.push(word)
      word = []
      continue
    }
    const prev = word[word.length - 1]
    if (prev && LOWER.test(prev) && UPPER.test(ch)) {
      words.push(word)
      word = []
    }
    word.push(ch)
  }
  if (word.length) words.push(word)

  let picked: string[]
  if (words.length >= 2) picked = [words[0][0], words[1][0]]
  else if (words.length === 1) picked = words[0].slice(0, 2)
  else {
    const first = Array.from(name.trim())[0]
    picked = first ? [first] : ['?']
  }
  return picked.join('').toUpperCase()
}

/** `project › stream`, or just `project` on the `main` stream or with no stream. */
export function taskPlace(projectName: string, stream?: { name: string; isMain?: boolean } | null): string {
  if (!stream || stream.isMain || !stream.name) return projectName
  return `${projectName} › ${stream.name}`
}
