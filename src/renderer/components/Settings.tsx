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
import { GrpHead, FormGroup, SetBlock, Group, GroupRow, SegCtl, Switch, Field, Select, HelperText } from './ui'

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

const themeOptions = [
  { value: 'system', label: 'System' },
  { value: 'dark', label: 'Dark' },
  { value: 'light', label: 'Light' }
] as const

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

export default function Settings({ onClose }: Props): React.ReactElement {
  const { config, updateConfig } = useApp()
  const [activeTab, setActiveTab] = useState<SettingsTab>('appearance')

  if (!config) return <div />

  const renderTabContent = () => {
    switch (activeTab) {
      case 'appearance':
        return (
          <>
            <GrpHead>Appearance</GrpHead>
            <FormGroup>
              <SetBlock label="Application theme">
                <SegCtl
                  options={themeOptions}
                  value={config.theme}
                  onChange={(theme) => updateConfig({ theme })}
                />
                <HelperText>System follows the macOS appearance.</HelperText>
              </SetBlock>
            </FormGroup>
          </>
        )

      case 'terminal':
        return (
          <>
            <GrpHead>Type</GrpHead>
            <FormGroup>
              <SetBlock label="Font family">
                <Field
                  value={config.fontFamily}
                  onChange={(e) => updateConfig({ fontFamily: e.target.value })}
                  placeholder="e.g. MesloLGS NF, monospace"
                />
              </SetBlock>
              <SetBlock label="Font size" divider>
                <Field
                  type="number"
                  className="w-24"
                  min={8}
                  max={32}
                  value={config.fontSize}
                  onChange={(e) => updateConfig({ fontSize: parseNumberInput(e.target.value, 14, 8, 32) })}
                />
              </SetBlock>
            </FormGroup>

            <GrpHead>Colors</GrpHead>
            <FormGroup>
              <SetBlock label="Terminal theme">
                <SegCtl
                  options={themeOptions}
                  value={config.terminalTheme}
                  onChange={(terminalTheme) => updateConfig({ terminalTheme })}
                />
              </SetBlock>
              <SetBlock label="Color scheme" divider>
                <Select
                  value={config.terminalColorScheme}
                  onChange={(e) => updateConfig({ terminalColorScheme: e.target.value as TerminalColorScheme })}
                >
                  {TERMINAL_SCHEME_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </Select>
                <HelperText>
                  {TERMINAL_SCHEME_OPTIONS.find(o => o.value === config.terminalColorScheme)?.description}
                </HelperText>
              </SetBlock>
            </FormGroup>

            <GrpHead>Behavior</GrpHead>
            <Group>
              <GroupRow
                label="Copy on select"
                trailing={
                  <Switch
                    checked={config.copyOnSelect}
                    onChange={(copyOnSelect) => updateConfig({ copyOnSelect })}
                  />
                }
              />
            </Group>
            <FormGroup>
              <SetBlock label="Default shell">
                <Field
                  value={config.defaultShell}
                  onChange={(e) => updateConfig({ defaultShell: e.target.value })}
                  placeholder="$SHELL (system default)"
                />
                <HelperText>Leave empty to use your login shell.</HelperText>
              </SetBlock>
            </FormGroup>
          </>
        )

      case 'editor':
        return (
          <>
            <GrpHead>Editor & Diff</GrpHead>
            <FormGroup>
              <HelperText>Applies to Monaco-backed file editor and diff tabs.</HelperText>
              <SetBlock label="Font family" divider>
                <Field
                  value={config.editorFontFamily}
                  onChange={(e) => updateConfig({ editorFontFamily: e.target.value })}
                  placeholder="e.g. JetBrains Mono, monospace"
                />
              </SetBlock>
              <SetBlock divider>
                <div className="grid gap-3 grid-cols-2">
                  <SetBlock label="Font size">
                    <Field
                      type="number"
                      min={EDITOR_FONT_SIZE_MIN}
                      max={EDITOR_FONT_SIZE_MAX}
                      value={config.editorFontSize}
                      onChange={(e) => updateConfig({
                        editorFontSize: parseNumberInput(e.target.value, 14, EDITOR_FONT_SIZE_MIN, EDITOR_FONT_SIZE_MAX)
                      })}
                    />
                  </SetBlock>
                  <SetBlock label="Tab size">
                    <Field
                      type="number"
                      min={EDITOR_TAB_SIZE_MIN}
                      max={EDITOR_TAB_SIZE_MAX}
                      value={config.editorTabSize}
                      onChange={(e) => updateConfig({
                        editorTabSize: parseNumberInput(e.target.value, 4, EDITOR_TAB_SIZE_MIN, EDITOR_TAB_SIZE_MAX)
                      })}
                    />
                  </SetBlock>
                </div>
              </SetBlock>
              <SetBlock divider>
                <div className="grid gap-3 grid-cols-2">
                  <SetBlock label="Word wrap">
                    <Select
                      value={config.editorWordWrap}
                      onChange={(e) => updateConfig({ editorWordWrap: e.target.value as EditorWordWrap })}
                    >
                      {editorWordWrapOptions.map((option) => (
                        <option key={option.value} value={option.value}>{option.label}</option>
                      ))}
                    </Select>
                  </SetBlock>
                  <SetBlock label="Line numbers">
                    <Select
                      value={config.editorLineNumbers}
                      onChange={(e) => updateConfig({ editorLineNumbers: e.target.value as EditorLineNumbers })}
                    >
                      {editorLineNumberOptions.map((option) => (
                        <option key={option.value} value={option.value}>{option.label}</option>
                      ))}
                    </Select>
                  </SetBlock>
                  <SetBlock label="Render whitespace">
                    <Select
                      value={config.editorRenderWhitespace}
                      onChange={(e) => updateConfig({ editorRenderWhitespace: e.target.value as EditorRenderWhitespace })}
                    >
                      {editorWhitespaceOptions.map((option) => (
                        <option key={option.value} value={option.value}>{option.label}</option>
                      ))}
                    </Select>
                  </SetBlock>
                  <SetBlock label="Diff layout">
                    <Select
                      value={config.diffRenderSideBySide ? 'side-by-side' : 'inline'}
                      onChange={(e) => updateConfig({ diffRenderSideBySide: e.target.value === 'side-by-side' })}
                    >
                      <option value="side-by-side">Side by side</option>
                      <option value="inline">Inline</option>
                    </Select>
                  </SetBlock>
                </div>
              </SetBlock>
            </FormGroup>

            <Group>
              <GroupRow
                label="Show minimap"
                sub="In editor and diff tabs"
                trailing={
                  <Switch
                    checked={config.editorMinimap}
                    onChange={(editorMinimap) => updateConfig({ editorMinimap })}
                  />
                }
              />
              <GroupRow
                label="Ignore trim whitespace in diffs"
                trailing={
                  <Switch
                    checked={config.diffIgnoreTrimWhitespace}
                    onChange={(diffIgnoreTrimWhitespace) => updateConfig({ diffIgnoreTrimWhitespace })}
                  />
                }
              />
            </Group>
          </>
        )

      case 'ai':
        return (
          <>
            <GrpHead>Enabled tools</GrpHead>
            <Group>
              <GroupRow
                label="Claude Code"
                trailing={
                  <Switch
                    checked={config.enableClaude}
                    onChange={(enableClaude) => updateConfig({ enableClaude })}
                  />
                }
              />
              <GroupRow
                label="Codex"
                trailing={
                  <Switch
                    checked={config.enableCodex}
                    onChange={(enableCodex) => updateConfig({ enableCodex })}
                  />
                }
              />
              <GroupRow
                label="Pi"
                trailing={
                  <Switch
                    checked={config.enablePi}
                    onChange={(enablePi) => updateConfig({ enablePi })}
                  />
                }
              />
            </Group>

            <GrpHead>Claude Code</GrpHead>
            <Group>
              <GroupRow
                label="Lazy-load Claude tabs"
                sub="Tabs with prior history wait for a Resume click, saving tokens after a restart."
                trailing={
                  <Switch
                    checked={config.lazyLoadClaude}
                    onChange={(lazyLoadClaude) => updateConfig({ lazyLoadClaude })}
                  />
                }
              />
            </Group>
          </>
        )

      case 'sidebar':
        return (
          <>
            <GrpHead>Sidebar</GrpHead>
            <Group>
              <GroupRow
                label="Highlight recently focused tasks"
                trailing={
                  <Switch
                    checked={config.taskRecencyHighlight.enabled}
                    onChange={(enabled) => updateConfig({
                      taskRecencyHighlight: { ...config.taskRecencyHighlight, enabled }
                    })}
                  />
                }
              />
              <GroupRow
                label="Show Recent Activity panel"
                trailing={
                  <Switch
                    checked={config.activityPanel.enabled}
                    onChange={(enabled) => updateConfig({
                      activityPanel: { ...config.activityPanel, enabled }
                    })}
                  />
                }
              />
            </Group>

            <FormGroup>
              <SetBlock label="Highlight mode">
                <SegCtl
                  options={[
                    { value: 'rank', label: 'Rank' },
                    { value: 'time', label: 'Time decay' }
                  ] as const}
                  value={config.taskRecencyHighlight.mode}
                  disabled={!config.taskRecencyHighlight.enabled}
                  onChange={(mode) => updateConfig({
                    taskRecencyHighlight: { ...config.taskRecencyHighlight, mode }
                  })}
                />
              </SetBlock>
              <SetBlock
                label={config.taskRecencyHighlight.mode === 'rank' ? 'Show top N tasks' : 'Fade after N minutes'}
                divider
              >
                <Field
                  type="number"
                  className="w-24"
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
                <HelperText>
                  {config.taskRecencyHighlight.mode === 'rank'
                    ? 'The most recently focused tasks stay highlighted.'
                    : 'Highlights fade as tasks go untouched.'}
                </HelperText>
              </SetBlock>
            </FormGroup>
          </>
        )
    }
  }

  return (
    <div className="fixed inset-0 z-(--z-modal) flex items-center justify-center bg-black/50">
      <div className="w-[680px] max-w-[90vw] h-[520px] max-h-[85vh] rounded-xl border border-border bg-surface shadow-pop flex flex-col overflow-hidden">
        {/* header */}
        <div className="flex items-center justify-between px-4 h-(--ctl-h-lg) mt-1 shrink-0">
          <h2 className="text-md font-semibold text-text m-0">Settings</h2>
          <button
            onClick={onClose}
            className="bg-transparent border-0 text-text-muted cursor-pointer text-lg leading-none px-1 rounded-sm hover:text-text"
            title="Close"
          >
            &times;
          </button>
        </div>

        {/* split: tabs + panel */}
        <div className="flex flex-1 min-h-0">
          {/* left rail */}
          <div className="w-40 border-r border-hair py-2 px-2 flex flex-col gap-0.5 shrink-0">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={[
                  'text-left rounded-md px-2.5 py-1 text-base cursor-pointer bg-transparent border-0',
                  'transition-colors duration-(--motion-fast)',
                  activeTab === tab.id ? 'bg-sel text-text' : 'text-text-muted hover:text-text'
                ].join(' ')}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {/* right panel */}
          <div className="flex-1 overflow-y-auto px-4 pb-4 flex flex-col gap-2">
            {renderTabContent()}
          </div>
        </div>
      </div>
    </div>
  )
}
