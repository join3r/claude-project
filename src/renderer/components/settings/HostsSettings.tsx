import React, { useMemo, useState } from 'react'
import type { SavedHost } from '../../../shared/types'
import { useApp } from '../../context/AppContext'
import { useServersState } from '../../serversState'
import { useSshStatuses } from '../../sshStatuses'
import { paletteEvents } from '../../palette/paletteEvents'
import { addSavedHost, listHosts, removeSavedHost, shellHostKey, type HostEntry, type HostTone, type SshBox } from '../../hosts'
import { parseSshTarget } from '../servers/sshTargets'
import { Field, Group, GrpHead, HelperText, LinkBtn, PrimaryButton } from '../ui'

const DOT: Record<HostTone, string> = {
  ok: 'bg-success',
  idle: 'bg-status-exited',
  bad: 'bg-danger'
}

const KIND: Record<HostEntry['kind'], string> = {
  mac: 'This computer',
  server: 'DevTool server',
  ssh: 'SSH',
  shell: 'Custom shell'
}

function errorText(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  return raw.replace(/^Error invoking remote method '[^']+': (?:\w*Error: )?/u, '')
}

/** Opens an SSH master under a throwaway id and closes it again: can this computer reach the box? */
async function testSshBox(box: SshBox): Promise<void> {
  const config = { ...box, remoteDir: '' }
  await window.api.sshConnect('__test__', config)
  await window.api.sshDisconnect('__test__', config).catch(() => {})
}

/**
 * Settings › Hosts (change 6 of the redesign): every place code runs, listed
 * once with its health and its projects. This Mac, the paired DevTool servers
 * (managed on Settings › Servers), the SSH boxes and the custom shells. A
 * project picks one of these when it's made (New project); boxes and shells
 * added here before any project uses them are kept in `config.hosts`.
 */
export default function HostsSettings({ onOpenServers }: { onOpenServers: () => void }): React.ReactElement {
  const { projects, config, updateConfig, updateProject } = useApp()
  const servers = useServersState()
  const sshProjectIds = useMemo(() => projects.filter(project => project.ssh).map(project => project.id), [projects])
  const ssh = useSshStatuses(sshProjectIds)
  const saved = useMemo(() => config?.hosts ?? [], [config?.hosts])
  const hosts = useMemo(() => listHosts(projects, servers.servers, ssh, saved), [projects, servers, ssh, saved])
  const [adding, setAdding] = useState<'ssh' | 'shell' | null>(null)

  const save = (next: SavedHost[]): void => updateConfig({ hosts: next })

  /** A shell's new name or command: the saved entry and every project that uses it. */
  const editShell = (host: HostEntry, name: string, command: string): void => {
    if (command !== host.command) {
      for (const project of host.projects) updateProject(project.id, { shellCommand: { command } })
    }
    const keep = removeSavedHost(saved, host.key)
    save(host.saved || name.trim() ? addSavedHost(keep, { kind: 'shell', name: name.trim(), command }) : keep)
  }

  return (
    <>
      <GrpHead actions={
        <>
          <LinkBtn onClick={() => setAdding(adding === 'ssh' ? null : 'ssh')}>Add SSH box</LinkBtn>
          <LinkBtn onClick={() => setAdding(adding === 'shell' ? null : 'shell')}>Add shell</LinkBtn>
          <LinkBtn onClick={() => paletteEvents.emit('open-add-server')}>Add server</LinkBtn>
        </>
      }>Hosts</GrpHead>
      {adding === 'ssh' && <AddSshBox onDone={(box) => { if (box) save(addSavedHost(saved, { kind: 'ssh', ...box })); setAdding(null) }} />}
      {adding === 'shell' && (
        <ShellForm
          submitLabel="Add"
          onCancel={() => setAdding(null)}
          onSubmit={(name, command) => { save(addSavedHost(saved, { kind: 'shell', name, command })); setAdding(null) }}
        />
      )}
      <Group>
        {hosts.map(host => (
          <HostRow
            key={host.key}
            host={host}
            onOpenServers={onOpenServers}
            onRemove={() => save(removeSavedHost(saved, host.key))}
            onEditShell={(name, command) => editShell(host, name, command)}
          />
        ))}
      </Group>
      <HelperText>
        A project runs on one of these. Pick it in New project; it shows in the project&apos;s settings and in the status bar. SSH boxes and shells with no project left go away unless you added them here.
      </HelperText>
    </>
  )
}

function HostRow({ host, onOpenServers, onRemove, onEditShell }: {
  host: HostEntry
  onOpenServers: () => void
  onRemove: () => void
  onEditShell: (name: string, command: string) => void
}): React.ReactElement {
  const [testing, setTesting] = useState(false)
  const [message, setMessage] = useState<{ text: string; bad?: boolean } | null>(null)
  const [editing, setEditing] = useState(false)
  const count = host.projects.length
  const names = host.projects.map(project => project.name)

  const test = (): void => {
    if (!host.ssh) return
    setTesting(true)
    setMessage(null)
    testSshBox(host.ssh)
      .then(() => setMessage({ text: 'Connected.' }))
      .catch((err: unknown) => setMessage({ text: errorText(err), bad: true }))
      .finally(() => setTesting(false))
  }

  return (
    <div className="px-3 py-2.5 border-t border-hair first:border-t-0 flex flex-col gap-1" data-testid="host-row" data-host={host.key}>
      <div className="flex items-center gap-2 min-w-0">
        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${DOT[host.tone]}`} />
        <span className="truncate text-base text-text font-medium">{host.label}</span>
        <span className="text-sm text-text-muted shrink-0">{KIND[host.kind]}{host.detail ? ` · ${host.detail}` : ''}</span>
        <span className="ml-auto flex items-center gap-3 shrink-0">
          {host.kind === 'server' && <LinkBtn onClick={onOpenServers}>Manage</LinkBtn>}
          {host.kind === 'ssh' && <LinkBtn onClick={test} disabled={testing}>{testing ? 'Testing…' : 'Test'}</LinkBtn>}
          {host.kind === 'shell' && <LinkBtn onClick={() => setEditing(open => !open)}>Edit</LinkBtn>}
          {host.saved && count === 0 && <LinkBtn danger onClick={onRemove}>Remove</LinkBtn>}
        </span>
      </div>
      <div className="pl-3.5 flex flex-col gap-0.5 text-sm text-text-muted min-w-0">
        {host.sub && host.sub !== host.label && <div className="font-mono text-xs truncate" title={host.sub}>{host.sub}</div>}
        <div className="truncate" title={names.join(', ')}>
          {count === 0 ? 'No projects' : `${count} project${count === 1 ? '' : 's'} · ${names.join(', ')}`}
        </div>
        {message && <div className={message.bad ? 'text-danger' : 'text-success'}>{message.text}</div>}
      </div>
      {editing && host.kind === 'shell' && (
        <div className="pl-3.5">
          <ShellForm
            initialName={host.label === host.command ? '' : host.label}
            initialCommand={host.command ?? ''}
            submitLabel="Save"
            note={count > 0 ? `New tabs in ${count === 1 ? 'its project' : `its ${count} projects`} use the new command; open ones keep theirs.` : undefined}
            onCancel={() => setEditing(false)}
            onSubmit={(name, command) => { onEditShell(name, command); setEditing(false) }}
          />
        </div>
      )}
    </div>
  )
}

/** One field, `user@host[:port]`, and an optional key file; Test before adding. */
function AddSshBox({ onDone }: { onDone: (box: SshBox | null) => void }): React.ReactElement {
  const [address, setAddress] = useState('')
  const [keyFile, setKeyFile] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ text: string; bad?: boolean } | null>(null)

  const parse = (): SshBox | null => {
    const parsed = parseSshTarget(address)
    if ('error' in parsed) { setMessage({ text: parsed.error, bad: true }); return null }
    if (!parsed.target.user) { setMessage({ text: 'Put the user name in front: user@host.', bad: true }); return null }
    return { host: parsed.target.host, port: parsed.target.port ?? 22, username: parsed.target.user, ...(keyFile.trim() ? { keyFile: keyFile.trim() } : {}) }
  }

  const test = (): void => {
    const box = parse()
    if (!box) return
    setBusy(true)
    setMessage(null)
    testSshBox(box)
      .then(() => setMessage({ text: 'Connected.' }))
      .catch((err: unknown) => setMessage({ text: errorText(err), bad: true }))
      .finally(() => setBusy(false))
  }

  return (
    <div className="rounded-lg border border-border bg-field px-3 py-2.5 mb-2 flex flex-col gap-2" data-testid="add-ssh-box">
      <div className="flex gap-2">
        <Field className="flex-1" value={address} autoFocus placeholder="deploy@dev.example.com:22" onChange={(e) => { setAddress(e.target.value); setMessage(null) }} />
        <Field className="w-48" value={keyFile} placeholder="Key file (optional)" onChange={(e) => setKeyFile(e.target.value)} />
        <button
          type="button"
          className="h-(--ctl-h) px-2.5 rounded-md bg-field text-text-muted hover:text-text border border-border cursor-pointer text-base"
          title="Browse for a key file"
          onClick={() => { void window.api.pickFile('Select SSH Key').then(picked => { if (picked) setKeyFile(picked) }) }}
        >…</button>
      </div>
      <div className="flex items-center gap-3">
        {message && <span className={`text-sm ${message.bad ? 'text-danger' : 'text-success'} min-w-0 truncate`} title={message.text}>{message.text}</span>}
        <span className="ml-auto flex items-center gap-3">
          <LinkBtn onClick={() => onDone(null)}>Cancel</LinkBtn>
          <LinkBtn onClick={test} disabled={busy || !address.trim()}>{busy ? 'Testing…' : 'Test'}</LinkBtn>
          <PrimaryButton disabled={!address.trim()} onClick={() => { const box = parse(); if (box) onDone(box) }}>Add</PrimaryButton>
        </span>
      </div>
    </div>
  )
}

function ShellForm({ initialName = '', initialCommand = '', submitLabel, note, onSubmit, onCancel }: {
  initialName?: string
  initialCommand?: string
  submitLabel: string
  note?: string
  onSubmit: (name: string, command: string) => void
  onCancel: () => void
}): React.ReactElement {
  const [name, setName] = useState(initialName)
  const [command, setCommand] = useState(initialCommand)
  const valid = !!command.trim()
  const submit = (): void => { if (valid) onSubmit(name.trim(), command.trim()) }
  return (
    <div className="rounded-lg border border-border bg-field px-3 py-2.5 mb-2 flex flex-col gap-2" data-testid="shell-form" data-shell={shellHostKey(initialCommand)}>
      <div className="flex gap-2">
        <Field className="w-40" value={name} placeholder="Name" onChange={(e) => setName(e.target.value)} />
        <Field
          className="flex-1 font-mono"
          value={command}
          autoFocus
          placeholder="docker exec -it mycontainer /bin/bash"
          onChange={(e) => setCommand(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') submit() }}
        />
      </div>
      <div className="flex items-center gap-3">
        <span className="text-sm text-text-muted min-w-0">{note ?? 'A terminal in its projects opens by running this command.'}</span>
        <span className="ml-auto flex items-center gap-3 shrink-0">
          <LinkBtn onClick={onCancel}>Cancel</LinkBtn>
          <PrimaryButton disabled={!valid} onClick={submit}>{submitLabel}</PrimaryButton>
        </span>
      </div>
    </div>
  )
}
