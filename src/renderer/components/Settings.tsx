import React, { useEffect, useMemo, useState } from 'react'
import type { CleanupActivity, EditorLineNumbers, EditorRenderWhitespace, EditorWordWrap, IdleTaskCleanupConfig, NewTaskAutoOpen, TabStatusValue, TerminalColorScheme } from '../../shared/types'
import { useApp } from '../context/AppContext'
import { useAllTabStatuses } from '../context/TabStatusContext'
import { findIdleCleanupCandidates } from '../../shared/idle-cleanup'
import { isAutoOpenAvailable } from './newTaskTabs'
import { TERMINAL_SCHEME_OPTIONS } from './terminalThemes'
import {
  EDITOR_FONT_SIZE_MAX,
  EDITOR_FONT_SIZE_MIN,
  EDITOR_TAB_SIZE_MAX,
  EDITOR_TAB_SIZE_MIN
} from './monacoOptions'
import { GrpHead, FormGroup, SetBlock, Group, GroupRow, SegCtl, Switch, Field, Select, HelperText, Disclosure } from './ui'

interface Props {
  onClose: () => void
}

/** How strongly a status protects a task from cleanup — the stronger claim wins a merge. */
const STATUS_WEIGHT: Record<string, number> = { attention: 3, working: 2, exited: 1 }

/**
 * Main hears the hooks; a window additionally runs the bell/quiet heuristics for
 * tools that have none. Neither view is complete, so the preview takes whichever
 * one makes the stronger claim about the tab.
 */
function mergeTabStatuses(
  local: Record<string, TabStatusValue>,
  fromMain: Record<string, TabStatusValue> | undefined
): Record<string, TabStatusValue> {
  if (!fromMain) return local
  const merged = { ...local }
  for (const [tabId, status] of Object.entries(fromMain)) {
    const weight = STATUS_WEIGHT[status ?? ''] ?? 0
    const currentWeight = STATUS_WEIGHT[merged[tabId] ?? ''] ?? 0
    if (weight > currentWeight) merged[tabId] = status
  }
  return merged
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

const newTaskAutoOpenOptions: Array<{ value: NewTaskAutoOpen; label: string }> = [
  { value: 'none', label: 'Nothing' },
  { value: 'claude', label: 'Claude Code' },
  { value: 'codex', label: 'Codex' },
  { value: 'pi', label: 'Pi' },
  { value: 'terminal', label: 'Terminal' },
  { value: 'browser', label: 'Browser' }
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

type SettingsTab = 'appearance' | 'terminal' | 'editor' | 'ai' | 'sidebar' | 'tasks'

const tabs: Array<{ id: SettingsTab; label: string }> = [
  { id: 'appearance', label: 'Appearance' },
  { id: 'terminal', label: 'Terminal' },
  { id: 'editor', label: 'Editor & Diff' },
  { id: 'ai', label: 'AI Tools' },
  { id: 'sidebar', label: 'Sidebar' },
  { id: 'tasks', label: 'Tasks' }
]

export default function Settings({ onClose }: Props): React.ReactElement {
  const { config, projects, pinnedItems, updateConfig } = useApp()
  const localStatuses = useAllTabStatuses()
  const [activeTab, setActiveTab] = useState<SettingsTab>('appearance')
  const [previewOpen, setPreviewOpen] = useState(false)
  // What the sweep itself would see. Read from main rather than from this window,
  // which is blind to the other windows' selections and to their agents.
  const [activity, setActivity] = useState<CleanupActivity | null>(null)

  useEffect(() => {
    let alive = true
    void window.api.getCleanupActivity()
      .then(next => { if (alive) setActivity(next) })
      .catch(() => {})
    return () => { alive = false }
  }, [])

  const cleanup = config?.idleTaskCleanup
  // Deliberately ignores the master switch: the point of the preview is to check what the
  // knobs would do *before* turning silent deletion on.
  const cleanupPreview = useMemo(() => {
    if (!cleanup) return []
    return findIdleCleanupCandidates({
      projects,
      pinnedItems,
      // This window's heuristic statuses (terminal bells, Codex activity) merged
      // with main's hook-driven ones: both protect, neither replaces the other.
      statuses: mergeTabStatuses(localStatuses, activity?.statuses),
      openTaskIds: activity?.openTaskIds ?? [],
      liveTabIds: activity?.liveTabIds ?? [],
      dirtyTabIds: activity?.dirtyTabIds ?? [],
      config: cleanup,
      now: Date.now()
    })
  }, [cleanup, projects, pinnedItems, localStatuses, activity])

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
                <HelperText>Applies to new windows; each window remembers the tab you switch to.</HelperText>
              </SetBlock>
            </FormGroup>

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

            <GrpHead>New task</GrpHead>
            <FormGroup>
              <SetBlock label="Open automatically">
                <Select
                  value={config.newTaskAutoOpen}
                  onChange={(e) => updateConfig({ newTaskAutoOpen: e.target.value as NewTaskAutoOpen })}
                >
                  {newTaskAutoOpenOptions.map((option) => {
                    const available = isAutoOpenAvailable(option.value, config)
                    return (
                      <option key={option.value} value={option.value} disabled={!available}>
                        {available ? option.label : `${option.label} (turned off in AI Tools)`}
                      </option>
                    )
                  })}
                </Select>
                <HelperText>
                  {isAutoOpenAvailable(config.newTaskAutoOpen, config)
                    ? 'Applies to the New task composer (⌘N, or the pencil in the inbox) — the + Task button in the project tree still makes an empty task.'
                    : 'That tool is turned off under AI Tools, so new tasks open nothing. Turn it on there, or pick another option.'}
                </HelperText>
              </SetBlock>
            </FormGroup>
          </>
        )

      case 'tasks': {
        const idle = config.idleTaskCleanup
        const updateIdle = (patch: Partial<IdleTaskCleanupConfig>): void => {
          updateConfig({ idleTaskCleanup: { ...idle, ...patch } })
        }
        const bothRules = idle.byAge.enabled && idle.byCount.enabled
        const noRules = !idle.byAge.enabled && !idle.byCount.enabled

        return (
          <>
            <GrpHead>Idle task cleanup</GrpHead>
            <Group>
              <GroupRow
                label="Automatically delete idle tasks"
                sub="Sweeps at launch and every hour. Deletion is silent, but projects.json is snapshotted into backups/ first."
                trailing={
                  <Switch
                    checked={idle.enabled}
                    onChange={(enabled) => updateIdle({ enabled })}
                  />
                }
              />
            </Group>

            <GrpHead>Rules</GrpHead>
            <Group>
              <GroupRow
                label="Idle longer than"
                sub="Counts anything that happened in the task — your focus or an agent's activity."
                trailing={
                  <>
                    <Field
                      type="number"
                      className="w-20"
                      min={1}
                      max={365}
                      disabled={!idle.byAge.enabled}
                      value={idle.byAge.days}
                      onChange={(e) => updateIdle({
                        byAge: { ...idle.byAge, days: parseNumberInput(e.target.value, 14, 1, 365) }
                      })}
                    />
                    <span className="text-base text-text-muted">days</span>
                    <Switch
                      checked={idle.byAge.enabled}
                      onChange={(enabled) => updateIdle({ byAge: { ...idle.byAge, enabled } })}
                    />
                  </>
                }
              />
              <GroupRow
                label="Project holds more than"
                sub="Least-recently-active first. Every task occupies a slot, even ones cleanup may not delete."
                trailing={
                  <>
                    <Field
                      type="number"
                      className="w-20"
                      min={1}
                      max={500}
                      disabled={!idle.byCount.enabled}
                      value={idle.byCount.maxTasks}
                      onChange={(e) => updateIdle({
                        byCount: { ...idle.byCount, maxTasks: parseNumberInput(e.target.value, 20, 1, 500) }
                      })}
                    />
                    <span className="text-base text-text-muted">tasks</span>
                    <Switch
                      checked={idle.byCount.enabled}
                      onChange={(enabled) => updateIdle({ byCount: { ...idle.byCount, enabled } })}
                    />
                  </>
                }
              />
            </Group>

            <FormGroup>
              <SetBlock label="Match">
                <SegCtl
                  options={[
                    { value: 'and', label: 'Both rules' },
                    { value: 'or', label: 'Either rule' }
                  ] as const}
                  value={idle.combine}
                  disabled={!bothRules}
                  onChange={(combine) => updateIdle({ combine })}
                />
                <HelperText>
                  {noRules
                    ? 'No rule is on, so nothing will ever be deleted.'
                    : !bothRules
                      ? 'Only one rule is on, so it decides on its own.'
                      : idle.combine === 'and'
                        ? 'A task must be both too old and over the cap before it goes.'
                        : 'Either condition alone is enough — the most aggressive setting.'}
                </HelperText>
              </SetBlock>
            </FormGroup>

            <GrpHead>Safeguards</GrpHead>
            <Group>
              <GroupRow
                label="Only delete settled tasks"
                sub="Off means untriaged tasks go too once they are quiet. Unread tasks are never deleted either way."
                trailing={
                  <Switch
                    checked={idle.settledOnly}
                    onChange={(settledOnly) => updateIdle({ settledOnly })}
                  />
                }
              />
              <GroupRow
                label="Also delete spotless workspaces"
                sub="Only when nothing is uncommitted and the branch is merged. Removes the worktree and the merged branch."
                trailing={
                  <Switch
                    checked={idle.includeCleanWorkspaces}
                    onChange={(includeCleanWorkspaces) => updateIdle({ includeCleanWorkspaces })}
                  />
                }
              />
            </Group>
            <HelperText>
              Pinned, snoozed, unread and currently-open tasks are always kept, as is anything
              with a running or waiting agent. Home tasks are never touched.
            </HelperText>

            <FormGroup>
              <Disclosure
                label={
                  cleanupPreview.length === 1
                    ? '1 task matches these rules right now'
                    : `${cleanupPreview.length} tasks match these rules right now`
                }
                open={previewOpen}
                onToggle={() => setPreviewOpen(prev => !prev)}
              >
                {cleanupPreview.length > 0 && (
                  <div className="flex flex-col gap-1 pt-1.5">
                    {cleanupPreview.map(candidate => (
                      <div key={candidate.taskId} className="text-sm text-text-muted truncate">
                        <span className="text-text">{candidate.taskName}</span>
                        {' · '}{candidate.projectName}
                        {candidate.workspace && <span className="text-text-subtle"> · workspace, only if clean</span>}
                      </div>
                    ))}
                  </div>
                )}
              </Disclosure>
              <HelperText>
                {idle.enabled
                  ? 'These go on the next sweep.'
                  : 'Cleanup is off, so nothing will be deleted — this is what would go if you turned it on.'}
              </HelperText>
            </FormGroup>
          </>
        )
      }
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
