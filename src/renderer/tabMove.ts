import type { Tab, TaskViewState } from '../shared/types'

export type TabPane = 'left' | 'right'

export interface MoveTabResult {
  moved: boolean
  tabs: {
    left: Tab[]
    right: Tab[]
  }
  taskState: TaskViewState
}

interface MoveTabParams {
  tabs: {
    left: Tab[]
    right: Tab[]
  }
  taskState: TaskViewState
  fromPane: TabPane
  tabId: string
  toPane: TabPane
  toIndex: number
}

function clampInsertIndex(index: number, length: number): number {
  return Math.max(0, Math.min(length, index))
}

export function moveTaskTab({
  tabs,
  taskState,
  fromPane,
  tabId,
  toPane,
  toIndex
}: MoveTabParams): MoveTabResult {
  const sourceTabs = tabs[fromPane]
  const fromIndex = sourceTabs.findIndex((tab) => tab.id === tabId)
  if (fromIndex === -1) {
    return { moved: false, tabs, taskState }
  }

  const movedTab = sourceTabs[fromIndex]

  if (fromPane === toPane) {
    const insertIndex = clampInsertIndex(toIndex, sourceTabs.length)
    const nextIndex = insertIndex > fromIndex ? insertIndex - 1 : insertIndex

    if (nextIndex === fromIndex) {
      return { moved: false, tabs, taskState }
    }

    const nextPaneTabs = [...sourceTabs]
    nextPaneTabs.splice(fromIndex, 1)
    nextPaneTabs.splice(nextIndex, 0, movedTab)

    return {
      moved: true,
      tabs: {
        ...tabs,
        [fromPane]: nextPaneTabs
      },
      taskState
    }
  }

  const destinationTabs = tabs[toPane]
  const nextSourceTabs = [...sourceTabs]
  nextSourceTabs.splice(fromIndex, 1)

  const nextDestinationTabs = [...destinationTabs]
  nextDestinationTabs.splice(clampInsertIndex(toIndex, destinationTabs.length), 0, movedTab)

  return {
    moved: true,
    tabs: {
      ...tabs,
      [fromPane]: nextSourceTabs,
      [toPane]: nextDestinationTabs
    },
    taskState: {
      ...taskState,
      activeTab: {
        ...taskState.activeTab,
        [fromPane]: taskState.activeTab[fromPane] === tabId
          ? (nextSourceTabs[nextSourceTabs.length - 1]?.id ?? null)
          : taskState.activeTab[fromPane],
        [toPane]: tabId
      }
    }
  }
}
