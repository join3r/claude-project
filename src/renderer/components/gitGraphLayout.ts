import type { GitGraphCommit } from '../../shared/types'

/**
 * A line inside one row, between lane columns: `top` runs from the row's top
 * edge to its node's height, `bottom` from the node's height to the bottom
 * edge, `full` across the whole row.
 */
export interface GraphSegment {
  from: number
  to: number
  part: 'top' | 'bottom' | 'full'
  /** The lane the line belongs to, for its color. */
  lane: number
}

export interface GraphRow {
  commit: GitGraphCommit
  /** The column of the commit's dot. */
  column: number
  segments: GraphSegment[]
  /** More than one parent. */
  merge: boolean
}

export interface GraphLayout {
  rows: GraphRow[]
  /** The most columns any row uses. */
  width: number
}

/**
 * Lanes for commits newest first in topological order (`git log --topo-order`).
 * Each lane waits for one commit (a parent of a row above). A commit takes the
 * leftmost lane waiting for it, or a free one if none is (a branch tip); the
 * other lanes waiting for it join it there. Its first parent continues its
 * lane, and every other parent gets a lane of its own unless one already waits
 * for it. Lanes never shift sideways, so a line keeps its column.
 */
export function layoutGraph(commits: readonly GitGraphCommit[]): GraphLayout {
  const lanes: (string | null)[] = []
  const rows: GraphRow[] = []
  let width = 0
  const free = (): number => {
    const index = lanes.indexOf(null)
    if (index >= 0) return index
    lanes.push(null)
    return lanes.length - 1
  }

  for (const commit of commits) {
    const segments: GraphSegment[] = []
    const before = lanes.slice()
    let column = lanes.indexOf(commit.hash)
    if (column < 0) column = free()
    for (let lane = 0; lane < lanes.length; lane++) {
      const waiting = lanes[lane]
      if (waiting === null) continue
      if (waiting === commit.hash) {
        segments.push({ from: lane, to: column, part: 'top', lane })
        if (lane !== column) lanes[lane] = null
      }
    }
    const [first, ...others] = commit.parents
    lanes[column] = first ?? null
    if (first) segments.push({ from: column, to: column, part: 'bottom', lane: column })
    for (const parent of others) {
      let lane = lanes.indexOf(parent)
      if (lane < 0) {
        lane = free()
        lanes[lane] = parent
      }
      segments.push({ from: column, to: lane, part: 'bottom', lane })
    }
    // Lanes waiting for an older commit pass through.
    before.forEach((waiting, lane) => {
      if (waiting !== null && waiting !== commit.hash) segments.push({ from: lane, to: lane, part: 'full', lane })
    })
    while (lanes.length > 0 && lanes[lanes.length - 1] === null) lanes.pop()
    width = Math.max(width, column + 1, lanes.length)
    rows.push({ commit, column, segments, merge: commit.parents.length > 1 })
  }
  return { rows, width }
}
