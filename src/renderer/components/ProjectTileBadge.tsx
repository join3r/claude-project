import React, { useEffect, useState } from 'react'
import type { Project } from '../../shared/types'
import { projectSwatch, projectTile } from '../../shared/project-label'
import { dashboardIconUrl, fetchDashboardIconsMetadata, type DashboardIconsMetadata } from './dashboardIcons'

/**
 * A project's tile at header size: its dashboard icon when one is set (the
 * desktop's own choice wins here), else its emoji, else its initials, on the
 * project's colour. The sidebar draws the small version (`ProjectIconSlot`).
 */
export default function ProjectTileBadge({ project, theme, size = 28 }: {
  project: Project
  theme: 'dark' | 'light'
  size?: number
}): React.ReactElement {
  const [metadata, setMetadata] = useState<DashboardIconsMetadata | null>(null)
  const [iconFailed, setIconFailed] = useState(false)

  useEffect(() => {
    if (!project.icon) return
    let cancelled = false
    fetchDashboardIconsMetadata()
      .then((m) => { if (!cancelled) setMetadata(m) })
      .catch(() => { /* CDN unreachable: the slug is used as given */ })
    return () => { cancelled = true }
  }, [project.icon])

  useEffect(() => { setIconFailed(false) }, [project.icon])

  const tile = projectTile(project)
  const swatch = projectSwatch(tile, theme)
  const iconUrl = project.icon && !iconFailed
    ? dashboardIconUrl(project.icon, { theme, metadata: metadata ?? undefined })
    : null

  return (
    <span
      aria-hidden
      className="shrink-0 rounded-md flex items-center justify-center font-semibold leading-none select-none"
      style={{
        width: size,
        height: size,
        backgroundColor: swatch.bg,
        color: swatch.fg,
        fontSize: tile.emoji && !iconUrl ? Math.round(size * 0.55) : Math.round(size * 0.38)
      }}
    >
      {iconUrl ? (
        <img
          src={iconUrl}
          alt=""
          style={{ width: Math.round(size * 0.62), height: Math.round(size * 0.62) }}
          className="object-contain"
          onError={() => setIconFailed(true)}
        />
      ) : tile.emoji ?? tile.text}
    </span>
  )
}
