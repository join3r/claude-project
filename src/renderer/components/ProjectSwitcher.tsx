import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import { isRemoteProject, isShellCommandProject, AI_TAB_TYPES } from '../../shared/types'
import type { Project } from '../../shared/types'
import { useTabStatusStore } from '../context/TabStatusContext'
import './ProjectSwitcher.css'

interface SearchResult {
  type: 'project' | 'task'
  projectId: string
  taskId?: string
  name: string
  context: string
}

interface ProjectSwitcherProps {
  projects: Project[]
  selectedProjectId: string | null
  setSelectedProjectId: (id: string) => void
  switchToTask: (projectId: string, taskId: string) => void
  isActive: boolean
  onActivate: () => void
  onDeactivate: () => void
}

export default function ProjectSwitcher({
  projects,
  selectedProjectId,
  setSelectedProjectId,
  switchToTask,
  isActive,
  onActivate,
  onDeactivate
}: ProjectSwitcherProps): React.ReactElement {
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

  if (!isActive) {
    return (
      <div className="project-switcher">
        <div className="project-switcher-input-wrapper">
          <input
            className="project-switcher-input"
            placeholder="Search..."
            readOnly
            onClick={onActivate}
          />
          <span className="project-switcher-hint">&#8984;P</span>
        </div>
      </div>
    )
  }

  return (
    <div className="project-switcher" ref={containerRef}>
      <div className="project-switcher-input-wrapper">
        <input
          ref={inputRef}
          className="project-switcher-input"
          placeholder="Search projects and tasks..."
          value={query}
          onChange={e => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
        />
        <span className="project-switcher-hint">esc</span>
      </div>
      <div className="project-switcher-results" ref={resultsRef}>
        {filteredResults.length === 0 ? (
          <div className="project-switcher-empty">No results</div>
        ) : (
          filteredResults.map((result, i) => (
            <div
              key={result.type + ':' + (result.taskId || result.projectId)}
              className={`project-switcher-row ${i === selectedIndex ? 'selected' : ''}`}
              onClick={() => handleSelect(result)}
              onMouseEnter={() => setSelectedIndex(i)}
            >
              <span className={`project-switcher-row-name ${result.type === 'project' ? 'is-project' : ''}`}>
                {result.name}
              </span>
              <span className="project-switcher-badge">{result.type}</span>
              <span className="project-switcher-context">{result.context}</span>
            </div>
          ))
        )}
      </div>
    </div>
  )
}
