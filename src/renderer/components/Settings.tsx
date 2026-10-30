import React, { useState } from 'react'
import { FileDiff, Inbox, Palette, RadioTower, RefreshCw, Server, Smartphone, Sparkles, SquareTerminal, X, type LucideIcon } from 'lucide-react'
import type { EditorLineNumbers, EditorRenderWhitespace, EditorWordWrap, PromptBoxAgent, TerminalColorScheme } from '../../shared/types'
import { PROMPT_BOX_AGENTS } from '../../shared/types'
import { PROMPT_BOX_AGENT_LABEL } from './promptBox'
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
import HostsSettings from './settings/HostsSettings'
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

export type SettingsTab = 'appearance' | 'terminal' | 'editor' | 'ai' | 'sidebar' | 'mobile' | 'hosts' | 'relay' | 'updates'

interface TabInfo {
  id: SettingsTab
  label: string
  icon: LucideIcon
  /** Under the page title: what the page is for. */
  blurb: string
}

/** The rail, in groups: how DevTool looks and works here, then where code runs and who reaches it. */
const tabGroups: Array<{ label: string; tabs: TabInfo[] }> = [
  {
    label: 'App',
    tabs: [
      { id: 'appearance', label: 'Appearance', icon: Palette, blurb: 'How DevTool looks.' },
      { id: 'terminal', label: 'Terminal', icon: SquareTerminal, blurb: 'Type, colors and behavior of terminal tabs.' },
      { id: 'editor', label: 'Editor & Diff', icon: FileDiff, blurb: 'The file editor, notebook cells and diff tabs.' },
      { id: 'ai', label: 'AI Tools', icon: Sparkles, blurb: 'Which agents a task can start, and how they run.' },
      { id: 'sidebar', label: 'Inbox', icon: Inbox, blurb: 'The task list in the sidebar, and where new projects go.' }
    ]
  },
  {
    label: 'Remote',
    tabs: [
      { id: 'hosts', label: 'Hosts', icon: Server, blurb: 'Where your projects run. Each project picks one host when you make it; the status bar shows which.' },
      { id: 'mobile', label: 'Mobile', icon: Smartphone, blurb: 'Your phone sees this desktop\'s projects and tasks, and can start and answer them.' },
      { id: 'relay', label: 'Relay', icon: RadioTower, blurb: 'How phones and DevTool servers reach this computer.' }
    ]
  },
  {
    label: 'About',
    tabs: [
      { id: 'updates', label: 'Updates', icon: RefreshCw, blurb: 'This DevTool\'s version and new releases.' }
    ]
  }
]

const tabs = tabGroups.flatMap(group => group.tabs)

/** Old page ids still sent by links: Servers is a section of Hosts now. */
function resolveTab(id: string | undefined): { tab: SettingsTab; focus?: 'servers' } {
  if (id === 'servers') return { tab: 'hosts', focus: 'servers' }
  return { tab: tabs.find(t => t.id === id)?.id ?? 'appearance' }
}

export default function Settings({ onClose, initialTab }: Props): React.ReactElement {
  const { config, updateConfig, setMainTaskWorktreesEverywhere } = useApp()
  const [initial] = useState(() => resolveTab(initialTab))
  const [activeTab, setActiveTab] = useState<SettingsTab>(initial.tab)
  const page = tabs.find(t => t.id === activeTab) ?? tabs[0]

  if (!config) return <div />

  const renderTabContent = () => {
    switch (activeTab) {
      case 'appearance':
        return (
          <>
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
            <FormGroup>
              <SetBlock label="Font family">
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

            <GrpHead>Quick task</GrpHead>
            <FormGroup>
              <SetBlock label="Agent">
                <Select
                  value={config.deskAgent}
                  onChange={(e) => updateConfig({ deskAgent: e.target.value as PromptBoxAgent })}
                >
                  {PROMPT_BOX_AGENTS.filter(agent => (agent === 'codex' ? config.enableCodex : agent === 'pi' ? config.enablePi : config.enableClaude) || agent === config.deskAgent).map(agent => (
                    <option key={agent} value={agent}>{agent === 'claude-chat' ? 'Claude (chat)' : PROMPT_BOX_AGENT_LABEL[agent]}</option>
                  ))}
                </Select>
                <HelperText>
                  What the sidebar&apos;s &ldquo;Ask or give a task&hellip;&rdquo; box and the ⌘K bar start. Options&hellip; picks another for one task.
                </HelperText>
              </SetBlock>
            </FormGroup>
            {config.enableCodex && (
              <Group>
                <GroupRow
                  label="Codex reviews Autopilot tasks"
                  sub="A quick task fired with ⌘↵ goes on Autopilot; with this on, Codex reviews its changes before it lands. The New task form has its own switch."
                  trailing={
                    <Switch
                      checked={config.autopilotReview}
                      onChange={(autopilotReview) => updateConfig({ autopilotReview })}
                    />
                  }
                />
              </Group>
            )}

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

      case 'hosts':
        return <HostsSettings onOpenRelay={() => setActiveTab('relay')} focus={initial.tab === 'hosts' ? initial.focus : undefined} />

      case 'relay':
        return <RelaySettings />

      case 'updates':
        return <UpdatesSettings />

      case 'sidebar':
        return (
          <>
            <FormGroup>
              <SetBlock label="Group the list">
                <SegCtl
                  options={[
                    { value: 'flat', label: 'By status' },
                    { value: 'grouped', label: 'By project' }
                  ] as const}
                  value={config.inboxLayout}
                  onChange={(inboxLayout) => updateConfig({ inboxLayout })}
                />
                <HelperText>By project puts each tab's tasks under a header per project, pinned projects first. The button beside the tabs switches it too.</HelperText>
              </SetBlock>
            </FormGroup>

            <Group>
              <GroupRow
                label="Leave the task after sending"
                sub="Once a prompt goes to the agent, the window empties so you can pick another task or start a new one. The answer comes back unread in the Inbox."
                trailing={
                  <Switch
                    checked={config.leaveTaskOnSend}
                    onChange={(leaveTaskOnSend) => updateConfig({ leaveTaskOnSend })}
                  />
                }
              />
            </Group>

            <FormGroup>
              <SetBlock label="Projects folder">
                <div className="flex items-center gap-2.5">
                  <Field
                    className="flex-1"
                    value={config.projectsDir}
                    onChange={(e) => updateConfig({ projectsDir: e.target.value })}
                    placeholder="/path/to/projects"
                  />
                  <LinkBtn
                    onClick={() => {
                      void window.api.pickDirectory().then((picked) => {
                        if (picked) updateConfig({ projectsDir: picked })
                      })
                    }}
                  >
                    Browse
                  </LinkBtn>
                </div>
                <HelperText>New project… makes a folder here and runs git init in it.</HelperText>
              </SetBlock>
            </FormGroup>

            <Group>
              <GroupRow
                label="Worktrees on main"
                sub="Every project's new tasks in main get a worktree of their own, branched off the project folder's branch, and Done lands them back. Applies to all projects now and to new ones; Project Settings can still change one."
                trailing={
                  <Switch
                    checked={config.mainTaskWorktrees}
                    onChange={(mainTaskWorktrees) => {
                      updateConfig({ mainTaskWorktrees })
                      setMainTaskWorktreesEverywhere(mainTaskWorktrees)
                    }}
                  />
                }
              />
            </Group>

            <Group>
              <GroupRow
                label="Show project icons"
                sub="A project's dashboard icon in place of its initials, in the task header."
                trailing={
                  <Switch
                    checked={config.showProjectIcons}
                    onChange={(showProjectIcons) => updateConfig({ showProjectIcons })}
                  />
                }
              />
            </Group>
          </>
        )
    }
  }

  return (
    <div className="fixed inset-0 z-(--z-modal) flex items-center justify-center bg-black/50" data-modal>
      <div className="w-[860px] max-w-[92vw] h-[640px] max-h-[88vh] rounded-xl border border-border bg-surface shadow-pop flex overflow-hidden">
        {/* left rail */}
        <nav className="w-48 shrink-0 bg-surface-2 border-r border-hair flex flex-col px-2 pb-3 overflow-y-auto" aria-label="Settings pages">
          <h2 className="m-0 px-2.5 pt-4 pb-3 text-md font-semibold text-text">Settings</h2>
          {tabGroups.map(group => (
            <div key={group.label} className="flex flex-col gap-px mb-3">
              <div className="px-2.5 pb-1 text-2xs font-semibold uppercase tracking-[0.06em] text-text-subtle">{group.label}</div>
              {group.tabs.map(tab => {
                const Icon = tab.icon
                const active = activeTab === tab.id
                return (
                  <button
                    key={tab.id}
                    type="button"
                    onClick={() => setActiveTab(tab.id)}
                    aria-current={active ? 'page' : undefined}
                    className={[
                      'flex items-center gap-2.5 text-left rounded-md px-2.5 py-[5px] text-base cursor-pointer border-0',
                      'transition-colors duration-(--motion-fast)',
                      active ? 'bg-sel text-text' : 'bg-transparent text-text-muted hover:text-text hover:bg-surface-3'
                    ].join(' ')}
                    data-testid={`settings-tab-${tab.id}`}
                  >
                    <Icon size={15} strokeWidth={1.75} className={`shrink-0 ${active ? 'text-accent' : ''}`} />
                    {tab.label}
                  </button>
                )
              })}
            </div>
          ))}
        </nav>

        {/* page */}
        <div className="flex-1 min-w-0 flex flex-col">
          <header className="flex items-start gap-3 px-6 pt-5 pb-4 border-b border-hair shrink-0">
            <div className="flex-1 min-w-0 flex flex-col gap-1">
              <h3 className="m-0 text-lg font-semibold text-text">{page.label}</h3>
              <p className="m-0 text-sm text-text-muted leading-snug">{page.blurb}</p>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="shrink-0 -mr-2 -mt-1 w-7 h-7 flex items-center justify-center bg-transparent border-0 text-text-muted cursor-pointer rounded-md hover:text-text hover:bg-surface-3"
              title="Close"
              aria-label="Close settings"
            >
              <X size={15} />
            </button>
          </header>
          {/* Cards must keep their intrinsic height — the panel scrolls instead of squashing them. */}
          <div className="flex-1 overflow-y-auto px-6 pt-4 pb-6 flex flex-col gap-2.5 [&>*]:shrink-0" data-testid="settings-page">
            {renderTabContent()}
          </div>
        </div>
      </div>
    </div>
  )
}
