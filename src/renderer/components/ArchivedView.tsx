import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Archive, RotateCcw } from 'lucide-react'
import { useApp } from '../context/AppContext'
import { isAgentTabType, type Project, type Tab, type Task } from '../../shared/types'
import { visibleArchive, type ArchivedTask } from '../../shared/archive'
import { emptyChatState, reduceChat } from '../../shared/claude-chat'
import { taskTabs } from '../../shared/streams'
import { useProjectArchive } from '../hooks/archiveStore'
import { closeArchivedView, type ArchivedViewTarget } from './archivedViewTarget'
import Timeline from './claude-chat/Timeline'
import { GrpHead, FormGroup, PrimaryButton } from './ui'

const TAB_LABEL: Record<Tab['type'], string> = {
  terminal: 'Terminal', browser: 'Browser', claude: 'Claude Code', 'claude-chat': 'Claude', codex: 'Codex', pi: 'Pi',
  diff: 'Diff', editor: 'Editor', notebook: 'Notebook', note: 'Note'
}

// CSI / OSC / other escape sequences, for showing a terminal's saved scrollback as text.
const ANSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]|\r/g

export function scrollbackText(raw: string): string {
  return raw.replace(ANSI_RE, '').replace(/\n{3,}/g, '\n\n').trimEnd()
}

function tabCount(task: Task): string {
  const count = taskTabs(task).length
  return count === 1 ? '1 tab' : `${count} tabs`
}

function formatDate(at: number): string {
  return at ? new Date(at).toLocaleString() : 'unknown'
}

/** The tab whose history the view shows: a Claude session, else the main terminal (or agent) tab. */
function transcriptTab(task: Task): Tab | undefined {
  const tabs = taskTabs(task)
  return tabs.find(tab => (tab.type === 'claude-chat' || tab.type === 'claude') && tab.sessionId)
    ?? tabs.find(tab => tab.id === task.mainTabId)
    ?? tabs.find(tab => tab.type === 'terminal')
}

/** A Claude transcript, or a terminal's saved scrollback, read-only. */
function TaskHistory({ project, task, dir }: { project: Project; task: Task; dir: string }): React.ReactElement {
  const tab = transcriptTab(task)
  const tabId = tab?.id
  const tabType = tab?.type
  const sessionId = tab?.sessionId
  // Read when the history loads; a project edit must not load it again.
  const projectRef = useRef(project)
  projectRef.current = project
  const [state, setState] = useState<{ kind: 'loading' } | { kind: 'chat'; messages: unknown[] } | { kind: 'text'; text: string } | { kind: 'none' }>({ kind: 'loading' })

  useEffect(() => {
    let cancelled = false
    setState({ kind: 'loading' })
    const done = (next: typeof state) => { if (!cancelled) setState(next) }
    const scrollback = () => {
      if (!tabId) return done({ kind: 'none' })
      window.api.scrollbackLoad(tabId)
        .then(raw => done(raw && scrollbackText(raw) ? { kind: 'text', text: scrollbackText(raw) } : { kind: 'none' }))
        .catch(() => done({ kind: 'none' }))
    }
    const { id: projectId, ssh } = projectRef.current
    if ((tabType === 'claude' || tabType === 'claude-chat') && sessionId) {
      window.api.archiveTranscript(sessionId, dir, projectId, ssh)
        .then(messages => (messages.length > 0 ? done({ kind: 'chat', messages }) : scrollback()))
        .catch(scrollback)
    } else {
      scrollback()
    }
    return () => { cancelled = true }
  }, [tabId, tabType, sessionId, dir])

  const items = useMemo(
    () => (state.kind === 'chat' ? reduceChat(emptyChatState(), { t: 'history', messages: state.messages }).items : []),
    [state]
  )

  if (state.kind === 'loading') return <div className="text-base text-text-subtle">Loading…</div>
  if (state.kind === 'none') return <div className="text-base text-text-subtle">No transcript was kept for this task.</div>
  if (state.kind === 'text') {
    return (
      <pre className="text-xs font-mono text-text bg-surface-2 border-[0.5px] border-border rounded-md p-3 whitespace-pre-wrap break-words max-h-[60vh] overflow-y-auto">
        {state.text}
      </pre>
    )
  }
  return (
    <Timeline
      items={items}
      busy={false}
      compacting={false}
      waiting={false}
      onOpenLink={(url) => { void window.api.openExternal(url) }}
    />
  )
}

function TabList({ task }: { task: Task }): React.ReactElement {
  return (
    <FormGroup>
      {taskTabs(task).length === 0 && <div className="text-base text-text-subtle">No tabs.</div>}
      {taskTabs(task).map(tab => (
        <div key={tab.id} className="flex items-baseline gap-2 text-base text-text">
          <span>{tab.title || TAB_LABEL[tab.type]}</span>
          <span className="text-xs text-text-subtle">
            {TAB_LABEL[tab.type]}
            {tab.id === task.mainTabId ? (isAgentTabType(tab.type) ? ' · the task\'s agent' : ' · main') : ''}
            {tab.sessionId ? ` · session ${tab.sessionId.slice(0, 8)}` : ''}
            {tab.url ? ` · ${tab.url}` : ''}
            {tab.filePath ? ` · ${tab.filePath}` : ''}
            {tab.cwd ? ` · ${tab.cwd}` : ''}
          </span>
        </div>
      ))}
    </FormGroup>
  )
}

function Header({ title, subtitle, onReopen, busy }: { title: string; subtitle: string; onReopen: () => void; busy: boolean }): React.ReactElement {
  return (
    <div className="flex items-start gap-3">
      <Archive size={18} className="mt-1 text-text-subtle shrink-0" />
      <div className="flex-1 min-w-0">
        <div className="text-lg text-text font-medium truncate">{title}</div>
        <div className="text-sm text-text-subtle">{subtitle}</div>
      </div>
      <PrimaryButton onClick={onReopen} disabled={busy}>
        <RotateCcw size={14} className="mr-1.5" />Reopen
      </PrimaryButton>
    </div>
  )
}

/**
 * An archived task or stream, read-only: its transcript where one was kept
 * (a Claude session's history, else a terminal's saved scrollback), its tabs,
 * and Reopen. Shown in place of the project's Home page.
 */
export function ArchivedView({ target }: { target: ArchivedViewTarget }): React.ReactElement | null {
  const { projects, reopenTask, reopenStream } = useApp()
  const project = projects.find(candidate => candidate.id === target.projectId)
  const raw = useProjectArchive(target.projectId, true)
  const archive = raw && project ? visibleArchive(raw, project) : null
  const [busy, setBusy] = useState(false)
  const [shownTaskId, setShownTaskId] = useState<string | null>(null)

  if (!project) return null
  if (!archive) return <div className="flex-1 flex items-center justify-center text-text-muted text-md">Loading…</div>

  const reopenFailed = (err: unknown) => window.alert(`Couldn't reopen: ${err instanceof Error ? err.message : String(err)}`)

  if (target.kind === 'task') {
    const entry = archive.tasks.find(candidate => candidate.task.id === target.id)
    if (!entry) return <Gone />
    const onReopen = () => {
      setBusy(true)
      reopenTask(project.id, entry.task.id).catch(reopenFailed).finally(() => setBusy(false))
    }
    return (
      <Page testId="archived-view">
        <Header
          title={entry.task.name}
          subtitle={`Archived ${formatDate(entry.archivedAt)} from ${entry.streamName || 'its stream'} · reopens ${project.streams.some(s => s.id === entry.streamId) ? `in ${entry.streamName}` : 'in main (its stream is closed)'}`}
          onReopen={onReopen}
          busy={busy}
        />
        <GrpHead>Tabs</GrpHead>
        <TabList task={entry.task} />
        <GrpHead>Transcript</GrpHead>
        <TaskHistory project={project} task={entry.task} dir={entry.dir} />
      </Page>
    )
  }

  const entry = archive.streams.find(candidate => candidate.stream.id === target.id)
  if (!entry) return <Gone />
  const tasks: { task: Task; done?: ArchivedTask }[] = [
    ...entry.stream.tasks.map(task => ({ task })),
    ...entry.doneTasks.map(done => ({ task: done.task, done }))
  ]
  const shown = tasks.find(item => item.task.id === shownTaskId) ?? tasks[0]
  const onReopen = () => {
    setBusy(true)
    reopenStream(project.id, entry.stream.id)
      .then(({ notice }) => { if (notice) window.alert(notice) })
      .catch(reopenFailed)
      .finally(() => setBusy(false))
  }
  const workspace = entry.stream.workspace
  return (
    <Page testId="archived-view">
      <Header
        title={entry.stream.name}
        subtitle={`Stream archived ${formatDate(entry.archivedAt)}${workspace ? ` · branch ${workspace.branchName} (Reopen checks it out again)` : ' · project folder'}`}
        onReopen={onReopen}
        busy={busy}
      />
      <GrpHead>Tasks</GrpHead>
      <FormGroup>
        {tasks.length === 0 && <div className="text-base text-text-subtle">No tasks.</div>}
        {tasks.map(({ task, done }) => (
          <button
            key={task.id}
            type="button"
            className={`flex items-baseline gap-2 text-left bg-transparent border-0 cursor-pointer p-0 text-base ${shown?.task.id === task.id ? 'text-accent' : 'text-text hover:text-accent'}`}
            onClick={() => setShownTaskId(task.id)}
          >
            <span>{task.name}</span>
            <span className="text-xs text-text-subtle">{done ? 'in its Done · ' : ''}{tabCount(task)}</span>
          </button>
        ))}
      </FormGroup>
      {shown && (
        <>
          <GrpHead>{shown.task.name}</GrpHead>
          <TabList task={shown.task} />
          <TaskHistory project={project} task={shown.task} dir={shown.done?.dir ?? entry.dir} />
        </>
      )}
    </Page>
  )
}

function Page({ children, testId }: { children: React.ReactNode; testId: string }): React.ReactElement {
  return (
    <div className="flex-1 min-h-0 flex flex-col overflow-y-auto bg-bg text-text" data-testid={testId}>
      <div className="px-4 py-3 max-w-[860px] w-full mx-auto flex flex-col gap-2">{children}</div>
    </div>
  )
}

function Gone(): React.ReactElement {
  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-2 text-text-muted text-md">
      <span>This item is no longer archived.</span>
      <button type="button" className="bg-transparent border-0 text-accent cursor-pointer" onClick={closeArchivedView}>Close</button>
    </div>
  )
}
