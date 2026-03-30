import React from 'react'
import type { EditorLineNumbers, EditorRenderWhitespace, EditorWordWrap } from '../../shared/types'
import { useApp } from '../context/AppContext'
import {
  EDITOR_FONT_SIZE_MAX,
  EDITOR_FONT_SIZE_MIN,
  EDITOR_TAB_SIZE_MAX,
  EDITOR_TAB_SIZE_MIN
} from './monacoOptions'
import './Settings.css'

interface Props {
  onClose: () => void
}

const editorWordWrapOptions: Array<{ value: EditorWordWrap; label: string }> = [
  { value: 'off', label: 'Off' },
  { value: 'on', label: 'On' },
  { value: 'bounded', label: 'Bounded' }
]

const editorLineNumberOptions: Array<{ value: EditorLineNumbers; label: string }> = [
  { value: 'on', label: 'On' },
  { value: 'relative', label: 'Relative' },
  { value: 'interval', label: 'Interval' },
  { value: 'off', label: 'Off' }
]

const editorWhitespaceOptions: Array<{ value: EditorRenderWhitespace; label: string }> = [
  { value: 'selection', label: 'Selection' },
  { value: 'boundary', label: 'Boundary' },
  { value: 'trailing', label: 'Trailing' },
  { value: 'all', label: 'All' },
  { value: 'none', label: 'None' }
]

function parseNumberInput(value: string, fallback: number, min: number, max: number): number {
  const parsed = parseInt(value, 10)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, parsed))
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
          <div className="settings-section">
            <div className="settings-section-title">Appearance</div>

            <div className="settings-group">
              <label className="settings-label">Application Theme</label>
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
          </div>

          <div className="settings-section">
            <div className="settings-section-title">Terminal</div>

            <div className="settings-group">
              <label className="settings-label">Terminal Font Family</label>
              <input
                className="settings-input"
                value={config.fontFamily}
                onChange={(e) => updateConfig({ fontFamily: e.target.value })}
                placeholder="e.g. MesloLGS NF, monospace"
              />
            </div>

            <div className="settings-group">
              <label className="settings-label">Terminal Font Size</label>
              <input
                className="settings-input"
                type="number"
                min={8}
                max={32}
                value={config.fontSize}
                onChange={(e) => updateConfig({ fontSize: parseNumberInput(e.target.value, 14, 8, 32) })}
              />
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
                placeholder="$SHELL (system default)"
              />
            </div>

            <div className="settings-group">
              <label className="settings-label">Terminal</label>
              <div className="settings-checkboxes">
                <label className="settings-checkbox">
                  <input
                    type="checkbox"
                    checked={config.copyOnSelect}
                    onChange={(e) => updateConfig({ copyOnSelect: e.target.checked })}
                  />
                  Copy on select
                </label>
              </div>
            </div>
          </div>

          <div className="settings-section">
            <div className="settings-section-title">Editor &amp; Diff</div>
            <p className="settings-help">These options apply to Monaco-backed file editor and diff tabs.</p>

            <div className="settings-group">
              <label className="settings-label">Editor Font Family</label>
              <input
                className="settings-input"
                value={config.editorFontFamily}
                onChange={(e) => updateConfig({ editorFontFamily: e.target.value })}
                placeholder="e.g. JetBrains Mono, monospace"
              />
            </div>

            <div className="settings-grid">
              <div className="settings-group">
                <label className="settings-label">Editor Font Size</label>
                <input
                  className="settings-input"
                  type="number"
                  min={EDITOR_FONT_SIZE_MIN}
                  max={EDITOR_FONT_SIZE_MAX}
                  value={config.editorFontSize}
                  onChange={(e) => updateConfig({
                    editorFontSize: parseNumberInput(
                      e.target.value,
                      14,
                      EDITOR_FONT_SIZE_MIN,
                      EDITOR_FONT_SIZE_MAX
                    )
                  })}
                />
              </div>

              <div className="settings-group">
                <label className="settings-label">Tab Size</label>
                <input
                  className="settings-input"
                  type="number"
                  min={EDITOR_TAB_SIZE_MIN}
                  max={EDITOR_TAB_SIZE_MAX}
                  value={config.editorTabSize}
                  onChange={(e) => updateConfig({
                    editorTabSize: parseNumberInput(
                      e.target.value,
                      4,
                      EDITOR_TAB_SIZE_MIN,
                      EDITOR_TAB_SIZE_MAX
                    )
                  })}
                />
              </div>
            </div>

            <div className="settings-grid">
              <div className="settings-group">
                <label className="settings-label">Word Wrap</label>
                <select
                  className="settings-input"
                  value={config.editorWordWrap}
                  onChange={(e) => updateConfig({ editorWordWrap: e.target.value as EditorWordWrap })}
                >
                  {editorWordWrapOptions.map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
              </div>

              <div className="settings-group">
                <label className="settings-label">Line Numbers</label>
                <select
                  className="settings-input"
                  value={config.editorLineNumbers}
                  onChange={(e) => updateConfig({ editorLineNumbers: e.target.value as EditorLineNumbers })}
                >
                  {editorLineNumberOptions.map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
              </div>
            </div>

            <div className="settings-grid">
              <div className="settings-group">
                <label className="settings-label">Render Whitespace</label>
                <select
                  className="settings-input"
                  value={config.editorRenderWhitespace}
                  onChange={(e) => updateConfig({ editorRenderWhitespace: e.target.value as EditorRenderWhitespace })}
                >
                  {editorWhitespaceOptions.map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
              </div>

              <div className="settings-group">
                <label className="settings-label">Diff Layout</label>
                <select
                  className="settings-input"
                  value={config.diffRenderSideBySide ? 'side-by-side' : 'inline'}
                  onChange={(e) => updateConfig({ diffRenderSideBySide: e.target.value === 'side-by-side' })}
                >
                  <option value="side-by-side">Side by side</option>
                  <option value="inline">Inline</option>
                </select>
              </div>
            </div>

            <div className="settings-group">
              <div className="settings-checkboxes">
                <label className="settings-checkbox">
                  <input
                    type="checkbox"
                    checked={config.editorMinimap}
                    onChange={(e) => updateConfig({ editorMinimap: e.target.checked })}
                  />
                  Show minimap in editor and diff tabs
                </label>
                <label className="settings-checkbox">
                  <input
                    type="checkbox"
                    checked={config.diffIgnoreTrimWhitespace}
                    onChange={(e) => updateConfig({ diffIgnoreTrimWhitespace: e.target.checked })}
                  />
                  Ignore trim whitespace in diffs
                </label>
              </div>
            </div>
          </div>

          <div className="settings-section">
            <div className="settings-section-title">AI Tools</div>

            <div className="settings-group">
              <div className="settings-checkboxes">
                <label className="settings-checkbox">
                  <input
                    type="checkbox"
                    checked={config.enableClaude}
                    onChange={(e) => updateConfig({ enableClaude: e.target.checked })}
                  />
                  Claude Code
                </label>
                <label className="settings-checkbox">
                  <input
                    type="checkbox"
                    checked={config.enableCodex}
                    onChange={(e) => updateConfig({ enableCodex: e.target.checked })}
                  />
                  Codex
                </label>
                <label className="settings-checkbox">
                  <input
                    type="checkbox"
                    checked={config.enableOpencode}
                    onChange={(e) => updateConfig({ enableOpencode: e.target.checked })}
                  />
                  OpenCode
                </label>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
