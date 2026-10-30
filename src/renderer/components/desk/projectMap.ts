/**
 * Pure logic behind the desk's Project map (plan change 4, board Project.dc.html):
 * one lane per stream, its commits older → newer with the stream's open tasks
 * placed where they branched off, and the stream's ahead/behind against the
 * branch it was cut from. Everything comes from one `GitBranchGraph` of the
 * project's branches (`git-branch-graph.ts`), so a lane only knows the commits
 * that graph loaded.
 */
import type { GitBranchGraph, GitGraphCommit, Project, Stream, Task } from '../../../shared/types'

/** How many of a lane's newest commits it draws. */
export const LANE_COMMITS = 8

/** What a lane's track shows, older first. */
export type TrackItem =
  | { kind: 'commit'; commit: GitGraphCommit }
  | { kind: 'task'; task: Task }

export interface LaneTrack {
  /** The branch the lane draws; null when the stream has none git knows. */
  branch: string | null
  /** The stream works in the project folder (no worktree of its own). */
  projectFolder: boolean
  items: TrackItem[]
  /**
   * Commits on the stream's branch that its base doesn't have (worktree
   * streams only); null when there is no base to count against.
   */
  ahead: number | null
  /** Commits on the base the stream doesn't have yet; null like `ahead`. */
  behind: number | null
  /** The counts stopped at the end of the loaded graph, so they may be higher. */
  partial: boolean
  /** The lane's newest commit, for "Quiet for 6 days". */
  newest: GitGraphCommit | null
}

/** Every commit reachable from `tip` within the loaded graph. Reports whether a parent fell outside it. */
function ancestors(byHash: ReadonlyMap<string, GitGraphCommit>, tip: string | undefined): { set: Set<string>; cut: boolean } {
  const set = new Set<string>()
  let cut = false
  const stack = tip ? [tip] : []
  while (stack.length > 0) {
    const hash = stack.pop() as string
    if (set.has(hash)) continue
    const commit = byHash.get(hash)
    if (!commit) { cut = true; continue }
    set.add(hash)
    stack.push(...commit.parents)
  }
  return { set, cut }
}

/** The first-parent chain from `tip`, newest first, while `keep` says so and the graph has it. */
function firstParentChain(byHash: ReadonlyMap<string, GitGraphCommit>, tip: string | undefined, keep: (hash: string) => boolean = () => true): { chain: GitGraphCommit[]; cut: boolean } {
  const chain: GitGraphCommit[] = []
  let hash = tip
  const seen = new Set<string>()
  while (hash && keep(hash) && !seen.has(hash)) {
    seen.add(hash)
    const commit = byHash.get(hash)
    if (!commit) return { chain, cut: true }
    chain.push(commit)
    hash = commit.parents[0]
  }
  return { chain, cut: false }
}

/**
 * The stream's lane. The main stream draws the project folder's branch; a
 * worktree stream draws the commits it has on top of its base, with ahead and
 * behind counted against that base. Any other project-folder stream shares
 * main's checkout, so it draws no commits of its own, only its tasks.
 *
 * Open tasks with a branch of their own sit just after the lane commit they
 * branched off (at the start when that is older than what is drawn); the rest
 * sit at the newer end, in the stream's order.
 */
export function laneTrack(graph: GitBranchGraph | null, stream: Stream, maxCommits = LANE_COMMITS): LaneTrack {
  const projectFolder = !stream.workspace
  const branch = stream.workspace?.branchName ?? graph?.head ?? null
  const ownsHistory = !projectFolder || !!stream.isMain
  const byHash = new Map((graph?.commits ?? []).map(c => [c.hash, c]))
  const tip = branch ? graph?.tips[branch] : undefined

  let commits: GitGraphCommit[] = []
  let ahead: number | null = null
  let behind: number | null = null
  let partial = false
  if (graph && ownsHistory && tip) {
    const base = stream.workspace?.baseBranch
    const baseTip = base ? graph.tips[base] : undefined
    if (stream.workspace && baseTip) {
      const onBase = ancestors(byHash, baseTip)
      const own = firstParentChain(byHash, tip, hash => !onBase.set.has(hash))
      const mine = ancestors(byHash, tip)
      commits = own.chain
      ahead = own.chain.length
      behind = [...onBase.set].filter(hash => !mine.set.has(hash)).length
      partial = own.cut || onBase.cut || mine.cut
    } else {
      commits = firstParentChain(byHash, tip).chain
    }
  }
  const newest = commits[0] ?? null
  const shown = commits.slice(0, maxCommits).reverse()

  // Where each task goes: after the shown commit it forked from (-1: before them all), or at the end.
  const slotOf = new Map(shown.map((c, i) => [c.hash, i]))
  const allOwn = new Set(commits.map(c => c.hash))
  const atSlot = new Map<number, Task[]>()
  const atEnd: Task[] = []
  for (const task of stream.tasks) {
    const taskTip = task.workspace && graph ? graph.tips[task.workspace.branchName] : undefined
    let slot: number | null = null
    if (taskTip && shown.length > 0) {
      const { chain } = firstParentChain(byHash, taskTip)
      const fork = chain.find(c => slotOf.has(c.hash) || allOwn.has(c.hash))
      if (fork) slot = slotOf.get(fork.hash) ?? -1
    }
    // A fork at the lane's newest commit is the same as the end.
    if (slot === null || slot === shown.length - 1) atEnd.push(task)
    else atSlot.set(slot, [...(atSlot.get(slot) ?? []), task])
  }
  const items: TrackItem[] = (atSlot.get(-1) ?? []).map(task => ({ kind: 'task' as const, task }))
  shown.forEach((commit, i) => {
    items.push({ kind: 'commit', commit })
    for (const task of atSlot.get(i) ?? []) items.push({ kind: 'task', task })
  })
  for (const task of atEnd) items.push({ kind: 'task', task })

  return { branch, projectFolder, items, ahead, behind, partial, newest }
}

/** "3 ahead of master · 1 behind", "up to date with master", "12+ ahead of master". */
export function aheadBehindLine(track: LaneTrack, base: string): string | null {
  if (track.ahead === null || track.behind === null) return null
  const plus = track.partial ? '+' : ''
  if (track.ahead === 0 && track.behind === 0) return `up to date with ${base}`
  const parts: string[] = []
  if (track.ahead > 0) parts.push(`${track.ahead}${plus} ahead of ${base}`)
  if (track.behind > 0) parts.push(`${track.behind}${plus} behind${track.ahead > 0 ? '' : ` ${base}`}`)
  return parts.join(' · ')
}

/** "Quiet for 6 days", "Quiet since yesterday", null within the day or with nothing to go on. */
export function quietFor(isoDate: string | undefined, now: number): string | null {
  if (!isoDate) return null
  const at = new Date(isoDate).getTime()
  if (!Number.isFinite(at)) return null
  const days = Math.floor((now - at) / 86_400_000)
  if (days < 1) return null
  if (days === 1) return 'Quiet since yesterday'
  if (days < 60) return `Quiet for ${days} days`
  return `Quiet for ${Math.floor(days / 30)} months`
}

/** "This Mac", the server's name, "user@host" for SSH, or the custom shell's name from Settings › Hosts. */
export function projectHostLabel(project: Project, serverName?: string, shellName?: string): string {
  if (project.ssh) return project.ssh.username ? `${project.ssh.username}@${project.ssh.host}` : project.ssh.host
  if (project.host) return serverName ?? 'Server'
  if (project.shellCommand) return shellName || 'Custom shell'
  return 'This Mac'
}

/** `one` or `many` by count. */
export function plural(n: number, one: string, many = `${one}s`): string {
  return n === 1 ? one : many
}

export interface HeatDay {
  /** Local `YYYY-MM-DD`. */
  iso: string
  date: Date
  count: number
}

/**
 * The last `weeks` weeks as columns of seven days (Monday first), oldest week
 * first, ending with the week of `now`; days after `now` are left out.
 */
export function recentWeeks(dayCounts: ReadonlyMap<string, number>, now: Date, weeks: number): HeatDay[][] {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const monday = new Date(today)
  monday.setDate(today.getDate() - ((today.getDay() + 6) % 7) - (weeks - 1) * 7)
  const cols: HeatDay[][] = []
  for (let week = 0; week < weeks; week++) {
    const col: HeatDay[] = []
    for (let dow = 0; dow < 7; dow++) {
      const date = new Date(monday)
      date.setDate(monday.getDate() + week * 7 + dow)
      if (date > today) break
      const iso = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
      col.push({ iso, date, count: dayCounts.get(iso) ?? 0 })
    }
    cols.push(col)
  }
  return cols
}
