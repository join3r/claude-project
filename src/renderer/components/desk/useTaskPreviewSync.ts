import { useEffect } from 'react'
import { useApp } from '../../context/AppContext'
import { useAllAgentActivity } from '../../agentActivity'
import { projectTasks, taskTabs } from '../../../shared/streams'

/**
 * Copies each task's latest agent answer (`AgentActivity.lastAnswer`) onto the
 * task (`TaskInboxState.preview`), so the desk inbox still previews it after a
 * restart. Runs in both layouts, so switching to desk finds previews waiting.
 */
export function useTaskPreviewSync(): void {
  const { projects, setTaskPreview } = useApp()
  const activities = useAllAgentActivity()
  useEffect(() => {
    for (const project of projects) {
      for (const task of projectTasks(project)) {
        let latest: { answer: string; at: number } | null = null
        for (const tab of taskTabs(task)) {
          const activity = activities[tab.id]
          if (activity?.lastAnswer && (!latest || activity.updatedAt > latest.at)) latest = { answer: activity.lastAnswer, at: activity.updatedAt }
        }
        if (latest && task.inbox?.preview !== latest.answer) setTaskPreview(project.id, task.id, latest.answer)
      }
    }
  }, [projects, activities, setTaskPreview])
}
