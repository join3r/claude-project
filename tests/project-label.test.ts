import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { PROJECT_TILE_PALETTE, projectHue, projectSwatch, projectTile, taskPlace } from '../src/shared/project-label'
import { fnv1a32 } from '../protocol/ts/project-tile.ts'

/** Read from the JSON alone, the way the Swift tests read it (SPEC.md §10). */
const vectors = JSON.parse(readFileSync(new URL('../protocol/vectors/project-tile.json', import.meta.url), 'utf8')) as {
  palette: unknown
  tiles: { id: string; name: string; emoji?: string; fnv1a32: number; text: string; hue: number }[]
  places: { project: string; stream?: { name: string; isMain?: boolean }; place: string }[]
}

describe('project tile', () => {
  it('uses the palette in the vectors', () => {
    expect(PROJECT_TILE_PALETTE).toEqual(vectors.palette)
  })

  it.each(vectors.tiles)('derives $name ($id)', ({ id, name, emoji, fnv1a32: hash, text, hue }) => {
    expect(fnv1a32(id)).toBe(hash)
    expect(projectTile({ id, name, emoji })).toEqual({ text, hue, ...(emoji ? { emoji } : {}) })
  })

  it('keeps a project the same colour whatever its name', () => {
    const a = projectTile({ id: 'p1', name: 'one' })
    const b = projectTile({ id: 'p1', name: 'renamed', emoji: '🦀' })
    expect(a.hue).toBe(b.hue)
    expect(projectHue('p1')).toBe(a.hue)
    expect(projectSwatch(a, 'dark')).toBe(PROJECT_TILE_PALETTE[a.hue].dark)
  })

  it('treats a blank emoji as none', () => {
    expect(projectTile({ id: 'p1', name: 'one', emoji: '  ' })).not.toHaveProperty('emoji')
  })
})

describe('taskPlace', () => {
  it.each(vectors.places)('places $project in $stream.name', ({ project, stream, place }) => {
    expect(taskPlace(project, stream)).toBe(place)
  })
})
