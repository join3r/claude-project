// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { reopenStreamWithSetup } from '../src/renderer/components/sidebar/doneActions'
import { closeEntityDialog, getEntityDialog } from '../src/renderer/entityActions'

/**
 * Reopening an archived stream goes through one path from the tree's Done rows
 * and from the archived stream's page: its worktree's setup waits for approval.
 */
describe('reopenStreamWithSetup', () => {
  afterEach(() => {
    closeEntityDialog()
    vi.unstubAllGlobals()
  })

  it('asks to approve the reopened worktree\'s setup', async () => {
    const pending = { commands: ['npm ci'] } as never
    const reopen = vi.fn().mockResolvedValue({ reopened: true, setup: { branch: 'feat', pending } })
    await reopenStreamWithSetup(reopen, 'p1', 's1')
    expect(reopen).toHaveBeenCalledWith('p1', 's1')
    expect(getEntityDialog()).toEqual({ kind: 'stream-setup', projectId: 'p1', streamId: 's1', branch: 'feat', pending })
  })

  it('says the notice and a failed setup, and opens nothing', async () => {
    const alert = vi.fn()
    vi.stubGlobal('alert', alert)
    const reopen = vi.fn().mockResolvedValue({ reopened: true, notice: 'Its branch is gone.', setup: { branch: 'feat', error: 'boom' } })
    await reopenStreamWithSetup(reopen, 'p1', 's1')
    expect(alert.mock.calls.map(call => call[0])).toEqual(['Its branch is gone.', expect.stringMatching(/setup failed:\n\nboom$/)])
    expect(getEntityDialog()).toBeNull()
  })

  it('rejects when the reopen fails', async () => {
    const reopen = vi.fn().mockRejectedValue(new Error('nope'))
    await expect(reopenStreamWithSetup(reopen, 'p1', 's1')).rejects.toThrow('nope')
  })
})
