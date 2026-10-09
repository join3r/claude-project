// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import ServerIdeConsentModal from '../src/renderer/components/servers/ServerIdeConsentModal'
import { openWorkspaceInIde } from '../src/renderer/openWorkspaceInIde'
import type { ServerIdeState } from '../src/shared/server-ide'

void React

/** Open in IDE on a server project, first use: ask, then set up, then open (plan step 9). */

const SERVER = 'ab'.repeat(16)
const needs: ServerIdeState = {
  serverId: SERVER, serverName: 'devbox', needsInclude: true, needsKey: true,
  userSshConfig: '/Users/me/.ssh/config', devtoolSshConfig: '/Users/me/.devtool/ssh/config'
}

beforeEach(() => {
  ;(window as any).api = {
    serverIdeState: vi.fn().mockResolvedValue(needs),
    serverIdeSetup: vi.fn().mockResolvedValue({ ...needs, needsInclude: false, needsKey: false }),
    openInIde: vi.fn().mockResolvedValue(undefined)
  }
})

afterEach(() => cleanup())

describe('Open in IDE consent', () => {
  it('asks in two parts, sets up what was agreed, then opens', async () => {
    render(<ServerIdeConsentModal />)
    const result = openWorkspaceInIde('code', '/home/dev/app', 'p1', SERVER)
    await waitFor(() => expect(screen.getByText('Open in IDE on devbox')).toBeTruthy())
    expect(screen.getByText(/Include ~\/\.devtool\/ssh\/config/)).toBeTruthy()
    expect(screen.getByText(/authorized_keys/)).toBeTruthy()
    expect((window as any).api.serverIdeSetup).not.toHaveBeenCalled()
    fireEvent.click(screen.getByText('Allow and open'))
    expect(await result).toBeNull()
    expect((window as any).api.serverIdeSetup).toHaveBeenCalledWith('p1', { include: true, key: true })
    expect((window as any).api.openInIde).toHaveBeenCalledWith('code', '/home/dev/app', 'p1')
  })

  it('changes nothing when declined', async () => {
    render(<ServerIdeConsentModal />)
    const result = openWorkspaceInIde('code', '/home/dev/app', 'p1', SERVER)
    await waitFor(() => expect(screen.getByText('Cancel')).toBeTruthy())
    fireEvent.click(screen.getByText('Cancel'))
    expect(await result).toBeNull()
    expect((window as any).api.serverIdeSetup).not.toHaveBeenCalled()
    expect((window as any).api.openInIde).not.toHaveBeenCalled()
  })

  it('opens at once once set up, and shows the plain message when the server has no sshd', async () => {
    ;(window as any).api.serverIdeState.mockResolvedValueOnce({ ...needs, needsInclude: false, needsKey: false })
    expect(await openWorkspaceInIde('code', '/srv', 'p1', SERVER)).toBeNull()
    expect((window as any).api.openInIde).toHaveBeenCalledTimes(1)
    ;(window as any).api.serverIdeState.mockRejectedValueOnce(new Error("Error invoking remote method 'server-ide-state': Error: Open in IDE needs an SSH server on devbox. Install openssh-server there."))
    expect(await openWorkspaceInIde('code', '/srv', 'p1', SERVER)).toBe('Open in IDE needs an SSH server on devbox. Install openssh-server there.')
  })

  it('leaves local projects alone', async () => {
    expect(await openWorkspaceInIde('code', '/Users/me/app', 'p1')).toBeNull()
    expect((window as any).api.serverIdeState).not.toHaveBeenCalled()
  })
})
