import React, { useState } from 'react'
import type { Project, TunnelConfig, TunnelState } from '../../shared/types'
import { Modal, SetBlock, Field, LinkBtn, PrimaryButton, HelperText } from './ui'

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
    <Modal
      title="Tunnel"
      width="w-[420px]"
      onClose={onClose}
      footer={
        <>
          {existingTunnel && (
            <LinkBtn danger onClick={() => void handleClear()} disabled={saving}>Clear</LinkBtn>
          )}
          <LinkBtn onClick={onClose} disabled={saving}>Cancel</LinkBtn>
          <PrimaryButton onClick={() => void handleSave()} disabled={!isValid || saving}>
            {saving ? 'Saving…' : 'Save'}
          </PrimaryButton>
        </>
      }
    >
      <SetBlock label="Hostname">
        <Field
          value={host}
          onChange={(e) => {
            setHost(e.target.value)
            setLocalError('')
          }}
          placeholder="localhost"
          autoFocus
        />
      </SetBlock>

      <div className="grid grid-cols-2 gap-3">
        <SetBlock label="Source port">
          <Field
            type="number"
            min={1}
            max={65535}
            value={sourcePort}
            onChange={(e) => handleSourcePortChange(e.target.value)}
            placeholder="3000"
          />
        </SetBlock>
        <SetBlock label="Destination port">
          <Field
            type="number"
            min={1}
            max={65535}
            value={destinationPort}
            onChange={(e) => handleDestinationPortChange(e.target.value)}
            placeholder={sourcePort || '3000'}
          />
        </SetBlock>
      </div>

      <div className="px-2.5 py-2 border border-border rounded-md bg-field text-text-muted text-sm">
        {parsedSourcePort && parsedDestinationPort
          ? `localhost:${parsedSourcePort} -> ${trimmedHost}:${parsedDestinationPort}`
          : 'Local port will forward to the remote target over SSH'}
      </div>

      {errorMessage && <HelperText><span className="text-danger">{errorMessage}</span></HelperText>}
      {tunnelState?.status === 'active' && !errorMessage && (
        <HelperText><span className="text-success">Tunnel active</span></HelperText>
      )}
    </Modal>
  )
}
