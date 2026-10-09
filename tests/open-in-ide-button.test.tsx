// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import OpenInIdeButton from '../src/renderer/components/OpenInIdeButton'

void React

const editors = [
  { id: 'code', name: 'Visual Studio Code', command: 'Code.exe', extraArgs: '' },
  { id: 'cursor', name: 'Cursor', command: 'Cursor.exe', extraArgs: '' }
]

beforeEach(() => {
  ;(window as any).api = {
    openInIde: vi.fn().mockResolvedValue(undefined)
  }
})

afterEach(() => {
  cleanup()
})

describe('OpenInIdeButton', () => {
  it('is disabled with a Settings hint when the list is empty', () => {
    render(
      <OpenInIdeButton
        editors={[]}
        defaultId={null}
        folder="C:/Repos/demo"
        onError={vi.fn()}
      />
    )
    const button = screen.getByRole('button', { name: 'Add an editor in Settings → Editor & Diff → External IDEs' })
    expect((button as HTMLButtonElement).disabled).toBe(true)
  })

  it('opens the default editor and lists others in the chevron menu', async () => {
    const onError = vi.fn()
    render(
      <OpenInIdeButton
        editors={editors}
        defaultId="cursor"
        folder="C:/Repos/demo"
        onError={onError}
      />
    )
    fireEvent.click(screen.getByTitle('Open in Cursor'))
    await waitFor(() => {
      expect((window as any).api.openInIde).toHaveBeenCalledWith('cursor', 'C:/Repos/demo', undefined)
    })

    fireEvent.click(screen.getByTitle('Open in another editor'))
    fireEvent.click(screen.getByText('Open in Visual Studio Code'))
    await waitFor(() => {
      expect((window as any).api.openInIde).toHaveBeenCalledWith('code', 'C:/Repos/demo', undefined)
    })
  })
})
