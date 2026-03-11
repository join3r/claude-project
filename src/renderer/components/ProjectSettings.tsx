import React, { useState } from 'react'
import { AI_TAB_TYPES, AI_TAB_META } from '../../shared/types'
import type { Project, AiTabType } from '../../shared/types'

interface Props {
  project: Project
  onSave: (aiToolArgs: Partial<Record<AiTabType, string>>) => void
  onClose: () => void
}

export default function ProjectSettings({ project, onSave, onClose }: Props): React.ReactElement {
  const [args, setArgs] = useState<Partial<Record<AiTabType, string>>>(
    project.aiToolArgs ?? {}
  )

  const handleSave = () => {
    const cleaned: Partial<Record<AiTabType, string>> = {}
    for (const tool of AI_TAB_TYPES) {
      const val = args[tool]?.trim()
      if (val) cleaned[tool] = val
    }
    onSave(cleaned)
    onClose()
  }

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div className="settings-panel add-remote-panel" onClick={(e) => e.stopPropagation()}>
        <div className="settings-header">
          <h2>Project Settings</h2>
          <button className="settings-close" onClick={onClose}>&times;</button>
        </div>

        <div className="settings-body">
          <div className="settings-group">
            <label className="settings-label">AI Tool Arguments</label>
            {AI_TAB_TYPES.map((tool) => (
              <div key={tool} className="project-settings-tool-row">
                <span className="project-settings-tool-label">{AI_TAB_META[tool].label}</span>
                <input
                  className="settings-input"
                  value={args[tool] ?? ''}
                  onChange={(e) => setArgs({ ...args, [tool]: e.target.value })}
                  placeholder={`e.g. --model sonnet`}
                />
              </div>
            ))}
          </div>

          <div className="add-remote-actions">
            <button className="add-remote-btn add-remote-btn-primary" onClick={handleSave}>
              Save
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
