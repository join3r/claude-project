import React, { useState } from 'react'

interface Props {
  onAdd: (name: string, command: string) => void
  onCancel: () => void
  initialValues?: {
    name: string
    command: string
  }
}

export default function AddShellCommandProject({ onAdd, onCancel, initialValues }: Props): React.ReactElement {
  const [name, setName] = useState(initialValues?.name ?? '')
  const [command, setCommand] = useState(initialValues?.command ?? '')

  const isValid = name.trim() && command.trim()

  const handleAdd = () => {
    if (!isValid) return
    onAdd(name.trim(), command.trim())
  }

  return (
    <div className="settings-overlay">
      <div className="settings-panel add-remote-panel">
        <div className="settings-header">
          <h2>{initialValues ? 'Duplicate' : 'Add'} Custom Shell Project</h2>
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
              <code>orb shell -m vm-name bash -c &quot;cd dir &amp;&amp; bash&quot;</code>
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
