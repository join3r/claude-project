import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import { isRemoteProject, isShellCommandProject, AI_TAB_TYPES } from '../../shared/types'
import type { Project } from '../../shared/types'
import { useTabStatusStore } from '../context/TabStatusContext'

interface SearchResult {
  type: 'project' | 'task'
  projectId: string
  taskId?: string
  name: string
  context: string
}

interface ProjectSwitcherProps {
  projects: Project[]
  setSelectedProjectId: (id: string) => void
  switchToTask: (projectId: string, taskId: string) => void
  isActive: boolean
  onDeactivate: () => void
}

export default function ProjectSwitcher({
  projects,
  setSelectedProjectId,
  switchToTask,
  isActive,
  onDeactivate
}: ProjectSwitcherProps): React.ReactElement | null {
  const [query, setQuery] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const previousFocusRef = useRef<Element | null>(null)
  const resultsRef = useRef<HTMLDivElement>(null)
  const tabStatusStore = useTabStatusStore()

  const allResults = useMemo((): SearchResult[] => {
    const projectResults: SearchResult[] = []
    const taskResults: SearchResult[] = []
    for (const project of projects) {
      let context = project.directory
      if (isRemoteProject(project) && project.ssh) {
        context = project.ssh.remoteDir || project.ssh.host
      } else if (isShellCommandProject(project) && project.shellCommand) {
        context = project.shellCommand.command || 'Shell command'
      }
      projectResults.push({
        type: 'project',
        projectId: project.id,
        name: project.name,
        context
      })
      for (const task of project.tasks) {
        taskResults.push({
          type: 'task',
          projectId: project.id,
          taskId: task.id,
          name: task.name,
          context: project.name
        })
      }
    }
    return [...projectResults, ...taskResults]
  }, [projects])

  const filteredResults = useMemo(() => {
    if (!query) return allResults
    const q = query.toLowerCase()
    return allResults.filter(r => r.name.toLowerCase().includes(q))
  }, [allResults, query])

  // Reset selection when results change
  useEffect(() => {
    setSelectedIndex(0)
  }, [filteredResults.length, query])

  // Focus input when activated
  useEffect(() => {
    if (isActive) {
      previousFocusRef.current = document.activeElement
      inputRef.current?.focus()
    }
  }, [isActive])

  // Click-outside to deactivate
  useEffect(() => {
    if (!isActive) return
    const handleMouseDown = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        handleDeactivate()
      }
    }
    document.addEventListener('mousedown', handleMouseDown)
    return () => document.removeEventListener('mousedown', handleMouseDown)
  }, [isActive])

  // Scroll selected item into view
  useEffect(() => {
    if (!isActive || !resultsRef.current) return
    const selected = resultsRef.current.children[selectedIndex] as HTMLElement | undefined
    selected?.scrollIntoView({ block: 'nearest' })
  }, [selectedIndex, isActive])

  const handleDeactivate = useCallback(() => {
    setQuery('')
    setSelectedIndex(0)
    onDeactivate()
    // Return focus to previously focused element
    if (previousFocusRef.current && previousFocusRef.current instanceof HTMLElement) {
      previousFocusRef.current.focus()
    }
  }, [onDeactivate])

  const handleSelect = useCallback((result: SearchResult) => {
    if (result.type === 'project') {
      setSelectedProjectId(result.projectId)
    } else if (result.taskId) {
      switchToTask(result.projectId, result.taskId)
      // Clear attention state on target task's AI tabs
      const project = projects.find(p => p.id === result.projectId)
      const task = project?.tasks.find(t => t.id === result.taskId)
      if (task) {
        const aiTabs = [...task.tabs.left, ...task.tabs.right]
          .filter(t => (AI_TAB_TYPES as readonly string[]).includes(t.type))
        for (const tab of aiTabs) {
          if (tabStatusStore.getStatus(tab.id) === 'attention') {
            tabStatusStore.setStatus(tab.id, null)
          }
        }
      }
    }
    handleDeactivate()
  }, [setSelectedProjectId, switchToTask, projects, tabStatusStore, handleDeactivate])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelectedIndex(prev => Math.min(prev + 1, filteredResults.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelectedIndex(prev => Math.max(prev - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (filteredResults[selectedIndex]) {
        handleSelect(filteredResults[selectedIndex])
      }
    } else if (e.key === 'Escape') {
      e.preventDefault()
      handleDeactivate()
    }
  }, [filteredResults, selectedIndex, handleSelect, handleDeactivate])

  if (!isActive) return null

  return (
    /* Backdrop */
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh] bg-black/60 [-webkit-app-region:no-drag]"
      onClick={handleDeactivate}
    >
      {/* Card */}
      <div
        ref={containerRef}
        className="w-[440px] max-w-[90vw] rounded-xl border border-border bg-surface-2 shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Body */}
        <div className="p-3 flex flex-col gap-2 max-h-[60vh]">
          {/* Input wrapper */}
          <div className="relative flex items-center">
            <input
              ref={inputRef}
              className="w-full h-9 px-3 rounded-md bg-surface border border-border text-text text-[13px] outline-none focus:border-border-focus"
              placeholder="Search projects and tasks..."
              value={query}
              onChange={e => setQuery(e.target.value)}
              onKeyDown={handleKeyDown}
            />
            <span className="absolute right-2 text-[10px] text-text-subtle pointer-events-none px-1.5 py-px rounded bg-surface-3">
              esc
            </span>
          </div>
          {/* Results */}
          <div className="flex-1 overflow-y-auto -mx-1 px-1" ref={resultsRef}>
            {filteredResults.length === 0 ? (
              <div className="p-3 text-center text-text-muted text-[12px]">No results</div>
            ) : (
              filteredResults.map((result, i) => (
                <div
                  key={result.type + ':' + (result.taskId || result.projectId)}
                  data-active={i === selectedIndex ? 'true' : undefined}
                  className={[
                    'px-3 py-1.5 rounded-md cursor-pointer text-[12px] text-text',
                    // Selection rail recipe
                    'data-[active=true]:relative',
                    'data-[active=true]:before:absolute data-[active=true]:before:inset-y-0 data-[active=true]:before:left-0',
                    'data-[active=true]:before:w-0.5 data-[active=true]:before:bg-accent-400',
                    'data-[active=true]:bg-gradient-to-r data-[active=true]:from-accent-600/30 data-[active=true]:to-transparent',
                    'data-[active=true]:text-accent-50',
                    '[.theme-light_&[data-active=true]]:from-accent-200',
                    '[.theme-light_&[data-active=true]]:text-accent-700',
                  ].join(' ')}
                  onClick={() => handleSelect(result)}
                  onMouseEnter={() => setSelectedIndex(i)}
                >
                  <div className="flex items-center gap-1.5">
                    <span className={[
                      'overflow-hidden text-ellipsis whitespace-nowrap',
                      result.type === 'project' ? 'font-semibold' : ''
                    ].join(' ').trim()}>
                      {result.name}
                    </span>
                    <span className="text-[9px] px-1 py-px rounded-sm bg-surface-3 text-text-muted shrink-0 ml-auto uppercase tracking-wide">
                      {result.type}
                    </span>
                  </div>
                  <div className="text-[10px] text-text-muted overflow-hidden text-ellipsis whitespace-nowrap mt-0.5">
                    {result.context}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
