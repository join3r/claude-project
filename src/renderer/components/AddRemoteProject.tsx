import React, { useState } from 'react'
import { AI_TAB_TYPES, AI_TAB_META } from '../../shared/types'
import type { AiTabType, Tag } from '../../shared/types'
import TagPicker from './TagPicker'
import { Modal, SetBlock, Field, LinkBtn, PrimaryButton, HelperText } from './ui'

interface Props {
  onAdd: (
    name: string,
    ssh: { host: string; port: number; username: string; keyFile?: string; remoteDir: string },
    aiToolArgs?: Partial<Record<AiTabType, string>>,
    tagIds?: string[]
  ) => void
  onCancel: () => void
  allTags: readonly Tag[]
  onEnsureTag: (name: string) => string
  initialValues?: {
    host: string
    port: number
    username: string
    keyFile?: string
    remoteDir: string
    aiToolArgs?: Partial<Record<AiTabType, string>>
  }
}

export default function AddRemoteProject({ onAdd, onCancel, initialValues, allTags, onEnsureTag }: Props): React.ReactElement {
  const [host, setHost] = useState(initialValues?.host ?? '')
  const [port, setPort] = useState(initialValues?.port ?? 22)
  const [username, setUsername] = useState(initialValues?.username ?? '')
  const [keyFile, setKeyFile] = useState(initialValues?.keyFile ?? '')
  const [remoteDir, setRemoteDir] = useState(initialValues?.remoteDir ?? '')
  const [aiArgs, setAiArgs] = useState<Partial<Record<AiTabType, string>>>(initialValues?.aiToolArgs ?? {})
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<'success' | 'fail' | null>(null)
  const [error, setError] = useState('')
  const [tagIds, setTagIds] = useState<string[]>([])

  const isValid = host.trim() && username.trim() && remoteDir.trim()

  const handleTest = async () => {
    if (!isValid) return
    setTesting(true)
    setTestResult(null)
    setError('')
    try {
      await window.api.sshConnect('__test__', {
        host: host.trim(),
        port,
        username: username.trim(),
        keyFile: keyFile.trim() || undefined,
        remoteDir: remoteDir.trim()
      })
      await window.api.sshDisconnect('__test__', {
        host: host.trim(),
        port,
        username: username.trim(),
        keyFile: keyFile.trim() || undefined,
        remoteDir: remoteDir.trim()
      })
      setTestResult('success')
    } catch (err) {
      setTestResult('fail')
      setError(err instanceof Error ? err.message : 'Connection failed')
    } finally {
      setTesting(false)
    }
  }

  const handleAdd = () => {
    if (!isValid) return
    const name = `${username.trim()}@${host.trim()}:${remoteDir.trim().split('/').pop() || remoteDir.trim()}`
    const cleaned: Partial<Record<AiTabType, string>> = {}
    for (const tool of AI_TAB_TYPES) {
      const val = aiArgs[tool]?.trim()
      if (val) cleaned[tool] = val
    }
    onAdd(name, {
      host: host.trim(),
      port,
      username: username.trim(),
      keyFile: keyFile.trim() || undefined,
      remoteDir: remoteDir.trim()
    }, Object.keys(cleaned).length > 0 ? cleaned : undefined, tagIds.length > 0 ? tagIds : undefined)
  }

  const handlePickKey = async () => {
    const picked = await window.api.pickFile('Select SSH Key')
    if (picked) setKeyFile(picked)
  }

  return (
    <Modal
      title={`${initialValues ? 'Duplicate' : 'Add'} Remote Project (SSH)`}
      onClose={onCancel}
      footer={
        <>
          <LinkBtn onClick={onCancel}>Cancel</LinkBtn>
          <LinkBtn onClick={handleTest} disabled={!isValid || testing}>
            {testing ? 'Testing…' : 'Test connection'}
          </LinkBtn>
          <PrimaryButton onClick={handleAdd} disabled={!isValid}>Add</PrimaryButton>
        </>
      }
    >
      <SetBlock label="Host">
        <Field
          value={host}
          onChange={(e) => setHost(e.target.value)}
          placeholder="dev.example.com"
          autoFocus
        />
      </SetBlock>

      <div className="grid gap-3 grid-cols-2">
        <SetBlock label="Port">
          <Field
            type="number"
            min={1}
            max={65535}
            value={port}
            onChange={(e) => setPort(parseInt(e.target.value) || 22)}
          />
        </SetBlock>
        <SetBlock label="Username">
          <Field
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="deploy"
          />
        </SetBlock>
      </div>

      <SetBlock label="Key file (optional)">
        <div className="flex gap-2">
          <Field
            className="flex-1"
            value={keyFile}
            onChange={(e) => setKeyFile(e.target.value)}
            placeholder="~/.ssh/id_ed25519"
          />
          <button
            onClick={handlePickKey}
            title="Browse"
            className="h-(--ctl-h) px-2.5 rounded-md bg-field text-text-muted hover:text-text border border-border cursor-pointer text-base"
          >
            …
          </button>
        </div>
      </SetBlock>

      <SetBlock label="Remote directory">
        <Field
          value={remoteDir}
          onChange={(e) => setRemoteDir(e.target.value)}
          placeholder="/home/deploy/my-project"
        />
      </SetBlock>

      <SetBlock label="AI tool arguments (optional)">
        <div className="flex flex-col gap-1.5">
          {AI_TAB_TYPES.map((tool) => (
            <div key={tool} className="flex items-center gap-2">
              <span className="text-sm text-text-muted w-16 shrink-0">{AI_TAB_META[tool].label}</span>
              <Field
                className="flex-1"
                value={aiArgs[tool] ?? ''}
                onChange={(e) => setAiArgs({ ...aiArgs, [tool]: e.target.value })}
                placeholder="e.g. --model sonnet"
              />
            </div>
          ))}
        </div>
      </SetBlock>

      <TagPicker
        selectedTagIds={tagIds}
        onChange={setTagIds}
        allTags={allTags}
        onEnsureTag={onEnsureTag}
      />

      {error && <HelperText><span className="text-danger">{error}</span></HelperText>}
      {testResult === 'success' && <HelperText><span className="text-success">Connection successful</span></HelperText>}
    </Modal>
  )
}
