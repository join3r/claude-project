import React, { useState } from 'react'
import './AddRemoteProject.css'

interface Props {
  onAdd: (name: string, command: string) => void
  onCancel: () => void
}

export default function AddShellCommandProject({ onAdd, onCancel }: Props): React.ReactElement {
  const [name, setName] = useState('')
  const [command, setCommand] = useState('')

  const isValid = name.trim() && command.trim()

  const handleAdd = () => {
    if (!isValid) return
    onAdd(name.trim(), command.trim())
  }

  return (
    <div className="settings-overlay" onClick={onCancel}>
      <div className="settings-panel add-remote-panel" onClick={(e) => e.stopPropagation()}>
        <div className="settings-header">
          <h2>Add Custom Shell Project</h2>
          <button className="settings-close" onClick={onCancel}>&times;</button>
        </div>

        <div className="settings-body">
          <div className="settings-group">
            <label className="settings-label">Project Name</label>
            <input
              className="settings-input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="My Container"
              autoFocus
            />
          </div>

          <div className="settings-group">
            <label className="settings-label">Shell Command</label>
            <input
              className="settings-input"
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              placeholder="docker exec -it mycontainer /bin/bash"
            />
            <div className="add-remote-help">
              <p>Examples:</p>
              <code>docker exec -it mycontainer /bin/bash</code>
              <code>docker exec -w /app -it mycontainer /bin/sh</code>
              <code>orb shell -m vm-name /bin/bash</code>
              <code>orb shell -m vm-name -- bash -c &quot;cd /app &amp;&amp; exec bash&quot;</code>
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
