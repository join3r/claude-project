import React, { useState } from 'react'
import { X } from 'lucide-react'
import type { ChatLogin, ChatLoginMethod } from '../../../shared/claude-chat'
import { primaryBtn, quietBtn, secondaryBtn } from './PromptCards'

const METHOD_LABELS: Record<ChatLoginMethod, string> = {
  claudeai: 'Claude account',
  console: 'Anthropic Console',
  sso: 'SSO'
}

interface Props {
  login: ChatLogin
  onSubmitCode: (code: string) => void
  onRetry: (method: ChatLoginMethod) => void
  onOpenUrl: (url: string) => void
  onDismiss: () => void
}

/**
 * `/login`, above the composer: `claude auth login` running in main. Locally the
 * CLI opens the browser and finishes by itself; the pasted code is the way
 * through when it can't (a remote project, a browser that didn't open).
 */
export default function LoginCard({ login, onSubmitCode, onRetry, onOpenUrl, onDismiss }: Props): React.ReactElement {
  const [code, setCode] = useState('')
  const running = login.status === 'running' || login.status === 'verifying'
  const others = (Object.keys(METHOD_LABELS) as ChatLoginMethod[]).filter((method) => method !== login.method)

  let body: React.ReactNode
  if (login.status === 'done') {
    body = <div className="text-sm text-text">Signed in{login.account ? <> as <span className="font-medium">{login.account}</span></> : null}.</div>
  } else if (login.status === 'failed') {
    body = (
      <>
        <div className="text-sm text-danger whitespace-pre-wrap break-words">{login.error ?? 'Sign-in failed.'}</div>
        <div className="flex gap-1.5">
          <button type="button" className={secondaryBtn} onClick={() => onRetry(login.method)}>Try again</button>
        </div>
      </>
    )
  } else if (!login.url) {
    body = <div className="text-sm text-text-subtle italic">Starting sign-in…</div>
  } else {
    const url = login.url
    body = (
      <>
        <div className="text-sm text-text-muted">
          {login.remote
            ? 'Open the sign-in page, then paste the code it shows here.'
            : "Finish signing in in the browser window that opened. If it didn't open, use the sign-in page and paste the code it shows here."}
        </div>
        <form
          className="flex gap-1.5"
          onSubmit={(e) => {
            e.preventDefault()
            if (!code.trim() || login.status !== 'running') return
            onSubmitCode(code.trim())
            setCode('')
          }}
        >
          <button type="button" className={login.remote ? primaryBtn : secondaryBtn} onClick={() => onOpenUrl(url)}>Open sign-in page</button>
          <input
            className="flex-1 min-w-0 h-(--ctl-h-sm) px-2 rounded-md border-[0.5px] border-border bg-field text-sm text-text outline-none focus:border-border-focus"
            placeholder={login.status === 'verifying' ? 'Checking the code…' : 'Paste code'}
            aria-label="Sign-in code"
            value={code}
            disabled={login.status !== 'running'}
            onChange={(e) => setCode(e.target.value)}
          />
          <button type="submit" className={secondaryBtn} disabled={!code.trim() || login.status !== 'running'}>Sign in</button>
        </form>
        {login.error && <div className="text-sm text-danger whitespace-pre-wrap break-words">{login.error}</div>}
      </>
    )
  }

  return (
    <div className="rounded-lg border-[0.5px] border-border bg-surface-2 px-3 py-2 flex flex-col gap-1.5" role="region" aria-label="Sign in">
      <div className="flex items-center gap-2">
        <div className="flex-1 min-w-0 text-sm text-text-muted truncate">
          <span className="text-accent font-medium mr-1.5">/login</span>
          {METHOD_LABELS[login.method]}
        </div>
        {running && others.map((method) => (
          <button key={method} type="button" className={quietBtn} onClick={() => onRetry(method)}>Use {METHOD_LABELS[method]}</button>
        ))}
        <button
          type="button"
          title={running ? 'Cancel sign-in' : 'Dismiss'}
          onClick={onDismiss}
          className="w-5 h-5 shrink-0 inline-flex items-center justify-center rounded-md border-0 bg-transparent text-text-subtle cursor-pointer hover:bg-surface-3 hover:text-text"
        >
          <X size={12} />
        </button>
      </div>
      {body}
    </div>
  )
}
