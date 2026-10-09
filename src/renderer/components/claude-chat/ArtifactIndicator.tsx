import React, { useRef, useState } from 'react'
import { ExternalLink, PanelsTopLeft } from 'lucide-react'
import type { ChatArtifact } from '../../../shared/claude-chat'
import { menuCls } from '../ui'
import { ActionButton, pillCls, usePillDismiss } from './TaskIndicator'

interface Props {
  artifacts: ChatArtifact[]
  /** Open in a browser tab beside the chat. */
  onOpen: (url: string) => void
  /** Open in the system browser, where the claude.ai login usually lives. */
  onOpenExternal: (url: string) => void
}

/**
 * The pill beside the task pill: the Artifact pages this session published,
 * each one a click away. Hidden until there is one.
 */
export default function ArtifactIndicator({ artifacts, onOpen, onOpenExternal }: Props): React.ReactElement | null {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  usePillDismiss(open, setOpen, rootRef)

  if (artifacts.length === 0) return null
  const label = `${artifacts.length} ${artifacts.length === 1 ? 'artifact' : 'artifacts'}`

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        aria-expanded={open}
        aria-haspopup="true"
        aria-label={`Artifacts: ${label}`}
        title="Pages Claude published in this session"
        onClick={() => setOpen(!open)}
        className={pillCls}
      >
        <PanelsTopLeft size={12} aria-hidden />
        <span className="tabular-nums whitespace-nowrap">{label}</span>
      </button>
      {open && (
        <div role="dialog" aria-label="Artifacts" className={`absolute top-full mt-1 right-0 z-(--z-menu) w-80 max-h-96 overflow-auto ${menuCls}`}>
          <ul className="flex flex-col gap-px m-0 p-0 list-none">
            {artifacts.map((artifact) => (
              <li key={artifact.url} className="flex items-start gap-1 rounded-md hover:bg-sel transition-colors duration-(--motion-fast)">
                <button
                  type="button"
                  title={artifact.url}
                  aria-label={`Open ${artifact.title}`}
                  onClick={() => { setOpen(false); onOpen(artifact.url) }}
                  className="flex-1 min-w-0 flex items-start gap-2 px-2 py-1.5 bg-transparent border-0 text-left cursor-pointer"
                >
                  <PanelsTopLeft size={13} className="shrink-0 mt-0.5 text-text-subtle" aria-hidden />
                  <span className="flex-1 min-w-0 flex flex-col">
                    <span className="truncate text-sm text-text">{artifact.title}</span>
                    {artifact.description && <span className="line-clamp-2 text-xs text-text-muted">{artifact.description}</span>}
                    {artifact.publishes > 1 && (
                      <span className="text-xs text-text-subtle tabular-nums">Published {artifact.publishes} times</span>
                    )}
                  </span>
                </button>
                <span className="shrink-0 pr-1 pt-1">
                  <ActionButton label="Open in browser" onClick={() => { setOpen(false); onOpenExternal(artifact.url) }}>
                    <ExternalLink size={12} />
                  </ActionButton>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
