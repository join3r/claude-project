import React, { useEffect } from 'react'
import { Check } from 'lucide-react'
import type { DeskScope, Project } from '../../../shared/types'
import ProjectTileBadge from '../ProjectTileBadge'
import { useMenuPosition, type MenuAnchor } from '../../hooks/useMenuPosition'

const itemCls = 'flex w-full items-center gap-2 px-2.5 py-1.5 rounded-md bg-transparent border-0 text-base text-text cursor-pointer hover:bg-sel text-left'

/**
 * The column's scope menu (decision 8): All projects, then the projects with
 * pinned ones first, each with its non-main streams under it. Picking a project
 * narrows the list and opens its page; the footer adds projects and opens Settings.
 */
export default function DeskScopeMenu({ anchor, projects, pinnedIds, missingDirIds, scope, theme, onPick, footer, onClose }: {
  anchor: MenuAnchor | null
  projects: readonly Project[]
  pinnedIds: ReadonlySet<string>
  missingDirIds: ReadonlySet<string>
  scope: DeskScope | null
  theme: 'dark' | 'light'
  onPick: (scope: DeskScope | null) => void
  /** Adding projects and servers, Settings. */
  footer: ReadonlyArray<{ label: string; onClick: () => void }>
  onClose: () => void
}): React.ReactElement | null {
  const pos = useMenuPosition<HTMLDivElement>(anchor)
  useEffect(() => {
    if (!anchor) return
    const dismiss = (): void => onClose()
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') onClose() }
    window.addEventListener('mousedown', dismiss)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', dismiss)
      window.removeEventListener('keydown', onKey)
    }
  }, [anchor, onClose])
  if (!anchor) return null

  const ordered = [...projects.filter(p => pinnedIds.has(p.id)), ...projects.filter(p => !pinnedIds.has(p.id))]
  const isScope = (projectId: string | null, streamId?: string): boolean =>
    projectId === null ? !scope : scope?.projectId === projectId && scope.streamId === streamId

  return (
    <div
      ref={pos.ref}
      role="menu"
      className="fixed z-(--z-menu) w-[280px] max-h-[70vh] overflow-y-auto bg-surface-3 border border-border-strong rounded-[10px] p-1 shadow-[0_18px_40px_rgba(0,0,0,0.5)]"
      style={pos.style}
      onMouseDown={(e) => e.stopPropagation()}
      data-testid="desk-scope-menu"
    >
      <button type="button" role="menuitem" className={itemCls} onClick={() => onPick(null)}>
        <span className="w-4" />
        <span className="flex-1">All projects</span>
        {isScope(null) && <Check size={13} className="text-text-muted" />}
      </button>
      {ordered.length > 0 && <div className="h-px bg-hair my-1" />}
      {ordered.map(project => (
        <React.Fragment key={project.id}>
          <button type="button" role="menuitem" className={itemCls} onClick={() => onPick({ projectId: project.id })} data-project-id={project.id}>
            <ProjectTileBadge project={project} theme={theme} size={16} />
            <span className="flex-1 overflow-hidden text-ellipsis whitespace-nowrap">{project.name}</span>
            {missingDirIds.has(project.id) && <span className="w-[7px] h-[7px] rounded-full bg-crashed" title={`Folder not found: ${project.directory}`} />}
            {pinnedIds.has(project.id) && <span className="text-2xs text-text-subtle">pinned</span>}
            {isScope(project.id) && <Check size={13} className="text-text-muted" />}
          </button>
          {project.streams.filter(stream => !stream.isMain).map(stream => (
            <button key={stream.id} type="button" role="menuitem" className={`${itemCls} pl-[34px] py-1 text-sm text-text-muted hover:text-text`} onClick={() => onPick({ projectId: project.id, streamId: stream.id })}>
              <span className="flex-1 font-mono overflow-hidden text-ellipsis whitespace-nowrap">› {stream.name}</span>
              {isScope(project.id, stream.id) && <Check size={13} />}
            </button>
          ))}
        </React.Fragment>
      ))}
      <div className="h-px bg-hair my-1" />
      {footer.map(item => (
        <button key={item.label} type="button" role="menuitem" className={`${itemCls} text-sm`} onClick={() => { onClose(); item.onClick() }}>{item.label}</button>
      ))}
    </div>
  )
}
