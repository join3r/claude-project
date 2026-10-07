// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import {
  focusedPaneOf,
  getFocusedPane,
  paneIndexOfElement,
  resolvePaneRef,
  setFocusedPane
} from '../src/renderer/components/paneFocus'
import type { Tab, Task } from '../src/shared/types'

const tab = (id: string): Tab => ({ id, type: 'terminal', title: id })
const task: Task = {
  id: 'focus-task',
  name: 't',
  panes: [
    { tabs: [tab('a')], activeTabId: 'a', width: 0.5 },
    { tabs: [tab('b'), tab('c')], activeTabId: 'b', width: 0.5 }
  ]
}

describe('pane focus', () => {
  it('starts on the first pane and remembers the focused one per task', () => {
    expect(getFocusedPane('never-seen')).toBe(0)
    setFocusedPane(task.id, 1)
    expect(getFocusedPane(task.id)).toBe(1)
    expect(getFocusedPane('other')).toBe(0)
  })

  it('clamps a remembered pane that has since closed', () => {
    setFocusedPane(task.id, 5)
    expect(focusedPaneOf(task)).toBe(1)
  })

  it('resolves pane references', () => {
    setFocusedPane(task.id, 0)
    expect(resolvePaneRef(task, 1)).toBe(1)
    expect(resolvePaneRef(task, 'focused')).toBe(0)
    expect(resolvePaneRef(task, { withTab: 'c' })).toBe(1)
    expect(resolvePaneRef(task, { withTab: 'gone' })).toBe(0)
  })

  it('reads the pane index off the DOM', () => {
    const root = document.createElement('div')
    root.innerHTML = '<div data-pane-index="2"><span id="inner"></span></div><span id="outside"></span>'
    expect(paneIndexOfElement(root.querySelector('#inner'))).toBe(2)
    expect(paneIndexOfElement(root.querySelector('#outside'))).toBeNull()
    expect(paneIndexOfElement(null)).toBeNull()
  })
})
