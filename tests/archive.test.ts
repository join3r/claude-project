import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { isSpentEphemeralProject, mainStreamId, type ProjectsData, type WorkspaceConfig } from '../src/shared/types'
import {
  archiveStreamInData,
  archiveTasksInData,
  archivedStreamEntry,
  archivedTabIds,
  archivedTaskEntry,
  archivedTasksOf,
  emptyArchive,
  normalizeArchive,
  reopenStreamInData,
  reopenTaskInData,
  syncArchiveCounts,
  vanishedProjectIds,
  visibleArchive,
  withArchivedStream,
  withArchivedTasks,
  withoutArchived
} from '../src/shared/archive'
import { findTaskInProject, projectTasks } from '../src/shared/streams'
import { ArchiveStorage } from '../src/main/archive-storage'
import { fixtureProject } from './helpers/streams-fixtures'

const WORKTREE: WorkspaceConfig = { worktreePath: '/tmp/p/.worktrees/rel', branchName: 'rel', baseBranch: 'master', relativeProjectPath: '' }
const term = (id: string) => ({ id, type: 'terminal' as const, title: 'Terminal' })

function data(): ProjectsData {
  const project = fixtureProject({
    id: 'p',
    directory: '/tmp/p',
    tasks: [
      { id: 'a', tabs: { left: [term('tab-a')] } },
      { id: 'b', tabs: { left: [term('tab-b')] } },
      { id: 'w', workspace: WORKTREE, tabs: { left: [term('tab-w')] } }
    ]
  })
  return {
    projects: [project],
    tags: [],
    projectOrder: ['p'],
    pinnedItems: [
      { type: 'task', projectId: 'p', streamId: mainStreamId('p'), taskId: 'a' },
      { type: 'stream', projectId: 'p', streamId: 'stream-w' },
      { type: 'project', projectId: 'p' }
    ]
  }
}

describe('archiving tasks in the data', () => {
  it('moves a task to its stream\'s Done count and drops its pin; the stream stays', () => {
    const next = archiveTasksInData(data(), 'p', ['a'])
    const main = next.projects[0].streams[0]
    expect(main.tasks.map(t => t.id)).toEqual(['b'])
    expect(main.archivedTaskCount).toBe(1)
    expect(next.pinnedItems).toEqual([
      { type: 'stream', projectId: 'p', streamId: 'stream-w' },
      { type: 'project', projectId: 'p' }
    ])
    // A replay that finds the task gone counts nothing twice.
    expect(archiveTasksInData(next, 'p', ['a'])).toBe(next)
    const both = archiveTasksInData(next, 'p', ['b'])
    expect(both.projects[0].streams[0]).toMatchObject({ tasks: [], archivedTaskCount: 2 })
  })

  it('keeps an emptied worktree stream', () => {
    const next = archiveTasksInData(data(), 'p', ['w'])
    expect(next.projects[0].streams[1]).toMatchObject({ id: 'stream-w', workspace: WORKTREE, tasks: [], archivedTaskCount: 1 })
  })

  it('retires a hidden project with its last open task; archived tasks do not keep it alive', () => {
    const hidden = { ...fixtureProject({ id: 'h', tasks: [{ id: 'x' }] }), ephemeral: true as const }
    const before: ProjectsData = { projects: [hidden], tags: [], projectOrder: ['h'], pinnedItems: [{ type: 'project', projectId: 'h' }] }
    const next = archiveTasksInData(before, 'h', ['x'])
    expect(next.projects).toEqual([])
    expect(next.projectOrder).toEqual([])
    expect(next.pinnedItems).toEqual([])
    // With only archived tasks counted, the project is spent.
    const onlyArchived = { ...hidden, streams: [{ ...hidden.streams[0], tasks: [], archivedTaskCount: 3 }] }
    expect(isSpentEphemeralProject(onlyArchived)).toBe(true)
    expect(vanishedProjectIds(before.projects, next.projects)).toEqual(['h'])
  })
})

describe('archiving streams in the data', () => {
  it('moves the stream to the project\'s Done group with its pins gone; never main', () => {
    const before = data()
    const next = archiveStreamInData(before, 'p', 'stream-w')
    expect(next.projects[0].streams.map(s => s.id)).toEqual([mainStreamId('p')])
    expect(next.projects[0].archivedStreamCount).toBe(1)
    expect(next.pinnedItems.some(item => item.type === 'stream')).toBe(false)
    expect(archiveStreamInData(before, 'p', mainStreamId('p'))).toBe(before)
    expect(archiveStreamInData(next, 'p', 'stream-w')).toBe(next)
  })
})

describe('the archive file', () => {
  it('takes a stream\'s earlier archived tasks into the stream when it closes', () => {
    const project = data().projects[0]
    const first = archivedTaskEntry(project, 'w', 1)!
    expect(first).toMatchObject({ streamId: 'stream-w', streamName: 'w', dir: WORKTREE.worktreePath })
    const afterTask = archiveTasksInData(data(), 'p', ['w']).projects[0]
    const archive = withArchivedTasks(emptyArchive(), [first, archivedTaskEntry(project, 'a', 2)!])
    const stream = archivedStreamEntry(afterTask, 'stream-w', 3)!
    expect(stream.stream.archivedTaskCount).toBeUndefined()
    const next = withArchivedStream(archive, stream)
    expect(next.tasks.map(t => t.task.id)).toEqual(['a'])
    expect(next.streams[0].doneTasks.map(t => t.task.id)).toEqual(['w'])
    expect(archivedTabIds(next).sort()).toEqual(['tab-a', 'tab-w'])
    expect(withoutArchived(next, { streams: ['stream-w'] }).streams).toEqual([])
  })

  it('lists a stream\'s archived tasks newest first and hides entries that are live again', () => {
    const project = data().projects[0]
    const archive = withArchivedTasks(emptyArchive(), [
      { ...archivedTaskEntry(project, 'a', 1)! },
      { ...archivedTaskEntry(project, 'b', 5)! }
    ])
    // Both are still live in `project` (an interrupted reopen): hidden.
    expect(visibleArchive(archive, project).tasks).toEqual([])
    const after = archiveTasksInData(data(), 'p', ['a', 'b']).projects[0]
    expect(archivedTasksOf(visibleArchive(archive, after), mainStreamId('p')).map(t => t.task.id)).toEqual(['b', 'a'])
  })

  it('normalizes whatever was on disk', () => {
    expect(normalizeArchive(null)).toEqual(emptyArchive())
    const raw = { tasks: [{ task: { id: 't', name: 'T', panes: [] }, streamId: 's' }, { bogus: true }], streams: [{ nope: 1 }] }
    expect(normalizeArchive(raw)).toEqual({
      version: 1,
      tasks: [{ task: { id: 't', name: 'T', panes: [] }, streamId: 's', streamName: '', dir: '', archivedAt: 0 }],
      streams: []
    })
  })
})

describe('reopening', () => {
  it('a task goes back to its stream and the count goes down (round trip)', () => {
    const before = data()
    const entry = archivedTaskEntry(before.projects[0], 'a', 1)!
    const archived = archiveTasksInData(before, 'p', ['a'])
    const reopened = reopenTaskInData(archived, 'p', entry)
    const main = reopened.projects[0].streams[0]
    expect(main.tasks.map(t => t.id)).toEqual(['b', 'a'])
    expect(main.archivedTaskCount).toBeUndefined()
    expect(reopenTaskInData(reopened, 'p', entry)).toBe(reopened)
  })

  it('a task whose stream is closed goes to main', () => {
    const before = data()
    const entry = archivedTaskEntry(before.projects[0], 'w', 1)!
    const gone = archiveStreamInData(archiveTasksInData(before, 'p', ['w']), 'p', 'stream-w')
    const reopened = reopenTaskInData(gone, 'p', entry)
    expect(reopened.projects[0].streams[0].tasks.map(t => t.id)).toEqual(['a', 'b', 'w'])
  })

  it('a stream comes back with its tasks, its Done count and the restored worktree, or without one', () => {
    const before = data()
    const withDone = archiveTasksInData(before, 'p', ['w'])
    const doneEntry = archivedTaskEntry(before.projects[0], 'w', 1)!
    const streamEntry = withArchivedStream(withArchivedTasks(emptyArchive(), [doneEntry]), archivedStreamEntry(withDone.projects[0], 'stream-w', 2)!).streams[0]
    const archived = archiveStreamInData(withDone, 'p', 'stream-w')

    const moved = { ...WORKTREE, worktreePath: '/tmp/p/.worktrees/rel-2' }
    const back = reopenStreamInData(archived, 'p', streamEntry, moved)
    expect(back.projects[0].archivedStreamCount).toBeUndefined()
    expect(back.projects[0].streams[1]).toMatchObject({ id: 'stream-w', workspace: moved, tasks: [], archivedTaskCount: 1 })
    expect(reopenStreamInData(back, 'p', streamEntry, moved)).toBe(back)

    // The branch was discarded: a project-folder stream.
    const folder = reopenStreamInData(archived, 'p', streamEntry, null).projects[0].streams[1]
    expect(folder.workspace).toBeUndefined()
    expect(folder.name).toBe('w')
  })

  it('a stream archived before task worktrees comes back with its tasks still sharing its worktree', () => {
    const before = data()
    const streamEntry = archivedStreamEntry(before.projects[0], 'stream-w', 1)!
    expect(streamEntry.stream.taskWorktrees).toBeUndefined()
    const archived = archiveStreamInData(before, 'p', 'stream-w')
    const back = reopenStreamInData(archived, 'p', streamEntry, WORKTREE).projects[0].streams[1]
    expect(back.taskWorktrees).toBe(true)
    expect(back.tasks.map(t => t.sharesStreamWorktree)).toEqual([true])
    // A stream archived since keeps its tasks as they were.
    const marked = { ...streamEntry, stream: { ...streamEntry.stream, taskWorktrees: true as const } }
    expect(reopenStreamInData(archived, 'p', marked, WORKTREE).projects[0].streams[1].tasks[0]).not.toHaveProperty('sharesStreamWorktree')
  })

  it('a task with a worktree of its own is archived with that directory', () => {
    const own: WorkspaceConfig = { worktreePath: '/tmp/p/.worktrees/rel--fix', branchName: 'rel--fix', baseBranch: 'rel', relativeProjectPath: 'app' }
    const project = fixtureProject({ id: 'p', directory: '/tmp/p/app', tasks: [{ id: 'w', workspace: WORKTREE, ownWorkspace: own }] })
    expect(archivedTaskEntry(project, 'w', 1)!.dir).toBe('/tmp/p/.worktrees/rel--fix/app')
  })
})

describe('Done counts', () => {
  it('follow the archive file, ignoring entries that are live', () => {
    const before = data()
    const archived = archiveTasksInData(before, 'p', ['a'])
    const archive = withArchivedTasks(emptyArchive(), [
      archivedTaskEntry(before.projects[0], 'a', 1)!,
      archivedTaskEntry(before.projects[0], 'b', 2)!
    ])
    // `b` is live: only `a` counts. The count (1) already agrees.
    expect(syncArchiveCounts(archived, 'p', archive)).toBe(archived)
    const drifted = { ...archived, projects: [{ ...archived.projects[0], archivedStreamCount: 4 }] }
    const synced = syncArchiveCounts(drifted, 'p', archive)
    expect(synced.projects[0].archivedStreamCount).toBeUndefined()
    expect(synced.projects[0].streams[0].archivedTaskCount).toBe(1)
  })
})

describe('ArchiveStorage', () => {
  let dir: string
  let storage: ArchiveStorage

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-test-'))
    storage = new ArchiveStorage(path.join(dir, 'archive'))
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('reads an empty archive when there is no file, and writes one per project', () => {
    expect(storage.load('p')).toEqual(emptyArchive())
    const entry = archivedTaskEntry(data().projects[0], 'a', 7)!
    const written = storage.update('p', archive => withArchivedTasks(archive, [entry]))
    expect(written.tasks).toHaveLength(1)
    expect(storage.load('p')).toEqual(written)
    expect(fs.readdirSync(path.join(dir, 'archive'))).toEqual(['p.json'])
    expect(storage.load('other')).toEqual(emptyArchive())
  })

  it('removes the file once the archive is empty, and on delete', () => {
    const entry = archivedTaskEntry(data().projects[0], 'a', 7)!
    storage.update('p', archive => withArchivedTasks(archive, [entry]))
    storage.update('p', archive => withoutArchived(archive, { tasks: ['a'] }))
    expect(fs.existsSync(path.join(dir, 'archive', 'p.json'))).toBe(false)
    storage.update('p', archive => withArchivedTasks(archive, [entry]))
    storage.delete('p')
    expect(fs.existsSync(path.join(dir, 'archive', 'p.json'))).toBe(false)
  })

  it('moves an unreadable file aside instead of overwriting it', () => {
    fs.mkdirSync(path.join(dir, 'archive'))
    fs.writeFileSync(path.join(dir, 'archive', 'p.json'), '{ not json')
    expect(storage.load('p')).toEqual(emptyArchive())
    expect(fs.readdirSync(path.join(dir, 'archive')).some(name => name.startsWith('p.json.corrupt-'))).toBe(true)
  })

  it('refuses ids that would leave the directory', () => {
    expect(() => storage.load('../escape')).toThrow()
    expect(() => storage.load('..')).toThrow()
  })

  it('keeps reopened tasks in the data, not in both', () => {
    // A full round trip through file and data in the order the app uses.
    const before = data()
    const entry = archivedTaskEntry(before.projects[0], 'a', 1)!
    storage.update('p', archive => withArchivedTasks(archive, [entry]))
    const archived = archiveTasksInData(before, 'p', ['a'])
    const reopened = reopenTaskInData(archived, 'p', storage.load('p').tasks[0])
    storage.update('p', archive => withoutArchived(archive, { tasks: ['a'] }))
    expect(findTaskInProject(reopened.projects[0], 'a')).toBeDefined()
    expect(projectTasks(reopened.projects[0])).toHaveLength(3)
    expect(storage.load('p')).toEqual(emptyArchive())
  })
})
