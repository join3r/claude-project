import React from 'react'
import { useApp } from '../context/AppContext'
import './Settings.css'

interface Props {
  onClose: () => void
}

export default function Settings({ onClose }: Props): React.ReactElement {
  const { config, updateConfig } = useApp()
  if (!config) return <div />

  return (
    <div className="settings-overlay">
      <div className="settings-panel" onClick={(e) => e.stopPropagation()}>
        <div className="settings-header">
          <h2>Settings</h2>
          <button className="settings-close" onClick={onClose}>&times;</button>
        </div>

        <div className="settings-body">
          <div className="settings-group">
            <label className="settings-label">Font Family</label>
            <input
              className="settings-input"
              value={config.fontFamily}
              onChange={(e) => updateConfig({ fontFamily: e.target.value })}
              placeholder="e.g. MesloLGS NF, monospace"
            />
          </div>

          <div className="settings-group">
            <label className="settings-label">Font Size</label>
            <input
              className="settings-input"
              type="number"
              min={8}
              max={32}
              value={config.fontSize}
              onChange={(e) => updateConfig({ fontSize: parseInt(e.target.value) || 14 })}
            />
          </div>

          <div className="settings-group">
            <label className="settings-label">Theme</label>
            <select
              className="settings-input"
              value={config.theme}
              onChange={(e) => updateConfig({ theme: e.target.value as 'system' | 'dark' | 'light' })}
            >
              <option value="system">System</option>
              <option value="dark">Dark</option>
              <option value="light">Light</option>
            </select>
          </div>

          <div className="settings-group">
            <label className="settings-label">Terminal Theme</label>
            <select
              className="settings-input"
              value={config.terminalTheme}
              onChange={(e) => updateConfig({ terminalTheme: e.target.value as 'system' | 'dark' | 'light' })}
            >
              <option value="system">System</option>
              <option value="dark">Dark</option>
              <option value="light">Light</option>
            </select>
          </div>

          <div className="settings-group">
            <label className="settings-label">Default Shell</label>
            <input
              className="settings-input"
              value={config.defaultShell}
              onChange={(e) => updateConfig({ defaultShell: e.target.value })}
              placeholder="/bin/zsh"
            />
          </div>
        </div>
      </div>
    </div>
  )
}
