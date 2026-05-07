import React, { useState } from 'react'
import type { EditorLineNumbers, EditorRenderWhitespace, EditorWordWrap, TerminalColorScheme } from '../../shared/types'
import { useApp } from '../context/AppContext'
import { TERMINAL_SCHEME_OPTIONS } from './terminalThemes'
import {
  EDITOR_FONT_SIZE_MAX,
  EDITOR_FONT_SIZE_MIN,
  EDITOR_TAB_SIZE_MAX,
  EDITOR_TAB_SIZE_MIN
} from './monacoOptions'

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

type SettingsTab = 'appearance' | 'terminal' | 'editor' | 'ai' | 'sidebar'

const tabs: Array<{ id: SettingsTab; label: string }> = [
  { id: 'appearance', label: 'Appearance' },
  { id: 'terminal', label: 'Terminal' },
  { id: 'editor', label: 'Editor & Diff' },
  { id: 'ai', label: 'AI Tools' },
  { id: 'sidebar', label: 'Sidebar' }
]

const inputCls = 'w-full h-9 px-3 rounded-md bg-surface-2 border border-border text-text focus:border-border-focus outline-none text-[13px]'
const labelCls = 'text-[11px] font-semibold uppercase tracking-wider text-text-subtle'

export default function Settings({ onClose }: Props): React.ReactElement {
  const { config, updateConfig } = useApp()
  const [activeTab, setActiveTab] = useState<SettingsTab>('appearance')

  if (!config) return <div />

  const renderTabContent = () => {
    switch (activeTab) {
      case 'appearance':
        return (
          <div className="flex flex-col gap-1">
            <label className={labelCls}>Application Theme</label>
            <select
              className={inputCls}
              value={config.theme}
              onChange={(e) => updateConfig({ theme: e.target.value as 'system' | 'dark' | 'light' })}
            >
              <option value="system">System</option>
              <option value="dark">Dark</option>
              <option value="light">Light</option>
            </select>
          </div>
        )

      case 'terminal':
        return (
          <>
            <div className="flex flex-col gap-1">
              <label className={labelCls}>Terminal Font Family</label>
              <input
                className={inputCls}
                value={config.fontFamily}
                onChange={(e) => updateConfig({ fontFamily: e.target.value })}
                placeholder="e.g. MesloLGS NF, monospace"
              />
            </div>

            <div className="flex flex-col gap-1">
              <label className={labelCls}>Terminal Font Size</label>
              <input
                className={inputCls}
                type="number"
                min={8}
                max={32}
                value={config.fontSize}
                onChange={(e) => updateConfig({ fontSize: parseNumberInput(e.target.value, 14, 8, 32) })}
              />
            </div>

            <div className="flex flex-col gap-1">
              <label className={labelCls}>Terminal Theme</label>
              <select
                className={inputCls}
                value={config.terminalTheme}
                onChange={(e) => updateConfig({ terminalTheme: e.target.value as 'system' | 'dark' | 'light' })}
              >
                <option value="system">System</option>
                <option value="dark">Dark</option>
                <option value="light">Light</option>
              </select>
            </div>

            <div className="flex flex-col gap-1">
              <label className={labelCls}>Terminal Color Scheme</label>
              <select
                className={inputCls}
                value={config.terminalColorScheme}
                onChange={(e) => updateConfig({ terminalColorScheme: e.target.value as TerminalColorScheme })}
              >
                {TERMINAL_SCHEME_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
              <p className="text-[12px] text-text-muted leading-snug mt-1">
                {TERMINAL_SCHEME_OPTIONS.find(o => o.value === config.terminalColorScheme)?.description}
              </p>
            </div>

            <div className="flex flex-col gap-1">
              <label className={labelCls}>Default Shell</label>
              <input
                className={inputCls}
                value={config.defaultShell}
                onChange={(e) => updateConfig({ defaultShell: e.target.value })}
                placeholder="$SHELL (system default)"
              />
            </div>

            <div className="flex flex-col gap-1">
              <label className={labelCls}>Terminal</label>
              <div className="flex flex-col gap-2">
                <label className="flex items-center gap-2 text-[13px] text-text cursor-pointer">
                  <input
                    type="checkbox"
                    className="cursor-pointer"
                    checked={config.copyOnSelect}
                    onChange={(e) => updateConfig({ copyOnSelect: e.target.checked })}
                  />
                  Copy on select
                </label>
              </div>
            </div>
          </>
        )

      case 'editor':
        return (
          <>
            <p className="text-[12px] text-text-muted leading-snug mb-2">
              These options apply to Monaco-backed file editor and diff tabs.
            </p>

            <div className="flex flex-col gap-1">
              <label className={labelCls}>Editor Font Family</label>
              <input
                className={inputCls}
                value={config.editorFontFamily}
                onChange={(e) => updateConfig({ editorFontFamily: e.target.value })}
                placeholder="e.g. JetBrains Mono, monospace"
              />
            </div>

            <div className="grid gap-3 grid-cols-2">
              <div className="flex flex-col gap-1">
                <label className={labelCls}>Editor Font Size</label>
                <input
                  className={inputCls}
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

              <div className="flex flex-col gap-1">
                <label className={labelCls}>Tab Size</label>
                <input
                  className={inputCls}
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

            <div className="grid gap-3 grid-cols-2">
              <div className="flex flex-col gap-1">
                <label className={labelCls}>Word Wrap</label>
                <select
                  className={inputCls}
                  value={config.editorWordWrap}
                  onChange={(e) => updateConfig({ editorWordWrap: e.target.value as EditorWordWrap })}
                >
                  {editorWordWrapOptions.map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
              </div>

              <div className="flex flex-col gap-1">
                <label className={labelCls}>Line Numbers</label>
                <select
                  className={inputCls}
                  value={config.editorLineNumbers}
                  onChange={(e) => updateConfig({ editorLineNumbers: e.target.value as EditorLineNumbers })}
                >
                  {editorLineNumberOptions.map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
              </div>
            </div>

            <div className="grid gap-3 grid-cols-2">
              <div className="flex flex-col gap-1">
                <label className={labelCls}>Render Whitespace</label>
                <select
                  className={inputCls}
                  value={config.editorRenderWhitespace}
                  onChange={(e) => updateConfig({ editorRenderWhitespace: e.target.value as EditorRenderWhitespace })}
                >
                  {editorWhitespaceOptions.map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
              </div>

              <div className="flex flex-col gap-1">
                <label className={labelCls}>Diff Layout</label>
                <select
                  className={inputCls}
                  value={config.diffRenderSideBySide ? 'side-by-side' : 'inline'}
                  onChange={(e) => updateConfig({ diffRenderSideBySide: e.target.value === 'side-by-side' })}
                >
                  <option value="side-by-side">Side by side</option>
                  <option value="inline">Inline</option>
                </select>
              </div>
            </div>

            <div className="flex flex-col gap-2">
              <label className="flex items-center gap-2 text-[13px] text-text cursor-pointer">
                <input
                  type="checkbox"
                  className="cursor-pointer"
                  checked={config.editorMinimap}
                  onChange={(e) => updateConfig({ editorMinimap: e.target.checked })}
                />
                Show minimap in editor and diff tabs
              </label>
              <label className="flex items-center gap-2 text-[13px] text-text cursor-pointer">
                <input
                  type="checkbox"
                  className="cursor-pointer"
                  checked={config.diffIgnoreTrimWhitespace}
                  onChange={(e) => updateConfig({ diffIgnoreTrimWhitespace: e.target.checked })}
                />
                Ignore trim whitespace in diffs
              </label>
            </div>
          </>
        )

      case 'ai':
        return (
          <div className="flex flex-col gap-2">
            <label className="flex items-center gap-2 text-[13px] text-text cursor-pointer">
              <input
                type="checkbox"
                className="cursor-pointer"
                checked={config.enableClaude}
                onChange={(e) => updateConfig({ enableClaude: e.target.checked })}
              />
              Claude Code
            </label>
            <label className="flex items-center gap-2 text-[13px] text-text cursor-pointer">
              <input
                type="checkbox"
                className="cursor-pointer"
                checked={config.enableCodex}
                onChange={(e) => updateConfig({ enableCodex: e.target.checked })}
              />
              Codex
            </label>
            <label className="flex items-center gap-2 text-[13px] text-text cursor-pointer">
              <input
                type="checkbox"
                className="cursor-pointer"
                checked={config.enableOpencode}
                onChange={(e) => updateConfig({ enableOpencode: e.target.checked })}
              />
              OpenCode
            </label>
          </div>
        )

      case 'sidebar':
        return (
          <>
            <div className="flex flex-col gap-2">
              <label className="flex items-center gap-2 text-[13px] text-text cursor-pointer">
                <input
                  type="checkbox"
                  className="cursor-pointer"
                  checked={config.taskRecencyHighlight.enabled}
                  onChange={(e) => updateConfig({
                    taskRecencyHighlight: {
                      ...config.taskRecencyHighlight,
                      enabled: e.target.checked
                    }
                  })}
                />
                Highlight recently focused tasks
              </label>
            </div>

            <div className="grid gap-3 grid-cols-2">
              <div className="flex flex-col gap-1">
                <label className={labelCls}>Highlight Mode</label>
                <select
                  className={inputCls}
                  disabled={!config.taskRecencyHighlight.enabled}
                  value={config.taskRecencyHighlight.mode}
                  onChange={(e) => updateConfig({
                    taskRecencyHighlight: {
                      ...config.taskRecencyHighlight,
                      mode: e.target.value as 'rank' | 'time'
                    }
                  })}
                >
                  <option value="rank">Rank</option>
                  <option value="time">Time decay</option>
                </select>
              </div>

              <div className="flex flex-col gap-1">
                <label className={labelCls}>
                  {config.taskRecencyHighlight.mode === 'rank' ? 'Show top N tasks' : 'Fade after N minutes'}
                </label>
                <input
                  className={inputCls}
                  type="number"
                  disabled={!config.taskRecencyHighlight.enabled}
                  min={config.taskRecencyHighlight.mode === 'rank' ? 1 : 5}
                  max={config.taskRecencyHighlight.mode === 'rank' ? 20 : 10080}
                  value={
                    config.taskRecencyHighlight.mode === 'rank'
                      ? config.taskRecencyHighlight.rankCount
                      : config.taskRecencyHighlight.timeWindowMinutes
                  }
                  onChange={(e) => {
                    if (config.taskRecencyHighlight.mode === 'rank') {
                      updateConfig({
                        taskRecencyHighlight: {
                          ...config.taskRecencyHighlight,
                          rankCount: parseNumberInput(e.target.value, 5, 1, 20)
                        }
                      })
                    } else {
                      updateConfig({
                        taskRecencyHighlight: {
                          ...config.taskRecencyHighlight,
                          timeWindowMinutes: parseNumberInput(e.target.value, 1440, 5, 10080)
                        }
                      })
                    }
                  }}
                />
              </div>
            </div>

            <div className="flex flex-col gap-2">
              <label className="flex items-center gap-2 text-[13px] text-text cursor-pointer">
                <input
                  type="checkbox"
                  className="cursor-pointer"
                  checked={config.activityPanel.enabled}
                  onChange={(e) => updateConfig({
                    activityPanel: {
                      ...config.activityPanel,
                      enabled: e.target.checked
                    }
                  })}
                />
                Show Recent Activity panel
              </label>
            </div>
          </>
        )
    }
  }

  return (
    <div className="fixed inset-0 z-[2000] flex items-center justify-center bg-black/50">
      <div className="w-[680px] max-w-[90vw] max-h-[85vh] rounded-xl border border-border bg-surface-2 shadow-2xl flex flex-col overflow-hidden">
        {/* header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-border shrink-0">
          <h2 className="text-[14px] font-semibold text-text m-0">Settings</h2>
          <button
            onClick={onClose}
            className="bg-transparent border-0 text-text-muted cursor-pointer text-[18px] leading-none px-1 rounded-sm hover:text-text"
          >
            &times;
          </button>
        </div>

        {/* split: tabs + panel */}
        <div className="flex flex-1 min-h-0">
          {/* left rail */}
          <div className="w-44 border-r border-border py-2 flex flex-col gap-0.5 shrink-0">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                data-selected={activeTab === tab.id ? 'true' : undefined}
                className="text-left px-4 py-1.5 text-[13px] text-text-muted hover:text-text cursor-pointer bg-transparent border-0 data-[selected=true]:relative data-[selected=true]:before:absolute data-[selected=true]:before:inset-y-0 data-[selected=true]:before:left-0 data-[selected=true]:before:w-0.5 data-[selected=true]:before:bg-accent-400 data-[selected=true]:bg-gradient-to-r data-[selected=true]:from-accent-600/30 data-[selected=true]:to-transparent data-[selected=true]:text-accent-50 [.theme-light_&[data-selected=true]]:from-accent-200 [.theme-light_&[data-selected=true]]:text-accent-700"
              >
                {tab.label}
              </button>
            ))}
          </div>

          {/* right panel */}
          <div className="flex-1 overflow-y-auto p-5 flex flex-col gap-4">
            {renderTabContent()}
          </div>
        </div>
      </div>
    </div>
  )
}
