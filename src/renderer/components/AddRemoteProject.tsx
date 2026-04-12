import React, { useState } from 'react'
import { AI_TAB_TYPES, AI_TAB_META } from '../../shared/types'
import type { AiTabType } from '../../shared/types'
import './AddRemoteProject.css'

interface Props {
  onAdd: (name: string, ssh: { host: string; port: number; username: string; keyFile?: string; remoteDir: string }, aiToolArgs?: Partial<Record<AiTabType, string>>) => void
  onCancel: () => void
  initialValues?: {
    host: string
    port: number
    username: string
    keyFile?: string
    remoteDir: string
    aiToolArgs?: Partial<Record<AiTabType, string>>
  }
}

export default function AddRemoteProject({ onAdd, onCancel, initialValues }: Props): React.ReactElement {
  const [host, setHost] = useState(initialValues?.host ?? '')
  const [port, setPort] = useState(initialValues?.port ?? 22)
  const [username, setUsername] = useState(initialValues?.username ?? '')
  const [keyFile, setKeyFile] = useState(initialValues?.keyFile ?? '')
  const [remoteDir, setRemoteDir] = useState(initialValues?.remoteDir ?? '')
  const [aiArgs, setAiArgs] = useState<Partial<Record<AiTabType, string>>>(initialValues?.aiToolArgs ?? {})
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
    const cleaned: Partial<Record<AiTabType, string>> = {}
    for (const tool of AI_TAB_TYPES) {
      const val = aiArgs[tool]?.trim()
      if (val) cleaned[tool] = val
    }
    onAdd(name, {
      host: host.trim(),
      port,
      username: username.trim(),
      keyFile: keyFile.trim() || undefined,
      remoteDir: remoteDir.trim()
    }, Object.keys(cleaned).length > 0 ? cleaned : undefined)
  }

  const handlePickKey = async () => {
    const picked = await window.api.pickFile('Select SSH Key')
    if (picked) setKeyFile(picked)
  }

  return (
    <div className="settings-overlay">
      <div className="settings-panel add-remote-panel">
        <div className="settings-header">
          <h2>{initialValues ? 'Duplicate' : 'Add'} Remote Project (SSH)</h2>
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

          <div className="settings-group">
            <label className="settings-label">AI Tool Arguments (optional)</label>
            {AI_TAB_TYPES.map((tool) => (
              <div key={tool} className="project-settings-tool-row">
                <span className="project-settings-tool-label">{AI_TAB_META[tool].label}</span>
                <input
                  className="settings-input"
                  value={aiArgs[tool] ?? ''}
                  onChange={(e) => setAiArgs({ ...aiArgs, [tool]: e.target.value })}
                  placeholder={`e.g. --model sonnet`}
                />
              </div>
            ))}
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
