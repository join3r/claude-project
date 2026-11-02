import React from 'react'
import { useApp } from '../context/AppContext'
import { Modal, LinkBtn, PrimaryButton, HelperText } from './ui'

/**
 * Asked once, on a fresh install (`mainTaskWorktreesAsked` false): whether new
 * tasks in a project's main get worktrees of their own. The answer sets the
 * same switch as Settings → Worktrees on main. Closing the dialog keeps it off.
 */
export default function FirstRunWorktreesPrompt(): React.ReactElement | null {
  const { config, updateConfig, setMainTaskWorktreesEverywhere } = useApp()
  if (!config || config.mainTaskWorktreesAsked) return null

  const answer = (on: boolean): void => {
    updateConfig({ mainTaskWorktrees: on, mainTaskWorktreesAsked: true })
    setMainTaskWorktreesEverywhere(on)
  }

  return (
    <Modal
      title="Give each task its own worktree?"
      onClose={() => answer(false)}
      width="w-[480px]"
      footer={
        <>
          <LinkBtn onClick={() => answer(false)}>Work in the project folder</LinkBtn>
          <PrimaryButton onClick={() => answer(true)}>Use worktrees</PrimaryButton>
        </>
      }
    >
      <div className="text-sm text-text flex flex-col gap-2">
        <p className="m-0">
          <b>Worktrees:</b> every new task gets its own git worktree and branch, off the project folder&apos;s branch.
          Tasks can run side by side without touching each other&apos;s files. When a task is done, DevTool lands it back
          as one commit.
        </p>
        <p className="m-0">
          <b>Project folder:</b> every task works directly in the project folder, on whatever branch is checked out.
        </p>
      </div>
      <HelperText>You can change this later in Settings (Worktrees on main) or per project in Project Settings.</HelperText>
    </Modal>
  )
}
