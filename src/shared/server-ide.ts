/**
 * Open in IDE for a DevTool server's project (plan step 9): VS Code or Cursor
 * reach the server over SSH, through the running DevTool. These are the shapes
 * the windows see; main's side is `src/main/servers/server-ide.ts`.
 */

/** What still needs the user's OK before Open in IDE works for a server. */
export interface ServerIdeState {
  serverId: string
  serverName: string
  /** `~/.ssh/config` has no `Include` of DevTool's ssh config yet. */
  needsInclude: boolean
  /** DevTool's key isn't authorized on the server yet (no host entry for it). */
  needsKey: boolean
  /** The user's ssh config DevTool would change (`~/.ssh/config`). */
  userSshConfig: string
  /** DevTool's own ssh config, which the Include names. */
  devtoolSshConfig: string
}

/** The parts of the setup the user agreed to. */
export interface ServerIdeConsent {
  include: boolean
  key: boolean
}

export function sshServerMissingMessage(serverName: string): string {
  return `Open in IDE needs an SSH server on ${serverName}. Install openssh-server there.`
}

export const SERVER_IDE_WINDOWS_MESSAGE = 'Open in IDE for DevTool server projects needs macOS or Linux on this computer.'
