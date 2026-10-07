import React, { useCallback, useEffect, useRef, useState } from 'react'
import { HelperText, LinkBtn, Modal, PrimaryButton } from '../ui'
import type { WorktreeChoice } from './closeRules'

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
