import React, { useEffect } from 'react'
import { useApp } from '../context/AppContext'
import { Modal, LinkBtn, PrimaryButton, HelperText } from './ui'

/**
 * The one thing standing between an unsaved buffer and a closed tab. Every
 * removal path (⌘W, the tab-bar close button, task and project deletion) parks
 * on this dialog when an editor beneath it is dirty; Cancel abandons the whole
 * removal, not just this file.
 */
export default function UnsavedChangesModal(): React.ReactElement | null {
  const { dirtyPrompt, resolveDirtyPrompt } = useApp()
  const saving = dirtyPrompt?.saving ?? false

  useEffect(() => {
    if (!dirtyPrompt) return
    const onKeyDown = (e: KeyboardEvent): void => {
      // Escaping mid-write would settle the removal while the writes carry on.
      if (e.key === 'Escape' && !saving) void resolveDirtyPrompt('cancel')
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [dirtyPrompt, saving, resolveDirtyPrompt])

  if (!dirtyPrompt) return null
  const { files, error } = dirtyPrompt

  return (
    <Modal
      title="Unsaved changes"
      onClose={() => { if (!saving) void resolveDirtyPrompt('cancel') }}
      footer={
        <>
          <LinkBtn onClick={() => void resolveDirtyPrompt('cancel')} disabled={saving}>Cancel</LinkBtn>
          <LinkBtn danger onClick={() => void resolveDirtyPrompt('discard')} disabled={saving}>Discard</LinkBtn>
          <PrimaryButton onClick={() => void resolveDirtyPrompt('save')} disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </PrimaryButton>
        </>
      }
    >
      <HelperText>
        {files.length === 1
          ? 'This file has changes that are not on disk yet:'
          : `${files.length} files have changes that are not on disk yet:`}
      </HelperText>
      <ul className="m-0 pl-4 flex flex-col gap-1 max-h-[160px] overflow-y-auto text-base text-text">
        {files.map((file, i) => (
          <li key={`${file}-${i}`} className="truncate" title={file}>{file}</li>
        ))}
      </ul>
      {error && <HelperText><span className="text-danger">{error}</span></HelperText>}
    </Modal>
  )
}
