import React, { useState } from 'react'
import { X } from 'lucide-react'
import type { Project, TunnelConfig, TunnelState } from '../../shared/types'

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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div className="w-[420px] max-w-[90vw] rounded-xl border border-border bg-surface-2 shadow-2xl flex flex-col max-h-[85vh]" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <h2 className="text-[14px] font-semibold">Tunnel</h2>
          <button
            className="inline-flex items-center justify-center w-7 h-7 rounded-md text-text-muted hover:bg-surface-3 hover:text-text border-0 bg-transparent cursor-pointer"
            onClick={onClose}
          >
            <X size={16} />
          </button>
        </div>

        <div className="p-5 flex flex-col gap-4 overflow-y-auto">
          <div>
            <label className="block text-[12px] font-medium text-text-muted mb-1.5">Hostname</label>
            <input
              className="w-full h-9 bg-surface text-text border border-border rounded-md px-3 text-[13px] outline-none focus:border-border-focus placeholder:text-text-muted"
              value={host}
              onChange={(e) => {
                setHost(e.target.value)
                setLocalError('')
              }}
              placeholder="localhost"
              autoFocus
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-[12px] font-medium text-text-muted mb-1.5">Source Port</label>
              <input
                className="w-full h-9 bg-surface text-text border border-border rounded-md px-3 text-[13px] outline-none focus:border-border-focus placeholder:text-text-muted"
                type="number"
                min={1}
                max={65535}
                value={sourcePort}
                onChange={(e) => handleSourcePortChange(e.target.value)}
                placeholder="3000"
              />
            </div>

            <div>
              <label className="block text-[12px] font-medium text-text-muted mb-1.5">Destination Port</label>
              <input
                className="w-full h-9 bg-surface text-text border border-border rounded-md px-3 text-[13px] outline-none focus:border-border-focus placeholder:text-text-muted"
                type="number"
                min={1}
                max={65535}
                value={destinationPort}
                onChange={(e) => handleDestinationPortChange(e.target.value)}
                placeholder={sourcePort || '3000'}
              />
            </div>
          </div>

          <div className="mt-2 px-3 py-2.5 border border-border rounded-md bg-surface text-text-muted text-[12px]">
            {parsedSourcePort && parsedDestinationPort
              ? `localhost:${parsedSourcePort} -> ${trimmedHost}:${parsedDestinationPort}`
              : 'Local port will forward to the remote target over SSH'}
          </div>

          {errorMessage && <div className="text-[12px] text-red-400">{errorMessage}</div>}
          {tunnelState?.status === 'active' && !errorMessage && (
            <div className="text-[12px] text-emerald-400">Tunnel active</div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 px-5 py-4 border-t border-border">
          {existingTunnel && (
            <button
              className="inline-flex items-center justify-center h-9 px-4 rounded-md bg-surface-3 text-text hover:bg-surface-2 border border-border cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
              onClick={() => void handleClear()}
              disabled={saving}
            >
              Clear
            </button>
          )}
          <button
            className="inline-flex items-center justify-center h-9 px-4 rounded-md bg-surface-3 text-text hover:bg-surface-2 border border-border cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
            onClick={onClose}
            disabled={saving}
          >
            Cancel
          </button>
          <button
            className="inline-flex items-center justify-center h-9 px-4 rounded-md bg-accent-500 text-accent-50 hover:bg-accent-400 border-0 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
            onClick={() => void handleSave()}
            disabled={!isValid || saving}
          >
            {saving ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}
