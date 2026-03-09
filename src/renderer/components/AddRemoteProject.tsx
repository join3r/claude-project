import React, { useState } from 'react'
import './AddRemoteProject.css'

interface Props {
  onAdd: (name: string, ssh: { host: string; port: number; username: string; keyFile?: string; remoteDir: string }) => void
  onCancel: () => void
}

export default function AddRemoteProject({ onAdd, onCancel }: Props): React.ReactElement {
  const [host, setHost] = useState('')
  const [port, setPort] = useState(22)
  const [username, setUsername] = useState('')
  const [keyFile, setKeyFile] = useState('')
  const [remoteDir, setRemoteDir] = useState('')
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<'success' | 'fail' | null>(null)
  const [error, setError] = useState('')

  const isValid = host.trim() && username.trim() && remoteDir.trim()

  const handleTest = async () => {
    if (!isValid) return
    setTesting(true)
    setTestResult(null)
    setError('')
    try {
      await window.api.sshConnect('__test__', {
        host: host.trim(),
        port,
        username: username.trim(),
        keyFile: keyFile.trim() || undefined,
        remoteDir: remoteDir.trim()
      })
      await window.api.sshDisconnect('__test__', {
        host: host.trim(),
        port,
        username: username.trim(),
        keyFile: keyFile.trim() || undefined,
        remoteDir: remoteDir.trim()
      })
      setTestResult('success')
    } catch (err) {
      setTestResult('fail')
      setError(err instanceof Error ? err.message : 'Connection failed')
    } finally {
      setTesting(false)
    }
  }

  const handleAdd = () => {
    if (!isValid) return
    const name = `${username.trim()}@${host.trim()}:${remoteDir.trim().split('/').pop() || remoteDir.trim()}`
    onAdd(name, {
      host: host.trim(),
      port,
      username: username.trim(),
      keyFile: keyFile.trim() || undefined,
      remoteDir: remoteDir.trim()
    })
  }

  const handlePickKey = async () => {
    const picked = await window.api.pickFile('Select SSH Key')
    if (picked) setKeyFile(picked)
  }

  return (
    <div className="settings-overlay" onClick={onCancel}>
      <div className="settings-panel add-remote-panel" onClick={(e) => e.stopPropagation()}>
        <div className="settings-header">
          <h2>Add Remote Project (SSH)</h2>
          <button className="settings-close" onClick={onCancel}>&times;</button>
        </div>

        <div className="settings-body">
          <div className="settings-group">
            <label className="settings-label">Host</label>
            <input
              className="settings-input"
              value={host}
              onChange={(e) => setHost(e.target.value)}
              placeholder="dev.example.com"
              autoFocus
            />
          </div>

          <div className="settings-group">
            <label className="settings-label">Port</label>
            <input
              className="settings-input"
              type="number"
              min={1}
              max={65535}
              value={port}
              onChange={(e) => setPort(parseInt(e.target.value) || 22)}
            />
          </div>

          <div className="settings-group">
            <label className="settings-label">Username</label>
            <input
              className="settings-input"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="deploy"
            />
          </div>

          <div className="settings-group">
            <label className="settings-label">Key File (optional)</label>
            <div className="add-remote-keyfile">
              <input
                className="settings-input"
                value={keyFile}
                onChange={(e) => setKeyFile(e.target.value)}
                placeholder="~/.ssh/id_ed25519"
              />
              <button className="sidebar-btn" onClick={handlePickKey} title="Browse">...</button>
            </div>
          </div>

          <div className="settings-group">
            <label className="settings-label">Remote Directory</label>
            <input
              className="settings-input"
              value={remoteDir}
              onChange={(e) => setRemoteDir(e.target.value)}
              placeholder="/home/deploy/my-project"
            />
          </div>

          {error && <div className="add-remote-error">{error}</div>}
          {testResult === 'success' && <div className="add-remote-success">Connection successful</div>}

          <div className="add-remote-actions">
            <button
              className="add-remote-btn add-remote-btn-secondary"
              onClick={handleTest}
              disabled={!isValid || testing}
            >
              {testing ? 'Testing...' : 'Test Connection'}
            </button>
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
