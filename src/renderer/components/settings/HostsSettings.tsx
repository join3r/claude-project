import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Container, Laptop, Server, SquareTerminal, type LucideIcon } from 'lucide-react'
import type { SavedHost } from '../../../shared/types'
import { useApp } from '../../context/AppContext'
import { useServersState } from '../../serversState'
import { useSshStatuses } from '../../sshStatuses'
import { paletteEvents } from '../../palette/paletteEvents'
import { addSavedHost, listHosts, removeSavedHost, shellHostKey, type HostEntry, type HostTone, type SshBox } from '../../hosts'
import { parseSshTarget } from '../servers/sshTargets'
import { Field, Group, HelperText, LinkBtn, PrimaryButton } from '../ui'
import ServersSettings from './ServersSettings'

const DOT: Record<HostTone, string> = {
  ok: 'bg-success',
  idle: 'bg-status-exited',
  bad: 'bg-danger'
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

/** What each kind of host is, and how it differs from the others: the page's whole explanation. */
const SECTIONS: Record<HostEntry['kind'], { icon: LucideIcon; title: string; text: string }> = {
  mac: {
    icon: Laptop,
    title: 'This Mac',
    text: 'Projects in a folder on this computer. Their agents stop when it sleeps or DevTool quits.'
  },
  server: {
    icon: Server,
    title: 'DevTool servers',
    text: 'A Linux or macOS machine of yours running the DevTool server. Its agents keep working while this Mac sleeps, and your phone reaches it too. Servers connect through the relay, so there are no ports to open.'
  },
  ssh: {
    icon: SquareTerminal,
    title: 'SSH boxes',
    text: 'Any machine you can ssh into, with nothing to install. This Mac opens every terminal over SSH, so the agents need this Mac awake. Tasks share one folder there: no worktree per task.'
  },
  shell: {
    icon: Container,
    title: 'Custom shells',
    text: 'A command this Mac runs to open each terminal, such as docker exec into a container or a VM\'s shell.'
  }
}

/**
 * Settings › Hosts: every place code runs, grouped by kind, each kind with a
 * line on what it is. This Mac, the paired DevTool servers (their pairing,
 * builds and phones inline, see `ServersSettings`), the SSH boxes and the
 * custom shells. A project picks one of these when it's made (New project);
 * boxes and shells added here before any project uses them are kept in
 * `config.hosts`. `focus` scrolls to a section (the status bar's server dot).
 */
export default function HostsSettings({ onOpenRelay, focus }: { onOpenRelay: () => void; focus?: 'servers' }): React.ReactElement {
  const { projects, config, updateConfig, updateProject } = useApp()
  const servers = useServersState()
  const sshProjectIds = useMemo(() => projects.filter(project => project.ssh).map(project => project.id), [projects])
  const ssh = useSshStatuses(sshProjectIds)
  const saved = useMemo(() => config?.hosts ?? [], [config?.hosts])
  const hosts = useMemo(() => listHosts(projects, servers.servers, ssh, saved), [projects, servers, ssh, saved])
  const [adding, setAdding] = useState<'ssh' | 'shell' | null>(null)
  const serversRef = useRef<HTMLElement>(null)

  useEffect(() => {
    if (focus === 'servers') serversRef.current?.scrollIntoView({ block: 'start' })
  }, [focus])

  const save = (next: SavedHost[]): void => updateConfig({ hosts: next })

  /** A shell's new name or command: the saved entry and every project that uses it. */
  const editShell = (host: HostEntry, name: string, command: string): void => {
    if (command !== host.command) {
      for (const project of host.projects) updateProject(project.id, { shellCommand: { command } })
    }
    const keep = removeSavedHost(saved, host.key)
    save(host.saved || name.trim() ? addSavedHost(keep, { kind: 'shell', name: name.trim(), command }) : keep)
  }

  const ofKind = (kind: HostEntry['kind']): HostEntry[] => hosts.filter(host => host.kind === kind)
  // Paired servers render as server rows; a server only projects still name ("not paired") as a plain row.
  const strayServers = ofKind('server').filter(host => !host.server)
  const projectsOf = (serverId: string): string[] =>
    hosts.find(host => host.server?.id === serverId)?.projects.map(project => project.name) ?? []
  const rows = (list: HostEntry[]): React.ReactNode => list.map(host => (
    <HostRow
      key={host.key}
      host={host}
      onRemove={() => save(removeSavedHost(saved, host.key))}
      onEditShell={(name, command) => editShell(host, name, command)}
    />
  ))

  return (
    <>
      <HostSection kind="mac">
        <Group>{rows(ofKind('mac'))}</Group>
      </HostSection>

      <HostSection kind="server" sectionRef={serversRef} action={<LinkBtn onClick={() => paletteEvents.emit('open-add-server')}>Add server</LinkBtn>}>
        <ServersSettings onOpenRelay={onOpenRelay} projectsOf={projectsOf} />
        {strayServers.length > 0 && <Group>{rows(strayServers)}</Group>}
      </HostSection>

      <HostSection kind="ssh" action={<LinkBtn onClick={() => setAdding(adding === 'ssh' ? null : 'ssh')}>Add SSH box</LinkBtn>}>
        {adding === 'ssh' && <AddSshBox onDone={(box) => { if (box) save(addSavedHost(saved, { kind: 'ssh', ...box })); setAdding(null) }} />}
        {ofKind('ssh').length > 0 ? <Group>{rows(ofKind('ssh'))}</Group> : adding !== 'ssh' && <EmptyLine>No SSH boxes.</EmptyLine>}
      </HostSection>

      <HostSection kind="shell" action={<LinkBtn onClick={() => setAdding(adding === 'shell' ? null : 'shell')}>Add shell</LinkBtn>}>
        {adding === 'shell' && (
          <ShellForm
            submitLabel="Add"
            onCancel={() => setAdding(null)}
            onSubmit={(name, command) => { save(addSavedHost(saved, { kind: 'shell', name, command })); setAdding(null) }}
          />
        )}
        {ofKind('shell').length > 0 ? <Group>{rows(ofKind('shell'))}</Group> : adding !== 'shell' && <EmptyLine>No custom shells.</EmptyLine>}
      </HostSection>

      <HelperText>
        SSH boxes and shells with no project left go away unless you added them here.
      </HelperText>
    </>
  )
}

/** A kind of host: an icon, its name, what it is, and its rows. */
function HostSection({ kind, action, sectionRef, children }: {
  kind: HostEntry['kind']
  action?: React.ReactNode
  sectionRef?: React.Ref<HTMLElement>
  children: React.ReactNode
}): React.ReactElement {
  const { icon: Icon, title, text } = SECTIONS[kind]
  return (
    <section ref={sectionRef} className="flex flex-col gap-2 pt-1 scroll-mt-4" data-testid={`hosts-section-${kind}`}>
      <div className="flex items-start gap-3">
        <span className="mt-0.5 w-7 h-7 rounded-md bg-surface-3 border border-border flex items-center justify-center shrink-0 text-text-muted">
          <Icon size={15} strokeWidth={1.75} />
        </span>
        <div className="flex-1 min-w-0 flex flex-col gap-0.5">
          <div className="flex items-center gap-3">
            <h3 className="m-0 text-base font-semibold text-text">{title}</h3>
            {action && <span className="ml-auto shrink-0">{action}</span>}
          </div>
          <p className="m-0 text-sm text-text-muted leading-snug">{text}</p>
        </div>
      </div>
      <div className="flex flex-col gap-2 pl-10">{children}</div>
    </section>
  )
}

function EmptyLine({ children }: { children: React.ReactNode }): React.ReactElement {
  return <div className="text-sm text-text-subtle">{children}</div>
}

function HostRow({ host, onRemove, onEditShell }: {
  host: HostEntry
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
        {host.detail && <span className="text-sm text-text-muted shrink-0">{host.detail}</span>}
        <span className="ml-auto flex items-center gap-3 shrink-0">
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
