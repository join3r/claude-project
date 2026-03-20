import React, { useState } from 'react'
import type { Project, TunnelConfig, TunnelState } from '../../shared/types'
import './Settings.css'
import './AddRemoteProject.css'
import './TunnelPopup.css'

interface Props {
  project: Project
  tunnelState?: TunnelState
  onSave: (tunnel: TunnelConfig) => Promise<void>
  onClear: () => Promise<void>
  onClose: () => void
}

function parsePort(value: string): number | null {
  if (!/^\d+$/.test(value.trim())) return null
  const parsed = Number.parseInt(value, 10)
  return parsed >= 1 && parsed <= 65535 ? parsed : null
}

export default function TunnelPopup({ project, tunnelState, onSave, onClear, onClose }: Props): React.ReactElement {
  const existingTunnel = project.tunnel
  const [host, setHost] = useState(existingTunnel?.host ?? 'localhost')
  const [sourcePort, setSourcePort] = useState(existingTunnel ? String(existingTunnel.sourcePort) : '')
  const [destinationPort, setDestinationPort] = useState(existingTunnel ? String(existingTunnel.destinationPort) : '')
  const [destinationDirty, setDestinationDirty] = useState(
    !!existingTunnel && existingTunnel.destinationPort !== existingTunnel.sourcePort
  )
  const [saving, setSaving] = useState(false)
  const [localError, setLocalError] = useState('')

  const trimmedHost = host.trim() || 'localhost'
  const parsedSourcePort = parsePort(sourcePort)
  const parsedDestinationPort = parsePort(destinationPort)
  const isValid = !!parsedSourcePort && !!parsedDestinationPort
  const errorMessage = localError || tunnelState?.error || ''

  const handleSourcePortChange = (value: string) => {
    setSourcePort(value)
    setLocalError('')
    if (!destinationDirty) {
      setDestinationPort(value)
    }
  }

  const handleDestinationPortChange = (value: string) => {
    setDestinationPort(value)
    setDestinationDirty(true)
    setLocalError('')
  }

  const handleSave = async () => {
    if (!parsedSourcePort || !parsedDestinationPort) {
      setLocalError('Ports must be between 1 and 65535')
      return
    }

    setSaving(true)
    setLocalError('')
    try {
      await onSave({
        host: trimmedHost,
        sourcePort: parsedSourcePort,
        destinationPort: parsedDestinationPort
      })
      onClose()
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : 'Failed to save tunnel')
    } finally {
      setSaving(false)
    }
  }

  const handleClear = async () => {
    setSaving(true)
    setLocalError('')
    try {
      await onClear()
      onClose()
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : 'Failed to clear tunnel')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div className="settings-panel add-remote-panel tunnel-popup-panel" onClick={(e) => e.stopPropagation()}>
        <div className="settings-header">
          <h2>Tunnel</h2>
          <button className="settings-close" onClick={onClose}>&times;</button>
        </div>

        <div className="settings-body">
          <div className="settings-group">
            <label className="settings-label">Hostname</label>
            <input
              className="settings-input"
              value={host}
              onChange={(e) => {
                setHost(e.target.value)
                setLocalError('')
              }}
              placeholder="localhost"
              autoFocus
            />
          </div>

          <div className="tunnel-popup-ports">
            <div className="settings-group">
              <label className="settings-label">Source Port</label>
              <input
                className="settings-input"
                type="number"
                min={1}
                max={65535}
                value={sourcePort}
                onChange={(e) => handleSourcePortChange(e.target.value)}
                placeholder="3000"
              />
            </div>

            <div className="settings-group">
              <label className="settings-label">Destination Port</label>
              <input
                className="settings-input"
                type="number"
                min={1}
                max={65535}
                value={destinationPort}
                onChange={(e) => handleDestinationPortChange(e.target.value)}
                placeholder={sourcePort || '3000'}
              />
            </div>
          </div>

          <div className="tunnel-popup-preview">
            {parsedSourcePort && parsedDestinationPort
              ? `localhost:${parsedSourcePort} -> ${trimmedHost}:${parsedDestinationPort}`
              : 'Local port will forward to the remote target over SSH'}
          </div>

          {errorMessage && <div className="add-remote-error">{errorMessage}</div>}
          {tunnelState?.status === 'active' && !errorMessage && (
            <div className="add-remote-success">Tunnel active</div>
          )}

          <div className="add-remote-actions">
            {existingTunnel && (
              <button
                className="add-remote-btn add-remote-btn-secondary"
                onClick={() => void handleClear()}
                disabled={saving}
              >
                Clear
              </button>
            )}
            <button
              className="add-remote-btn add-remote-btn-secondary"
              onClick={onClose}
              disabled={saving}
            >
              Cancel
            </button>
            <button
              className="add-remote-btn add-remote-btn-primary"
              onClick={() => void handleSave()}
              disabled={!isValid || saving}
            >
              {saving ? 'Saving...' : 'Save'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
