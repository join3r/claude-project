import React, { useState } from 'react'
import { ChevronDown, CodeXml } from 'lucide-react'
import type { ExternalEditor } from '../../shared/types'
import { resolveDefaultExternalEditor } from '../../shared/external-editors'
import { openWorkspaceInIde } from '../openWorkspaceInIde'

const btnCls =
  'bg-transparent border-0 cursor-pointer h-6 rounded-md leading-none inline-flex items-center justify-center hover:bg-surface-3 [-webkit-app-region:no-drag] transition-colors duration-(--motion-fast) text-text-muted hover:text-text disabled:opacity-50 disabled:cursor-default disabled:hover:bg-transparent'

interface Props {
  editors: ExternalEditor[]
  defaultId: string | null
  folder: string | null
  onError: (message: string | null) => void
}

export default function OpenInIdeButton({ editors, defaultId, folder, onError }: Props): React.ReactElement {
  const [menuOpen, setMenuOpen] = useState(false)
  const defaultEditor = resolveDefaultExternalEditor({ editors, defaultId })
  const empty = editors.length === 0
  const noFolder = !folder
  const disabled = empty || noFolder
  const tooltip = empty
    ? 'Add an editor in Settings → Editor & Diff → External IDEs'
    : noFolder
      ? 'No local folder to open'
      : `Open in ${defaultEditor?.name || 'editor'}`

  const launch = (editorId: string): void => {
    setMenuOpen(false)
    if (!folder) return
    void openWorkspaceInIde(editorId, folder).then((message) => onError(message))
  }

  return (
    <div className="relative inline-flex items-center shrink-0">
      <button
        type="button"
        className={`${btnCls} w-[28px] h-[26px]`}
        disabled={disabled || !defaultEditor}
        title={tooltip}
        aria-label={tooltip}
        onClick={() => {
          if (defaultEditor) launch(defaultEditor.id)
        }}
      >
        <CodeXml size={15} />
      </button>
      {editors.length > 1 && (
        <button
          type="button"
          className={`${btnCls} w-4`}
          disabled={disabled}
          title="Open in another editor"
          onClick={() => setMenuOpen((open) => !open)}
        >
          <ChevronDown size={12} />
        </button>
      )}
      {menuOpen && (
        <>
          <div className="fixed inset-0 z-(--z-menu)" onClick={() => setMenuOpen(false)} />
          <div className="absolute right-0 top-full mt-1 z-(--z-menu) min-w-[160px] bg-surface border-[0.5px] border-border rounded-lg p-1 shadow-pop">
            {editors.map((editor) => (
              <button
                key={editor.id}
                type="button"
                className="block w-full rounded-md px-2.5 py-1 bg-transparent border-0 text-text text-sm text-left cursor-pointer hover:bg-sel"
                onClick={() => launch(editor.id)}
              >
                Open in {editor.name || 'editor'}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
