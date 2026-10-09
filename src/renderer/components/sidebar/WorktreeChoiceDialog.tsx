import React, { useCallback, useEffect, useRef, useState } from 'react'
import { HelperText, LinkBtn, Modal, PrimaryButton } from '../ui'
import type { StreamTasksCloseQuestion, WorktreeChoice } from './closeRules'

interface Question {
  title: string
  message: string
  branch: string
}

/**
 * The stream-close question for a worktree with work in it: keep the branch
 * (the worktree folder goes, its commits stay), discard both, or cancel.
 * `ask` resolves with the choice; `dialog` is rendered by the caller.
 */
export function useWorktreeChoice(): { ask: (question: Question) => Promise<WorktreeChoice>; dialog: React.ReactElement | null } {
  const [question, setQuestion] = useState<Question | null>(null)
  const resolveRef = useRef<((choice: WorktreeChoice) => void) | null>(null)

  const settle = useCallback((choice: WorktreeChoice) => {
    const resolve = resolveRef.current
    resolveRef.current = null
    setQuestion(null)
    resolve?.(choice)
  }, [])

  const ask = useCallback((next: Question) => {
    resolveRef.current?.('cancel')
    return new Promise<WorktreeChoice>(resolve => {
      resolveRef.current = resolve
      setQuestion(next)
    })
  }, [])

  useEffect(() => {
    if (!question) return
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') settle('cancel')
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [question, settle])

  const dialog = question && (
    <Modal
      title={question.title}
      onClose={() => settle('cancel')}
      footer={
        <>
          <LinkBtn onClick={() => settle('cancel')}>Cancel</LinkBtn>
          <LinkBtn danger onClick={() => settle('discard')}>Discard branch</LinkBtn>
          <PrimaryButton onClick={() => settle('keep-branch')}>Keep branch</PrimaryButton>
        </>
      }
    >
      <HelperText>{question.message}</HelperText>
      <HelperText>
        Keep branch removes the worktree folder and leaves <span className="font-mono">{question.branch}</span> in
        the repository. Discard branch deletes both.
      </HelperText>
    </Modal>
  )

  return { ask, dialog: dialog || null }
}

export type StreamTasksChoice = 'land' | 'keep-branch' | 'discard' | 'cancel'

/**
 * The stream-close question when tasks of the stream have worktrees with work
 * not landed: one list of those tasks, then Land all, then close (the default,
 * Enter), Keep branches, Discard all, or Cancel (Escape). `ask` resolves with
 * the choice; `dialog` is rendered by the caller.
 */
export function useStreamTasksChoice(): {
  ask: (question: StreamTasksCloseQuestion) => Promise<StreamTasksChoice>
  dialog: React.ReactElement | null
} {
  const [question, setQuestion] = useState<StreamTasksCloseQuestion | null>(null)
  const resolveRef = useRef<((choice: StreamTasksChoice) => void) | null>(null)

  const settle = useCallback((choice: StreamTasksChoice) => {
    const resolve = resolveRef.current
    resolveRef.current = null
    setQuestion(null)
    resolve?.(choice)
  }, [])

  const ask = useCallback((next: StreamTasksCloseQuestion) => {
    resolveRef.current?.('cancel')
    return new Promise<StreamTasksChoice>(resolve => {
      resolveRef.current = resolve
      setQuestion(next)
    })
  }, [])

  const canLand = !!question && question.landBlocked === null
  useEffect(() => {
    if (!question) return
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') settle('cancel')
      // Enter on a focused button is that button's click.
      else if (e.key === 'Enter' && canLand && !(e.target instanceof HTMLButtonElement)) {
        e.preventDefault()
        settle('land')
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [question, canLand, settle])

  const dialog = question && (
    <Modal
      title={question.title}
      width="w-[520px]"
      onClose={() => settle('cancel')}
      footer={
        <>
          <LinkBtn onClick={() => settle('cancel')}>Cancel</LinkBtn>
          <LinkBtn danger onClick={() => settle('discard')}>Discard all</LinkBtn>
          <LinkBtn onClick={() => settle('keep-branch')}>Keep branches</LinkBtn>
          <span title={question.landBlocked ?? undefined}>
            <PrimaryButton onClick={() => settle('land')} disabled={!canLand}>Land all, then close</PrimaryButton>
          </span>
        </>
      }
    >
      <div className="text-base text-text">
        {question.tasks.length === 1 ? 'A task has' : `${question.tasks.length} tasks have`} work not landed into {question.streamName}:
      </div>
      <ul className="flex flex-col gap-1 text-base" data-testid="stream-close-tasks">
        {question.tasks.map(task => (
          <li key={task.taskId} className="min-w-0">
            <span className="text-text">{task.name}</span>
            <span className="text-text-muted"> · {task.holds}</span>
          </li>
        ))}
      </ul>
      <HelperText>
        Land all squashes each task into {question.streamName} in this order and stops at the first conflict, with
        the stream left open. Keep branches commits what is uncommitted and leaves each task&apos;s branch in the
        repository; reopening the stream brings their worktrees back. Discard all deletes the branches and the
        uncommitted work.
      </HelperText>
    </Modal>
  )

  return { ask, dialog: dialog || null }
}
