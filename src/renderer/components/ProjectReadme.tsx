import React, { useEffect, useState } from 'react'
import { useApp } from '../context/AppContext'
import { isRemoteProject, isShellCommandProject } from '../../shared/types'
import type { Project } from '../../shared/types'
import MarkdownPreview from './MarkdownPreview'

type LoadState =
  | { kind: 'loading' }
  | { kind: 'ready'; content: string }
  | { kind: 'missing' }
  | { kind: 'truncated'; content: string }
  | { kind: 'ssh-disconnected' }
  | { kind: 'error'; message: string }

const SIZE_CAP = 200_000

interface Props { project: Project }

export function ProjectReadme({ project }: Props): React.ReactElement {
  const actions = useApp()
  const [state, setState] = useState<LoadState>({ kind: 'loading' })

  useEffect(() => {
    let cancelled = false
    setState({ kind: 'loading' })
    const api = (window as any).api
    api.readProjectReadme(project.id)
      .then((content: string | null) => {
        if (cancelled) return
        if (content === null) { setState({ kind: 'missing' }); return }
        if (content.length > SIZE_CAP) {
          setState({ kind: 'truncated', content: content.slice(0, SIZE_CAP) })
        } else {
          setState({ kind: 'ready', content })
        }
      })
      .catch((err: any) => {
        if (cancelled) return
        if (err?.message?.includes('ssh-not-connected') || err?.code === 'SSH_NOT_CONNECTED') {
          setState({ kind: 'ssh-disconnected' })
        } else {
          setState({ kind: 'error', message: String(err?.message ?? err) })
        }
      })
    return () => { cancelled = true }
  }, [project.id])

  const openInEditor = () => {
    if (!project.directory) return
    const taskId = project.tasks[0]?.id
    if (!taskId) return
    actions.openOrFocusEditorTab(project.id, taskId, 'left', `${project.directory}/README.md`)
  }

  const retry = () => {
    setState({ kind: 'loading' })
    const api = (window as any).api
    api.readProjectReadme(project.id)
      .then((content: string | null) => {
        if (content === null) setState({ kind: 'missing' })
        else if (content.length > SIZE_CAP) setState({ kind: 'truncated', content: content.slice(0, SIZE_CAP) })
        else setState({ kind: 'ready', content })
      })
      .catch(() => { /* no-op; user can retry again */ })
  }

  return (
    <section className="px-4 py-3">
      <header className="flex items-center justify-between mb-2">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-text-subtle">README</h2>
        {(state.kind === 'ready' || state.kind === 'truncated') && project.directory && (
          <button
            type="button"
            onClick={openInEditor}
            className="text-xs text-text-subtle hover:text-text bg-transparent border-0 cursor-pointer"
          >
            Edit
          </button>
        )}
      </header>

      {state.kind === 'loading' && <div className="text-sm text-text-subtle">Loading…</div>}

      {state.kind === 'ready' && <MarkdownPreview content={state.content} effectiveTheme={actions.effectiveTheme} />}

      {state.kind === 'truncated' && (
        <>
          <div className="mb-2 px-3 py-2 bg-surface-2 rounded text-xs text-text-subtle">
            README is large — showing first 200KB.{' '}
            <button type="button" onClick={openInEditor} className="underline bg-transparent border-0 cursor-pointer text-text-subtle hover:text-text">Open in editor</button>
          </div>
          <MarkdownPreview content={state.content} effectiveTheme={actions.effectiveTheme} />
        </>
      )}

      {state.kind === 'missing' && (() => {
        const isLocal = !isRemoteProject(project) && !isShellCommandProject(project)
        if (isLocal) {
          return (
            <div className="text-sm text-text-subtle">
              No README found.{' '}
              <button type="button" onClick={openInEditor} className="underline bg-transparent border-0 cursor-pointer text-text-subtle hover:text-text">
                Create README
              </button>
            </div>
          )
        }
        if (isShellCommandProject(project)) {
          return <div className="text-sm text-text-subtle">No README available for this project type.</div>
        }
        return <div className="text-sm text-text-subtle">No README at remote root.</div>
      })()}

      {state.kind === 'ssh-disconnected' && (
        <div className="text-sm text-text-subtle">
          Could not read README — SSH not connected.{' '}
          <button type="button" onClick={retry} className="underline bg-transparent border-0 cursor-pointer text-text-subtle hover:text-text">Retry</button>
        </div>
      )}

      {state.kind === 'error' && (
        <div className="text-sm text-text-subtle">
          Could not read README. <span className="text-text-muted text-xs">{state.message}</span>
        </div>
      )}
    </section>
  )
}
