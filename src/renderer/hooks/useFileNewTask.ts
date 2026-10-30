import { useCallback } from 'react'
import { NEW_TASK_NAME, type Task } from '../../shared/types'
import { useApp } from '../context/AppContext'
import { terminalTaskName, type NewTaskSubmission } from '../components/newTask'
import { setPendingCommand } from '../components/terminalStartup'
import { createTab } from '../components/newTaskTabs'
import { agentTakesMode, setPendingPrompt, taskNameFromPrompt } from '../components/promptBox'

/**
 * File what a composer asked for (the New task dialog, the desk's compose box,
 * the ⌘K bar). A task that starts an agent is born with the agent's tab already
 * in it; the tab picks the prompt up on its first spawn. The new task is selected.
 */
export function useFileNewTask(): (submission: NewTaskSubmission) => Task {
  const { addTask, addTaskInDirectory, titleTaskFromPrompt, updateConfig } = useApp()
  return useCallback(({ target, streamId, start, terminal, autopilot }: NewTaskSubmission) => {
    let tabs: ReturnType<typeof createTab>[] = []
    let name = NEW_TASK_NAME
    if (terminal) {
      const tab = createTab('terminal')
      if (terminal.command) setPendingCommand(tab.id, terminal.command)
      tabs = [tab]
      name = terminalTaskName(terminal.command)
    } else if (start) {
      const tab = createTab(start.agent)
      setPendingPrompt(tab.id, start.prompt)
      updateConfig({
        promptBoxAgent: start.agent,
        ...(agentTakesMode(start.agent) ? { promptBoxMode: start.prompt.mode ?? '' } : {})
      })
      tabs = [tab]
      name = taskNameFromPrompt(start.prompt.text)
    }
    const task = target.kind === 'dir'
      ? addTaskInDirectory(target.directory, name, tabs)
      : addTask(target.projectId, name, tabs, streamId, autopilot && start?.agent === 'claude-chat'
        ? { autopilot: { phase: 'working', ...(autopilot.review ? { review: true } : {}) } }
        : undefined)
    if (start) titleTaskFromPrompt(task.id, name, start.prompt.text)
    return task
  }, [addTask, addTaskInDirectory, titleTaskFromPrompt, updateConfig])
}
