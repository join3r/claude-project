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
import { GrpHead, FormGroup, SetBlock, Group, GroupRow, SegCtl, Switch, Field, Select, HelperText, LinkBtn } from './ui'
import ExternalIdesSettings from './ExternalIdesSettings'
import MobileSettings from './settings/MobileSettings'
import ServersSettings from './settings/ServersSettings'
import RelaySettings from './settings/RelaySettings'
import UpdatesSettings from './settings/UpdatesSettings'

interface Props {
  onClose: () => void
  /** The page to open on; Appearance when missing or unknown. */
  initialTab?: string
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

export type SettingsTab = 'appearance' | 'terminal' | 'editor' | 'ai' | 'sidebar' | 'mobile' | 'servers' | 'relay' | 'updates'

const tabs: Array<{ id: SettingsTab; label: string }> = [
  { id: 'appearance', label: 'Appearance' },
  { id: 'terminal', label: 'Terminal' },
  { id: 'editor', label: 'Editor & Diff' },
  { id: 'ai', label: 'AI Tools' },
  { id: 'sidebar', label: 'Sidebar' },
  { id: 'mobile', label: 'Mobile' },
  { id: 'servers', label: 'Servers' },
  { id: 'relay', label: 'Relay' },
  { id: 'updates', label: 'Updates' }
]

export default function Settings({ onClose, initialTab }: Props): React.ReactElement {
  const { config, updateConfig, clearStreamExpansion } = useApp()
  const [activeTab, setActiveTab] = useState<SettingsTab>(() => tabs.find(t => t.id === initialTab)?.id ?? 'appearance')

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
                {window.api.platform === 'win32' ? (
                  <>
                    <div className="flex items-center gap-2.5">
                      <Field
                        className="flex-1"
                        value={config.defaultShell}
                        onChange={(e) => updateConfig({ defaultShell: e.target.value })}
                        placeholder="Auto-detect Git Bash"
                      />
                      <LinkBtn
                        onClick={() => {
                          void window.api.pickFile('Select Git Bash (bash.exe)').then((picked) => {
                            if (picked) updateConfig({ defaultShell: picked })
                          })
                        }}
                      >
                        Browse
                      </LinkBtn>
                    </div>
                    <HelperText>
                      Windows terminals are Git Bash only. Empty auto-detects bash.exe under Git/bin. New tabs only.
                    </HelperText>
                  </>
                ) : (
                  <>
                    <Field
                      value={config.defaultShell}
                      onChange={(e) => updateConfig({ defaultShell: e.target.value })}
                      placeholder="$SHELL (system default)"
                    />
                    <HelperText>Leave empty to use your login shell.</HelperText>
                  </>
                )}
              </SetBlock>
              <SetBlock label="Node directory" divider>
                <div className="flex items-center gap-2.5">
                  <Field
                    className="flex-1"
                    value={config.portableNodeDir}
                    onChange={(e) => updateConfig({ portableNodeDir: e.target.value })}
                    placeholder="Folder that contains node.exe"
                  />
                  <LinkBtn
                    onClick={() => {
                      void window.api.pickDirectory().then((picked) => {
                        if (picked) updateConfig({ portableNodeDir: picked })
                      })
                    }}
                  >
                    Browse
                  </LinkBtn>
                </div>
                <HelperText>
                  Unzipped Node zip. The folder must contain node.exe. It is prepended to PATH
                  for new terminal and Pi tabs (already-open tabs keep their original PATH).
                  A conda env is a separate per-project picker in Project Settings.
                </HelperText>
              </SetBlock>
            </FormGroup>
          </>
        )

      case 'editor':
        return (
          <>
            <GrpHead>Editor & Diff</GrpHead>
            <FormGroup>
              <HelperText>Applies to Monaco-backed file editor, notebook cells, and diff tabs.</HelperText>
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
            <ExternalIdesSettings
              value={config.externalEditors ?? { editors: [], defaultId: null }}
              onChange={(externalEditors) => updateConfig({ externalEditors })}
            />
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
              <GroupRow
                label="Keep the computer awake while agents work"
                sub="While an agent is working, the system doesn't go to sleep. The display still can."
                trailing={
                  <Switch
                    checked={config.keepAwakeWhileWorking}
                    onChange={(keepAwakeWhileWorking) => updateConfig({ keepAwakeWhileWorking })}
                  />
                }
              />
            </Group>

            <GrpHead>Claude Code</GrpHead>
            {config.enableClaude && (
              <FormGroup>
                <SetBlock label="Command path">
                  <div className="flex items-center gap-2.5">
                    <Field
                      className="flex-1"
                      value={config.claudeCommand}
                      onChange={(e) => updateConfig({ claudeCommand: e.target.value })}
                      placeholder="claude"
                    />
                    <LinkBtn
                      onClick={() => {
                        void window.api.pickFile('Select Claude Code executable').then((picked) => {
                          if (picked) updateConfig({ claudeCommand: picked })
                        })
                      }}
                    >
                      Browse
                    </LinkBtn>
                  </div>
                  <HelperText>
                    Leave empty to use `claude` on PATH. On Windows this is often %AppData%\npm\claude.cmd.
                  </HelperText>
                </SetBlock>
              </FormGroup>
            )}
            <FormGroup>
              <SetBlock label="New Claude tasks open as">
                <SegCtl
                  options={[{ value: 'terminal', label: 'Terminal' }, { value: 'chat', label: 'Chat' }] as const}
                  value={config.claudeDefaultView}
                  onChange={(claudeDefaultView) => updateConfig({ claudeDefaultView })}
                />
                <HelperText>
                  Chat drives the same `claude` (your login, settings and hooks) in DevTool&apos;s own UI. Switch a task between the two from the … menu in its header.
                </HelperText>
              </SetBlock>
            </FormGroup>
            <Group>
              <GroupRow
                label="Lazy-load Claude tasks"
                sub="After a restart, Claude Code and Pi tasks with history wait for a Resume click, saving tokens. Chat tasks start only when you send."
                trailing={
                  <Switch
                    checked={config.lazyLoadClaude}
                    onChange={(lazyLoadClaude) => updateConfig({ lazyLoadClaude })}
                  />
                }
              />
            </Group>

            {config.enableCodex && (
              <>
                <GrpHead>Codex</GrpHead>
                <FormGroup>
                  <SetBlock label="Command path">
                    <div className="flex items-center gap-2.5">
                      <Field
                        className="flex-1"
                        value={config.codexCommand}
                        onChange={(e) => updateConfig({ codexCommand: e.target.value })}
                        placeholder="codex"
                      />
                      <LinkBtn
                        onClick={() => {
                          void window.api.pickFile('Select Codex executable').then((picked) => {
                            if (picked) updateConfig({ codexCommand: picked })
                          })
                        }}
                      >
                        Browse
                      </LinkBtn>
                    </div>
                    <HelperText>
                      Leave empty to use `codex` on PATH. On Windows this is often %AppData%\npm\codex.cmd.
                    </HelperText>
                  </SetBlock>
                </FormGroup>
              </>
            )}

            {config.enablePi && (
              <>
                <GrpHead>Pi</GrpHead>
                <FormGroup>
                  <SetBlock label="Command path">
                    <div className="flex items-center gap-2.5">
                      <Field
                        className="flex-1"
                        value={config.piCommand}
                        onChange={(e) => updateConfig({ piCommand: e.target.value })}
                        placeholder="pi"
                      />
                      <LinkBtn
                        onClick={() => {
                          void window.api.pickFile('Select Pi executable').then((picked) => {
                            if (picked) updateConfig({ piCommand: picked })
                          })
                        }}
                      >
                        Browse
                      </LinkBtn>
                    </div>
                    <HelperText>
                      Leave empty to use `pi` on PATH. On Windows this is often %AppData%\npm\pi.cmd.
                    </HelperText>
                  </SetBlock>
                </FormGroup>
              </>
            )}
          </>
        )

      case 'mobile':
        return <MobileSettings onOpenRelay={() => setActiveTab('relay')} />

      case 'servers':
        return <ServersSettings onOpenRelay={() => setActiveTab('relay')} />

      case 'relay':
        return <RelaySettings />

      case 'updates':
        return <UpdatesSettings />

      case 'sidebar':
        return (
          <>
            <GrpHead>Sidebar</GrpHead>
            <FormGroup>
              <SetBlock label="Sidebar opens on">
                <SegCtl
                  options={[
                    { value: 'projects', label: 'Projects' },
                    { value: 'inbox', label: 'Inbox' }
                  ] as const}
                  value={config.defaultSidebarTab}
                  onChange={(defaultSidebarTab) => updateConfig({ defaultSidebarTab })}
                />
                <HelperText>Applies to new windows; each window remembers which one you last picked.</HelperText>
              </SetBlock>
            </FormGroup>

            <FormGroup>
              <SetBlock label="Inbox layout">
                <SegCtl
                  options={[
                    { value: 'flat', label: 'Flat' },
                    { value: 'grouped', label: 'Grouped by project' }
                  ] as const}
                  value={config.inboxLayout}
                  onChange={(inboxLayout) => updateConfig({ inboxLayout })}
                />
                <HelperText>Grouped puts open tasks under a header per project, each row naming its stream; Snoozed and Done for now stay folded at the bottom.</HelperText>
              </SetBlock>
            </FormGroup>

            <Group>
              <GroupRow
                label="Collapse quiet streams"
                sub="Streams where no task needs you, runs or has news fold up. A chevron click overrides it."
                trailing={
                  <Switch
                    checked={config.autoCollapseQuietStreams}
                    onChange={(autoCollapseQuietStreams) => {
                      // A fresh rule: hand-opened and hand-closed streams follow it again.
                      updateConfig({ autoCollapseQuietStreams })
                      clearStreamExpansion()
                    }}
                  />
                }
              />
              <GroupRow
                label="Show project icons"
                sub="Tiles and icons beside project names in the sidebar, Inbox and task header."
                trailing={
                  <Switch
                    checked={config.showProjectIcons}
                    onChange={(showProjectIcons) => updateConfig({ showProjectIcons })}
                  />
                }
              />
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
          {/* Cards must keep their intrinsic height — the panel scrolls instead of squashing them. */}
          <div className="flex-1 overflow-y-auto px-4 pb-4 flex flex-col gap-2 [&>*]:shrink-0">
            {renderTabContent()}
          </div>
        </div>
      </div>
    </div>
  )
}
