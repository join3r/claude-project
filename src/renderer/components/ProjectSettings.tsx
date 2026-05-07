import React, { useState } from 'react'
import { AI_TAB_TYPES, AI_TAB_META } from '../../shared/types'
import type { Project, AiTabType } from '../../shared/types'

interface Props {
  project: Project
  onSave: (payload: { aiToolArgs: Partial<Record<AiTabType, string>>; emoji?: string }) => void
  onClose: () => void
}

export default function ProjectSettings({ project, onSave, onClose }: Props): React.ReactElement {
  const [args, setArgs] = useState<Partial<Record<AiTabType, string>>>(
    project.aiToolArgs ?? {}
  )
  const [emoji, setEmoji] = useState(project.emoji ?? '')

  const handleSave = () => {
    const cleaned: Partial<Record<AiTabType, string>> = {}
    for (const tool of AI_TAB_TYPES) {
      const val = args[tool]?.trim()
      if (val) cleaned[tool] = val
    }
    onSave({ aiToolArgs: cleaned, emoji: emoji.trim() || undefined })
    onClose()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        className="w-[440px] max-w-[90vw] rounded-xl border border-border bg-surface-2 shadow-2xl flex flex-col max-h-[85vh]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-border shrink-0">
          <h2 className="text-[14px] font-semibold text-text m-0">Project Settings</h2>
          <button
            onClick={onClose}
            className="bg-transparent border-0 text-text-muted cursor-pointer text-[18px] leading-none px-1 rounded-sm hover:text-text"
          >
            &times;
          </button>
        </div>

        {/* body */}
        <div className="p-5 flex flex-col gap-4 overflow-y-auto">
          <label className="flex flex-col gap-1">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-text-subtle">Icon</span>
            <input
              value={emoji}
              onChange={(e) => setEmoji(e.target.value.slice(0, 4))}
              placeholder="e.g. 📁"
              className="w-20 h-9 rounded-md bg-surface-2 border border-border px-2.5 text-text"
            />
          </label>

          <div className="flex flex-col gap-1">
            <label className="text-[11px] font-semibold uppercase tracking-wider text-text-subtle">
              AI Tool Arguments
            </label>
            <div className="flex flex-col gap-2 mt-1">
              {AI_TAB_TYPES.map((tool) => (
                <div key={tool} className="flex items-center gap-2.5">
                  <span className="text-[13px] text-text min-w-[90px] shrink-0">{AI_TAB_META[tool].label}</span>
                  <input
                    className="flex-1 h-9 px-3 rounded-md bg-surface-2 border border-border text-text focus:border-border-focus outline-none text-[13px]"
                    value={args[tool] ?? ''}
                    onChange={(e) => setArgs({ ...args, [tool]: e.target.value })}
                    placeholder="e.g. --model sonnet"
                  />
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* footer */}
        <div className="flex items-center justify-end px-5 py-3 border-t border-border shrink-0">
          <button
            onClick={handleSave}
            className="h-8 px-4 rounded-md bg-accent-500 hover:bg-accent-600 text-white text-[13px] font-medium border-0 cursor-pointer transition-colors"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  )
}
