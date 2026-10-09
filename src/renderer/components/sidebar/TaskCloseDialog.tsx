import React, { useCallback, useEffect, useRef, useState } from 'react'
import { HelperText, LinkBtn, Modal, PrimaryButton } from '../ui'
import type { TaskLandingCloseQuestion } from './closeRules'

export type TaskCloseChoice = 'land' | 'keep-branch' | 'discard' | 'cancel'

/**
 * The close question for a task with a worktree of its own: Land & close (the
 * default, Enter), Keep branch, Discard, or Cancel (Escape). `ask` resolves
 * with the choice; `dialog` is rendered by the caller.
 */
export function useTaskCloseChoice(): {
  ask: (question: TaskLandingCloseQuestion) => Promise<TaskCloseChoice>
  dialog: React.ReactElement | null
} {
  const [question, setQuestion] = useState<TaskLandingCloseQuestion | null>(null)
  const resolveRef = useRef<((choice: TaskCloseChoice) => void) | null>(null)

  const settle = useCallback((choice: TaskCloseChoice) => {
    const resolve = resolveRef.current
    resolveRef.current = null
    setQuestion(null)
    resolve?.(choice)
  }, [])

  const ask = useCallback((next: TaskLandingCloseQuestion) => {
    resolveRef.current?.('cancel')
    return new Promise<TaskCloseChoice>(resolve => {
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
      width="w-[480px]"
      onClose={() => settle('cancel')}
      footer={
        <>
          <LinkBtn onClick={() => settle('cancel')}>Cancel</LinkBtn>
          <LinkBtn danger onClick={() => settle('discard')}>Discard</LinkBtn>
          <LinkBtn onClick={() => settle('keep-branch')}>Keep branch</LinkBtn>
          <span title={question.landBlocked ?? undefined}>
            <PrimaryButton onClick={() => settle('land')} disabled={!canLand}>Land &amp; close</PrimaryButton>
          </span>
        </>
      }
    >
      <div className="text-base text-text" data-testid="task-close-summary">{question.message}</div>
      <HelperText>
        Keep branch commits what is uncommitted and leaves <span className="font-mono">{question.branch}</span> in
        the repository, without landing it. Discard deletes the branch and the uncommitted work.
      </HelperText>
    </Modal>
  )

  return { ask, dialog: dialog || null }
}
