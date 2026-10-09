import React, { useCallback, useEffect, useState } from 'react'
import { X } from 'lucide-react'
import {
  PERMISSION_BEHAVIORS,
  PERMISSION_SOURCE_LABELS,
  type PermissionBehavior,
  type PermissionSettingsSource,
  type PermissionSourceKind
} from '../../../shared/chat-permissions'
import { CHAT_PERMISSION_MODES } from '../../../shared/claude-chat'
import { Field, HelperText, LinkBtn, Modal, PrimaryButton, SegCtl, Select } from '../ui'

interface Props {
  /** The project directory; null for a remote project, whose settings live on the host. */
  cwd: string | null
  /** Its project, so a DevTool server's project reads the settings on that server. */
  projectId?: string
  permissionMode?: string
  onClose: () => void
  onOpenInTerminal: () => void
}

const BEHAVIOR_OPTIONS = PERMISSION_BEHAVIORS.map((value) => ({
  value,
  label: value === 'allow' ? 'Allow' : value === 'ask' ? 'Ask' : 'Deny'
}))

const BEHAVIOR_HELP: Record<PermissionBehavior, string> = {
  allow: 'Claude uses these without asking.',
  ask: 'Claude always asks first, even when another rule would allow it.',
  deny: 'Claude may never use these. Deny wins over allow and ask.'
}

function errorText(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  return raw.replace(/^Error invoking remote method '[^']+': (?:Error: )?/u, '')
}

/**
 * `/permissions` for a chat tab: the allow / ask / deny rules from the settings
 * files Claude reads, editable in place. The running session picks up changes
 * on its own (the CLI watches those files).
 */
export default function PermissionsDialog({ cwd, projectId, permissionMode, onClose, onOpenInTerminal }: Props): React.ReactElement {
  const [sources, setSources] = useState<PermissionSettingsSource[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [behavior, setBehavior] = useState<PermissionBehavior>('allow')
  const [rule, setRule] = useState('')
  const [destination, setDestination] = useState<PermissionSourceKind>('localSettings')
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    if (!cwd) return
    try {
      setSources(await window.api.chatPermissionsRead(cwd, projectId))
    } catch (err) {
      setError(errorText(err))
    }
  }, [cwd, projectId])

  useEffect(() => { void load() }, [load])

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  const change = async (kind: PermissionSourceKind, target: PermissionBehavior, value: string, action: 'add' | 'remove'): Promise<void> => {
    if (!cwd) return
    setBusy(true)
    setError(null)
    try {
      await window.api.chatPermissionsUpdate(cwd, kind, target, value, action, projectId)
      if (action === 'add') setRule('')
      await load()
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  const addRule = (): void => {
    if (rule.trim() && !busy) void change(destination, behavior, rule, 'add')
  }

  const modeLabel = CHAT_PERMISSION_MODES.find((m) => m.value === permissionMode)?.label ?? 'Ask'

  if (!cwd) {
    return (
      <Modal
        title="Permissions"
        onClose={onClose}
        footer={
          <>
            <LinkBtn onClick={onClose}>Close</LinkBtn>
            <PrimaryButton onClick={() => { onClose(); onOpenInTerminal() }}>Switch to terminal</PrimaryButton>
          </>
        }
      >
        <HelperText>
          This project's Claude settings live on the remote host. Continue this task in a terminal and run /permissions there.
        </HelperText>
      </Modal>
    )
  }

  return (
    <Modal title="Permissions" width="w-[560px]" onClose={onClose} footer={<LinkBtn onClick={onClose}>Done</LinkBtn>}>
      <div className="flex items-center justify-between gap-3">
        <SegCtl options={BEHAVIOR_OPTIONS} value={behavior} onChange={setBehavior} />
        <span className="text-xs text-text-subtle">Mode for this chat: {modeLabel}</span>
      </div>
      <HelperText>{BEHAVIOR_HELP[behavior]} Changes apply to the running session.</HelperText>
      <div className="flex gap-1.5">
        <Field
          autoFocus
          className="flex-1 min-w-0 font-mono text-sm"
          placeholder="Bash(npm test:*), Read(./docs/**), WebFetch(domain:github.com)"
          value={rule}
          onChange={(e) => setRule(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') addRule() }}
        />
        <Select value={destination} onChange={(e) => setDestination(e.target.value as PermissionSourceKind)} title="Where the rule is saved">
          {(Object.keys(PERMISSION_SOURCE_LABELS) as PermissionSourceKind[]).map((kind) => (
            <option key={kind} value={kind}>{PERMISSION_SOURCE_LABELS[kind].title}</option>
          ))}
        </Select>
        <PrimaryButton disabled={busy || !rule.trim()} onClick={addRule}>Add</PrimaryButton>
      </div>
      {error && <HelperText><span className="text-danger">{error}</span></HelperText>}
      {!sources ? (
        <HelperText>Loading…</HelperText>
      ) : (
        <div className="flex flex-col gap-3">
          {sources.map((source) => {
            const rules = source[behavior]
            const label = PERMISSION_SOURCE_LABELS[source.kind]
            return (
              <div key={source.kind} className="flex flex-col gap-1">
                <div className="flex items-baseline gap-2 min-w-0">
                  <span className="text-sm font-medium text-text shrink-0">{label.title}</span>
                  <span className="text-xs text-text-subtle font-mono truncate" title={source.path}>{label.hint}</span>
                </div>
                {source.error ? (
                  <div className="text-xs text-danger">{source.error}</div>
                ) : rules.length === 0 ? (
                  <div className="text-xs text-text-subtle">No {behavior} rules</div>
                ) : (
                  <ul className="m-0 p-0 list-none flex flex-col rounded-md border-[0.5px] border-border bg-surface-2">
                    {rules.map((value) => (
                      <li key={value} className="group flex items-center gap-2 px-2 py-1 border-b border-hair last:border-b-0">
                        <span className="flex-1 min-w-0 truncate font-mono text-xs text-text" title={value}>{value}</span>
                        <button
                          type="button"
                          title="Remove this rule"
                          aria-label={`Remove ${value}`}
                          disabled={busy}
                          onClick={() => { void change(source.kind, behavior, value, 'remove') }}
                          className="w-5 h-5 inline-flex items-center justify-center rounded-sm border-0 bg-transparent text-text-subtle cursor-pointer opacity-0 group-hover:opacity-100 focus-visible:opacity-100 hover:text-danger hover:bg-surface-3"
                        >
                          <X size={12} />
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )
          })}
        </div>
      )}
    </Modal>
  )
}
