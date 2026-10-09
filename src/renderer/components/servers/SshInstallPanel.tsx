import React, { useState } from 'react'
import type { SshInstallExit } from '../../../shared/servers'
import { Field, HelperText, LinkBtn, PrimaryButton, SetBlock } from '../ui'
import { parseSshTarget, type KnownSshTarget } from './sshTargets'
import { useSshInstallTerminal } from './useSshInstallTerminal'

/** What to say once ssh has ended; null when the status line says enough. */
export function sshExitNote(exit: SshInstallExit, target: string, connected: boolean): string | null {
  if (connected) return null
  if (exit.reason === 'stopped') return 'Stopped.'
  if (exit.reason === 'no-curl') return `curl is missing on ${target}. Install it there (for example sudo apt-get install -y curl), then try again.`
  if (exit.reason === 'no-token') return 'DevTool could not make an install command. Check the relay in Settings, Relay.'
  if (!exit.tokenSent) return exit.exitCode === 255 ? `ssh could not connect to ${target}. The terminal shows why.` : `ssh ended (exit code ${exit.exitCode}) before the installer started.`
  if (exit.message) return `The installer stopped: ${exit.message}`
  if (exit.exitCode !== 0) return 'The installer stopped with an error. The terminal shows why.'
  return null
}

interface Props {
  known: KnownSshTarget[]
  /** The server connected: the install is done. */
  connected: boolean
  /** Shown under the terminal while ssh runs or after: the dialog's status block. */
  status: React.ReactNode
}

/**
 * Add server › Install over SSH: `user@host[:port]` and an optional key, then
 * the system ssh in a small terminal, where host key questions, passwords and
 * 2FA codes get answered as usual. Main runs ssh and slips the install token in
 * once the server is ready for it; it never shows up here or on a command line.
 */
export default function SshInstallPanel({ known, connected, status }: Props): React.ReactElement {
  const first = known[0]
  const [text, setText] = useState(first?.label ?? '')
  const [keyFile, setKeyFile] = useState(first?.target.keyFile ?? '')
  const [parseError, setParseError] = useState<string | null>(null)
  const terminal = useSshInstallTerminal()
  const { session, ended, shown, theme, hostRef } = terminal
  const error = parseError ?? terminal.error
  const setError = setParseError

  const start = (): void => {
    const parsed = parseSshTarget(text)
    if ('error' in parsed) { setError(parsed.error); return }
    setError(null)
    terminal.start({ target: { ...parsed.target, ...(keyFile.trim() ? { keyFile: keyFile.trim() } : {}) } })
  }

  const stop = (): void => terminal.stop()

  const pickKey = async (): Promise<void> => {
    const picked = await window.api.pickFile('Select SSH key')
    if (picked) setKeyFile(picked)
  }

  const running = !!session
  const note = ended ? sshExitNote(ended.exit, ended.target, connected) : null

  return (
    <div className="flex flex-col gap-3" data-testid="ssh-install">
      <div className="text-base text-text">Install on a machine this computer can reach with ssh.</div>
      <div className="grid grid-cols-[1fr_minmax(0,0.8fr)] gap-3">
        <SetBlock label="Server">
          <Field
            value={text}
            onChange={(e) => { setText(e.target.value); setError(null) }}
            onKeyDown={(e) => { if (e.key === 'Enter' && !running) start() }}
            placeholder="user@host or user@host:port"
            spellCheck={false}
            autoFocus
            disabled={running}
            aria-label="SSH server"
          />
        </SetBlock>
        <SetBlock label="Key file (optional)">
          <div className="flex gap-2">
            <Field
              className="flex-1 min-w-0"
              value={keyFile}
              onChange={(e) => setKeyFile(e.target.value)}
              placeholder="~/.ssh/id_ed25519"
              spellCheck={false}
              disabled={running}
              aria-label="Key file"
            />
            <button
              type="button"
              onClick={() => { void pickKey() }}
              disabled={running}
              title="Choose a key file"
              className="h-(--ctl-h) px-2.5 rounded-md bg-field text-text-muted hover:text-text border border-border cursor-pointer text-base disabled:opacity-50"
            >…</button>
          </div>
        </SetBlock>
      </div>
      {known.length > 1 && !running && (
        <div className="flex flex-wrap items-center gap-1.5 -mt-1">
          <span className="text-sm text-text-muted">From your SSH projects:</span>
          {known.map(item => (
            <button
              key={item.label}
              type="button"
              onClick={() => { setText(item.label); setKeyFile(item.target.keyFile ?? ''); setError(null) }}
              className={`px-2 h-5 rounded-sm border text-xs font-mono cursor-pointer transition-colors duration-(--motion-fast) ${item.label === text ? 'border-border-focus bg-sel text-text' : 'border-border bg-field text-text-muted hover:text-text'}`}
            >{item.label}</button>
          ))}
        </div>
      )}
      {error && <HelperText><span className="text-danger">{error}</span></HelperText>}
      <div className="flex items-center gap-3">
        {running ? (
          <>
            <span className="text-sm text-text-muted mr-auto">Answer ssh's questions in the terminal. DevTool fills in the install token.</span>
            <LinkBtn onClick={stop}>Stop</LinkBtn>
          </>
        ) : (
          <>
            <span className="text-sm text-text-muted mr-auto">Uses this computer's ssh and its config, keys and agent.</span>
            {!connected && <PrimaryButton onClick={start} disabled={!text.trim()}>{ended ? 'Try again' : 'Install'}</PrimaryButton>}
          </>
        )}
      </div>
      {shown && (
        <div
          className="h-[200px] rounded-md border border-border overflow-hidden px-2 py-1.5"
          style={{ background: theme.background }}
          data-testid="ssh-install-terminal"
        >
          <div ref={hostRef} className="w-full h-full" />
        </div>
      )}
      {note && <HelperText><span className={ended?.exit.reason === 'stopped' ? '' : 'text-danger'}>{note}</span></HelperText>}
      {shown && status}
    </div>
  )
}
