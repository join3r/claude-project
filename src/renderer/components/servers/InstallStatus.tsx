import React from 'react'
import { Check } from 'lucide-react'
import { describePlatform, type InstallPhase, type InstallProgress } from './addServerFlow'

type Tone = 'busy' | 'done' | 'bad' | 'idle'

function toneOf(phase: InstallPhase): Tone {
  switch (phase) {
    case 'connected': return 'done'
    case 'relay-offline':
    case 'relay-too-old':
    case 'incompatible':
    case 'refused': return 'bad'
    case 'expired':
    case 'lost': return 'idle'
    default: return 'busy'
  }
}

const DOT: Record<Tone, string> = {
  busy: 'bg-accent status-pulse',
  done: 'bg-success',
  bad: 'bg-danger',
  idle: 'bg-status-exited'
}

const FILL: Record<Tone, string> = {
  busy: 'bg-accent',
  done: 'bg-success',
  bad: 'bg-danger',
  idle: 'bg-status-exited'
}

/**
 * The install's four steps (run the command, connect, install, done) as a thin
 * rail, then one status line. The step in progress fills with the upload.
 */
export default function InstallStatus({ progress, title, detail }: {
  progress: InstallProgress
  title: string
  detail?: React.ReactNode
}): React.ReactElement {
  const tone = toneOf(progress.phase)
  const host = progress.server?.host
  const build = progress.server?.build
  // The machine, once known; its host name only when the line above doesn't already say it.
  const machine = [
    host?.hostname && host.hostname !== progress.server?.name && progress.phase !== 'connected' ? host.hostname : null,
    host ? describePlatform(host) : null,
    build?.version ? `DevTool ${build.version}` : null
  ].filter(Boolean).join(', ')
  return (
    <div className="flex flex-col gap-2.5" data-testid="install-status" data-phase={progress.phase}>
      <div className="grid grid-cols-4 gap-1" aria-hidden>
        {[0, 1, 2, 3].map(i => {
          const current = i === progress.step && tone !== 'done'
          // The step in progress: its upload share, else a pulsing full bar (busy) or a red one (stuck).
          const fill = !current ? (tone === 'done' || i < progress.step ? 1 : 0)
            : progress.fraction !== undefined ? progress.fraction
              : tone === 'idle' ? 0 : 1
          const color = tone === 'done' ? FILL.done : current ? FILL[tone] : 'bg-accent'
          const pulse = current && tone === 'busy' && progress.fraction === undefined ? ' status-pulse' : ''
          return (
            <div key={i} className="h-[3px] rounded-full overflow-hidden bg-[color-mix(in_srgb,var(--color-text)_12%,transparent)]">
              <div
                className={`h-full rounded-full transition-[width] duration-(--motion-med) ${color}${pulse}`}
                style={{ width: `${Math.round(fill * 100)}%` }}
              />
            </div>
          )
        })}
      </div>
      <div className="flex items-start gap-2" role="status" aria-live="polite">
        <span className={`mt-[7px] w-1.5 h-1.5 rounded-full shrink-0 ${DOT[tone]}`} />
        <div className="flex flex-col gap-0.5 min-w-0">
          <div className="text-base text-text flex items-center gap-1.5">
            <span data-testid="install-status-title">{title}</span>
            {tone === 'done' && <Check size={14} className="text-success shrink-0" aria-label="done" />}
          </div>
          {machine && <div className="text-sm text-text-muted">{machine}</div>}
          {detail && <div className="text-sm text-text-muted">{detail}</div>}
        </div>
      </div>
    </div>
  )
}
