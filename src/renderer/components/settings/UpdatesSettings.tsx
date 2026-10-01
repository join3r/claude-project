import React, { useEffect, useState } from 'react'
import { describeUpdateStatus, type UpdateStatus } from '../../../shared/updates'
import { useApp } from '../../context/AppContext'
import { Group, GroupRow, GrpHead, HelperText, LinkBtn, Switch } from '../ui'

const MODE_HELP: Record<Exclude<UpdateStatus['mode'], 'none'>, string> = {
  auto: 'This install updates itself: a new version downloads in the background and installs when you quit or restart.',
  manual: 'This build does not replace itself (portable folder or unsigned installer). DevTool tells you about a new version and opens its release page.'
}

export default function UpdatesSettings(): React.ReactElement {
  const { config, updateConfig } = useApp()
  const [status, setStatus] = useState<UpdateStatus | null>(null)

  useEffect(() => {
    let alive = true
    void window.api.updatesGetStatus().then(next => { if (alive) setStatus(next) }).catch(() => {})
    const off = window.api.onUpdatesStatus(next => setStatus(next))
    return () => { alive = false; off() }
  }, [])

  if (!status || !config) return <div />

  const busy = status.state === 'checking' || status.state === 'downloading'
  const action = status.state === 'ready'
    ? <LinkBtn onClick={() => void window.api.updatesInstall()}>Restart to update</LinkBtn>
    : status.available
      ? <LinkBtn onClick={() => void window.api.updatesInstall()}>Open release page</LinkBtn>
      : <LinkBtn disabled={busy} onClick={() => void window.api.updatesCheck()}>Check now</LinkBtn>

  return (
    <>
      <GrpHead>Updates</GrpHead>
      <Group>
        <GroupRow
          label={`DevTool ${status.appVersion}`}
          sub={describeUpdateStatus(status)}
          trailing={status.mode === 'none' ? undefined : action}
        />
        {status.mode !== 'none' && (
          <GroupRow
            label="Check for updates automatically"
            sub="At launch and every few hours, against the GitHub releases of join3r/claude-project."
            trailing={
              <Switch
                checked={config.autoCheckUpdates !== false}
                onChange={(autoCheckUpdates) => updateConfig({ autoCheckUpdates })}
              />
            }
          />
        )}
      </Group>
      {status.mode !== 'none' && <HelperText>{MODE_HELP[status.mode]}</HelperText>}
    </>
  )
}
