import React, { useState } from 'react'
import './AddRemoteProject.css'

interface Props {
  onAdd: (name: string, directory: string) => void
  onCancel: () => void
  initialValues: {
    name: string
    directory: string
  }
}

export default function AddLocalProject({ onAdd, onCancel, initialValues }: Props): React.ReactElement {
  const [name, setName] = useState(initialValues.name)
  const [directory, setDirectory] = useState(initialValues.directory)

  const isValid = name.trim() && directory.trim()

  const handleAdd = () => {
    if (!isValid) return
    onAdd(name.trim(), directory.trim())
  }

  const handlePickDir = async () => {
    const picked = await window.api.pickDirectory()
    if (picked) setDirectory(picked)
  }

  return (
    <div className="settings-overlay">
      <div className="settings-panel add-remote-panel">
        <div className="settings-header">
          <h2>Duplicate Local Project</h2>
          <button className="settings-close" onClick={onCancel}>&times;</button>
        </div>

        <div className="settings-body">
          <div className="settings-group">
            <label className="settings-label">Project Name</label>
            <input
              className="settings-input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="My Project"
              autoFocus
            />
          </div>

          <div className="settings-group">
            <label className="settings-label">Directory</label>
            <div className="add-remote-keyfile">
              <input
                className="settings-input"
                value={directory}
                onChange={(e) => setDirectory(e.target.value)}
                placeholder="/path/to/project"
              />
              <button className="sidebar-btn" onClick={handlePickDir} title="Browse">...</button>
            </div>
          </div>

          <div className="add-remote-actions">
            <button
              className="add-remote-btn add-remote-btn-primary"
              onClick={handleAdd}
              disabled={!isValid}
            >
              Add
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
