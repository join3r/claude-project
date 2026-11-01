import fs from 'fs'
import path from 'path'
import type { Project, Stream, Task } from '../shared/types'
import { taskDirectory, taskTabs } from '../shared/streams'
import { HOOK_TAB_ID_HEADER, HOOK_TOKEN_HEADER } from '../shared/hook-protocol'
import { readWorktreeConfig } from './worktree-setup'

/**
 * What an agent DevTool starts is told about where it runs: its task, stream and
 * branch, that DevTool (not the agent) lands the task and merges the stream, and
 * what it shares with the tasks running beside it. Without it agents merged and
 * cherry-picked task branches by hand, pulled `main` into streams, ran `npm
 * install` into another worktree's linked `node_modules` and killed each other's
 * dev servers.
 *
 * Claude gets it from its SessionStart hook (also after a resume or compaction),
 * a chat tab as an appended system prompt, Pi before every turn, Codex as
 * `developer_instructions`.
 */

/** How the agent reaches DevTool's hook server to land or update its task. */
export interface AgentContextHook {
  port: number
  /** The tab's own token (`HookServer.tabToken`), good for this task's land/update only. */
  token: string
  tabId: string
}

/** A `.devtool/worktree.json` symlink in the task's worktree and where it points. */
export interface SharedLink {
  entry: string
  target: string
}

export interface AgentContextInput {
  project: Pick<Project, 'name' | 'directory'>
  stream: Pick<Stream, 'name' | 'isMain' | 'workspace'>
  task: Pick<Task, 'name' | 'workspace'>
  /** The folder the agent runs in. */
  dir: string
  hook?: AgentContextHook
  links?: SharedLink[]
}

function code(text: string): string {
  return `\`${text}\``
}

/** How the user may ask to merge into the stream's base branch. */
function mergeAsk(base: string): string {
  return base === 'main' || base === 'master' ? `"Merge to ${base}"` : `"Merge to ${base}" (or to main/master)`
}

function hookCommand(hook: AgentContextHook, endpoint: string, body: string): string {
  return `curl -s -X POST http://127.0.0.1:${hook.port}/hook/${endpoint} -H '${HOOK_TAB_ID_HEADER}: ${hook.tabId}' -H '${HOOK_TOKEN_HEADER}: ${hook.token}' -d '${body}'`
}

function sharedLines(links: SharedLink[]): string[] {
  const lines: string[] = []
  for (const link of links) {
    lines.push(
      `- ${code(link.entry)} here is a symlink to ${code(link.target)}, shared with other tasks. Never install, update or delete into it (no npm/pnpm/yarn install or ci through the link). ` +
      `To change dependencies, first replace the link with this worktree's own copy (${code(`rm ${link.entry}`)}, then install).`
    )
  }
  lines.push(
    '- Other tasks may be running their own dev servers, apps and builds at the same time. Use free ports rather than fixed ones, and stop only processes you started (by PID). ' +
    'Never use broad `pkill -f` / `killall` patterns that match other tasks\' processes.'
  )
  return lines
}

/** The note for one agent. Pure; {@link agentContextForTab} gathers its input. */
export function buildAgentContext(input: AgentContextInput): string {
  const { project, stream, task, dir, hook } = input
  const own = task.workspace
  const lines: string[] = [
    'DevTool context. DevTool is the app that started you; this describes where you run and holds for the whole session.',
    `- Project "${project.name}", stream "${stream.name}", task "${task.name}". Your folder: ${code(dir)}.`
  ]

  if (own) {
    const target = own.baseBranch
    const where = stream.isMain ? `the project folder ${code(project.directory)}` : stream.workspace ? `the stream's worktree ${code(stream.workspace.worktreePath)}` : code(project.directory)
    lines.push(
      `- This is the task's own git worktree, on branch ${code(own.branchName)}, cut from ${code(target)} (checked out in ${where}). Other tasks work in parallel in worktrees of their own.`,
      `- DevTool does the merging. When the user closes this task, or picks "Land and keep working", DevTool commits anything uncommitted, squashes this branch into one commit (the task's name, with your commit subjects listed in it), rebases it onto ${code(target)} and fast-forwards ${code(target)}.` +
        (stream.isMain || !stream.workspace ? '' : ` Closing the stream "${stream.name}" in DevTool merges ${code(target)} into ${code(stream.workspace.baseBranch)}.`),
      `- So commit on ${code(own.branchName)} as you go, and leave moving work between branches to DevTool. Do not merge, rebase onto, cherry-pick, pull or switch branches yourself; do not commit in the main checkout, the stream's worktree or another task's worktree; do not make worktrees of your own to combine branches.`,
      '- Finished work on this branch is not "unmerged" or at risk: closing the task lands it. Do not ask whether to merge, and do not record it as unmerged in memory.'
    )
    if (hook) {
      lines.push(
        `- If the user asks you to merge or land this task into ${code(target)}, land it through DevTool (it keeps this task and worktree open, on the new tip):`,
        `  ${hookCommand(hook, 'land', '{"summary":"<what this task changed, one short paragraph, no single quotes>"}')}`,
        `  To take in what landed on ${code(target)} since this task started (instead of git pull or merge), the same call to ${code('/hook/update')} with ${code('-d \'{}\'')}.`,
        '  If either one reports a conflict, resolve it in this worktree (edit, `git add`, `GIT_EDITOR=true git rebase --continue`) and run it again. Never abort it.'
      )
    }
    if (!stream.isMain && stream.workspace) {
      lines.push(`- ${mergeAsk(stream.workspace.baseBranch)} means closing the stream "${stream.name}" in DevTool, which the user does. Tell them so rather than merging by hand.`)
    }
    lines.push(`- Pushing, deploying, releasing or uploading a build from this branch ships work that has not landed in ${code(target)} yet. Land first, or say so and ask.`)
  } else if (stream.workspace) {
    lines.push(
      `- This is the stream's git worktree, on branch ${code(stream.workspace.branchName)}, shared with the stream's other tasks: your commits go straight onto ${code(stream.workspace.branchName)}. Stay on it; do not switch branches or commit in other worktrees.`,
      `- Closing the stream "${stream.name}" in DevTool merges ${code(stream.workspace.branchName)} into ${code(stream.workspace.baseBranch)}. ${mergeAsk(stream.workspace.baseBranch)} means that, which the user does; do not merge by hand.`
    )
  } else {
    lines.push('- This is the project folder itself, on whatever branch it has checked out. Other tasks may be working in the same folder at the same time: do not switch branches, reset, stash or discard changes you did not make.')
  }

  lines.push(...sharedLines(input.links ?? []))
  return lines.join('\n')
}

/** The `.devtool/worktree.json` symlinks that are links in `root`, and where they point. */
export function sharedLinksIn(root: string): SharedLink[] {
  const loaded = readWorktreeConfig(root)
  if (!loaded.ok) return []
  const links: SharedLink[] = []
  for (const entry of loaded.config.symlink) {
    const at = path.join(root, entry)
    try {
      if (!fs.lstatSync(at).isSymbolicLink()) continue
      links.push({ entry, target: fs.realpathSync(at) })
    } catch {
      // Missing or dangling: nothing shared to warn about.
    }
  }
  return links
}

/**
 * The note for the agent in `tabId`, or null when no project task owns the tab.
 * `hook` is omitted where the agent can't reach DevTool's hook server.
 */
export function agentContextForTab(
  projects: readonly Project[],
  tabId: string,
  hook?: Omit<AgentContextHook, 'tabId'>
): string | null {
  for (const project of projects) {
    for (const stream of project.streams ?? []) {
      const task = stream.tasks.find(candidate => taskTabs(candidate).some(tab => tab.id === tabId))
      if (!task) continue
      // SSH projects: the agent runs on another machine, which these paths aren't on.
      if (project.ssh) return null
      const root = task.workspace?.worktreePath ?? stream.workspace?.worktreePath
      return buildAgentContext({
        project,
        stream,
        task,
        dir: taskDirectory(project, task),
        hook: task.workspace && hook ? { ...hook, tabId } : undefined,
        links: root ? sharedLinksIn(root) : []
      })
    }
  }
  return null
}
