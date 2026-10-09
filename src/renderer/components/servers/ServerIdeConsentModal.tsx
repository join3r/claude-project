import React from 'react'
import { answerServerIdeConsent, usePendingServerIdeConsent } from '../../serverIdeConsent'
import { LinkBtn, Modal, PrimaryButton } from '../ui'

/** `/Users/me/.ssh/config` as `~/.ssh/config`, for reading. */
function tilde(file: string, home: string | undefined): string {
  return home && file.startsWith(`${home}/`) ? `~${file.slice(home.length)}` : file
}

function homeOf(state: { userSshConfig: string }): string | undefined {
  const match = /^(.*)\/\.ssh\/config$/.exec(state.userSshConfig)
  return match ? match[1] : undefined
}

/**
 * Open in IDE on a DevTool server, first use: what DevTool will change, in two
 * parts (only the ones still needed), before it changes anything.
 */
export default function ServerIdeConsentModal(): React.ReactElement | null {
  const state = usePendingServerIdeConsent()
  if (!state) return null
  const home = homeOf(state)
  return (
    <Modal
      title={`Open in IDE on ${state.serverName}`}
      width="w-[520px]"
      onClose={() => answerServerIdeConsent(false)}
      footer={
        <>
          <LinkBtn onClick={() => answerServerIdeConsent(false)}>Cancel</LinkBtn>
          <PrimaryButton onClick={() => answerServerIdeConsent(true)}>Allow and open</PrimaryButton>
        </>
      }
    >
      <div className="text-sm text-text-muted">
        Your editor reaches {state.serverName} over SSH, through DevTool. For that, DevTool needs to:
      </div>
      <ol className="m-0 pl-5 flex flex-col gap-2 text-sm text-text">
        {state.needsInclude && (
          <li>
            Add <code className="font-mono text-xs">Include {tilde(state.devtoolSshConfig, home)}</code> at the top
            of <code className="font-mono text-xs">{tilde(state.userSshConfig, home)}</code>, so VS Code and Cursor
            find the <code className="font-mono text-xs">devtool-*</code> hosts. A backup of the file is kept next to it.
          </li>
        )}
        {state.needsKey && (
          <li>
            Add DevTool&apos;s SSH key to <code className="font-mono text-xs">~/.ssh/authorized_keys</code> on {state.serverName}.
            The key only works from {state.serverName} itself, which is where DevTool&apos;s connection comes from.
          </li>
        )}
      </ol>
      <div className="text-xs text-text-muted">
        The connection works while DevTool is running.
      </div>
    </Modal>
  )
}
