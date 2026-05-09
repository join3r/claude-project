import React from 'react'
import { useApp } from '../context/AppContext'
import TabBar from './TabBar'
import TerminalTab from './TerminalTab'
import BrowserTab from './BrowserTab'
import AiToolTab from './AiToolTab'
import DiffTab from './DiffTab'
import EditorTab from './EditorTab'
import NoteTab from './NoteTab'
import { ProjectHome } from './ProjectHome'
import { AI_TAB_TYPES } from '../../shared/types'
import type { Tab, AiTabType, SshConfig, ShellCommandConfig } from '../../shared/types'
import type { PaneSide } from './paneFocus'
import type { TabDragState, TabDropTarget } from './tabDrag'

interface Props {
  tabs: Tab[]
  activeTabId: string | null
  taskVisible: boolean
  pane: 'left' | 'right'
  projectId: string
  taskId: string
  projectDir: string
  sshConfig?: SshConfig
  shellCommand?: ShellCommandConfig
  aiToolArgs?: Partial<Record<AiTabType, string>>
  style?: React.CSSProperties
  onPaneFocus?: (pane: PaneSide) => void
  tabDragState: TabDragState | null
  tabDropTarget: TabDropTarget | null
  onTabDragStateChange: (dragState: TabDragState | null) => void
  onTabDropTargetChange: (dropTarget: TabDropTarget | null) => void
  onTabDragComplete?: (pane: PaneSide) => void
}

export default function Pane({
  tabs,
  activeTabId,
  taskVisible,
  pane,
  projectId,
  taskId,
  projectDir,
  sshConfig,
  shellCommand,
  aiToolArgs,
  style,
  onPaneFocus,
  tabDragState,
  tabDropTarget,
  onTabDragStateChange,
  onTabDropTargetChange,
  onTabDragComplete
}: Props): React.ReactElement {
  const { effectiveTheme } = useApp()
  const isEmptyDropTarget = tabs.length === 0 && tabDropTarget?.pane === pane

  return (
    <div
      className={`pane flex-1 flex flex-col overflow-hidden min-w-0${isEmptyDropTarget ? ' shadow-[inset_0_0_0_1px_var(--color-accent-400)]' : ''}`}
      style={style}
      data-pane={pane}
      data-project-id={projectId}
      data-task-id={taskId}
      onMouseDownCapture={() => onPaneFocus?.(pane)}
      onFocusCapture={() => onPaneFocus?.(pane)}
    >
      <TabBar
        tabs={tabs}
        activeTabId={activeTabId}
        pane={pane}
        projectId={projectId}
        taskId={taskId}
        tabDragState={tabDragState}
        tabDropTarget={tabDropTarget}
        onTabDragStateChange={onTabDragStateChange}
        onTabDropTargetChange={onTabDropTargetChange}
        onTabDragComplete={onTabDragComplete}
      />
      <div className="flex-1 overflow-hidden relative">
        {tabs.length === 0 && (
          <div className="flex-1 flex items-center justify-center h-full text-text-muted text-[13px]">Open a terminal or browser tab</div>
        )}
        {tabs.map((tab) => {
          if (tab.type === 'terminal') {
            return (
              <TerminalTab
                key={tab.id}
                tabId={tab.id}
                visible={taskVisible && tab.id === activeTabId}
                projectId={projectId}
                taskId={taskId}
                pane={pane}
                projectDir={projectDir}
                sshConfig={sshConfig}
                shellCommand={shellCommand}
              />
            )
          }
          if (tab.type === 'browser') {
            return (
              <BrowserTab
                key={tab.id}
                tabId={tab.id}
                visible={taskVisible && tab.id === activeTabId}
                initialUrl={tab.url}
                projectId={projectId}
                taskId={taskId}
                pane={pane}
                sshConfig={sshConfig}
              />
            )
          }
          if ((AI_TAB_TYPES as readonly string[]).includes(tab.type)) {
            return (
              <AiToolTab
                key={tab.id}
                tabId={tab.id}
                toolType={tab.type as AiTabType}
                visible={taskVisible && tab.id === activeTabId}
                sessionId={tab.sessionId}
                pane={pane}
                projectId={projectId}
                taskId={taskId}
                projectDir={projectDir}
                sshConfig={sshConfig}
                extraArgs={aiToolArgs?.[tab.type as AiTabType]}
              />
            )
          }
          if (tab.type === 'diff' && tab.filePath) {
            return (
              <DiffTab
                key={tab.id}
                tabId={tab.id}
                visible={taskVisible && tab.id === activeTabId}
                filePath={tab.filePath}
                projectDir={projectDir}
                effectiveTheme={effectiveTheme}
              />
            )
          }
          if (tab.type === 'editor' && tab.filePath) {
            return (
              <EditorTab
                key={tab.id}
                tabId={tab.id}
                visible={taskVisible && tab.id === activeTabId}
                filePath={tab.filePath}
                projectDir={projectDir}
                projectId={projectId}
                taskId={taskId}
                pane={pane}
                effectiveTheme={effectiveTheme}
              />
            )
          }
          if (tab.type === 'home') {
            return (
              <div
                key={tab.id}
                className="absolute inset-0 overflow-hidden"
                style={{ display: taskVisible && tab.id === activeTabId ? 'flex' : 'none' }}
              >
                <ProjectHome projectId={projectId} />
              </div>
            )
          }
          if (tab.type === 'note' && tab.noteId) {
            return (
              <NoteTab
                key={tab.id}
                noteId={tab.noteId}
                projectId={projectId}
                taskId={taskId}
                visible={taskVisible && tab.id === activeTabId}
                effectiveTheme={effectiveTheme}
              />
            )
          }
          return null
        })}
      </div>
    </div>
  )
}
