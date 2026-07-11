import React, { useState } from 'react'
import { AI_TAB_TYPES, AI_TAB_META } from '../../shared/types'
import type { AiTabType, Tag } from '../../shared/types'
import TagPicker from './TagPicker'

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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="w-[440px] max-w-[90vw] rounded-xl border border-border bg-surface-2 shadow-2xl flex flex-col max-h-[85vh]">
        {/* header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <h2 className="text-[14px] font-semibold text-text m-0">{initialValues ? 'Duplicate' : 'Add'} Remote Project (SSH)</h2>
          <button onClick={onCancel} className="bg-transparent border-0 text-text-muted cursor-pointer text-[18px] leading-none px-1 rounded-sm hover:text-text">&times;</button>
        </div>

        {/* body — scrollable */}
        <div className="p-5 flex flex-col gap-4 overflow-y-auto">
          <label className="flex flex-col gap-1">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-text-subtle">Host</span>
            <input
              className="h-9 px-3 rounded-md bg-surface-2 border border-border text-text focus:border-border-focus outline-none"
              value={host}
              onChange={(e) => setHost(e.target.value)}
              placeholder="dev.example.com"
              autoFocus
            />
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-text-subtle">Port</span>
            <input
              className="h-9 px-3 rounded-md bg-surface-2 border border-border text-text focus:border-border-focus outline-none"
              type="number"
              min={1}
              max={65535}
              value={port}
              onChange={(e) => setPort(parseInt(e.target.value) || 22)}
            />
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-text-subtle">Username</span>
            <input
              className="h-9 px-3 rounded-md bg-surface-2 border border-border text-text focus:border-border-focus outline-none"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="deploy"
            />
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-text-subtle">Key File (optional)</span>
            <div className="flex gap-2">
              <input
                className="flex-1 h-9 px-3 rounded-md bg-surface-2 border border-border text-text focus:border-border-focus outline-none"
                value={keyFile}
                onChange={(e) => setKeyFile(e.target.value)}
                placeholder="~/.ssh/id_ed25519"
              />
              <button onClick={handlePickKey} title="Browse" className="h-9 px-3 rounded-md bg-surface-3 text-text hover:bg-surface-2 border border-border cursor-pointer">...</button>
            </div>
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-text-subtle">Remote Directory</span>
            <input
              className="h-9 px-3 rounded-md bg-surface-2 border border-border text-text focus:border-border-focus outline-none"
              value={remoteDir}
              onChange={(e) => setRemoteDir(e.target.value)}
              placeholder="/home/deploy/my-project"
            />
          </label>

          <div className="flex flex-col gap-1">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-text-subtle">AI Tool Arguments (optional)</span>
            <div className="flex flex-col gap-1.5">
              {AI_TAB_TYPES.map((tool) => (
                <div key={tool} className="flex items-center gap-2">
                  <span className="text-[12px] text-text-muted w-16 shrink-0">{AI_TAB_META[tool].label}</span>
                  <input
                    className="flex-1 h-9 px-3 rounded-md bg-surface-2 border border-border text-text focus:border-border-focus outline-none text-[12px]"
                    value={aiArgs[tool] ?? ''}
                    onChange={(e) => setAiArgs({ ...aiArgs, [tool]: e.target.value })}
                    placeholder={`e.g. --model sonnet`}
                  />
                </div>
              ))}
            </div>
          </div>

          <TagPicker
            selectedTagIds={tagIds}
            onChange={setTagIds}
            allTags={allTags}
            onEnsureTag={onEnsureTag}
          />

          {error && <div className="text-[12px] text-red-400">{error}</div>}
          {testResult === 'success' && <div className="text-[12px] text-emerald-400">Connection successful</div>}
        </div>

        {/* footer */}
        <div className="flex items-center justify-end gap-2 px-5 py-4 border-t border-border">
          <button
            className="inline-flex items-center justify-center h-9 px-4 rounded-md bg-surface-3 text-text hover:bg-surface-2 border border-border cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
            onClick={handleTest}
            disabled={!isValid || testing}
          >
            {testing ? 'Testing...' : 'Test Connection'}
          </button>
          <button
            className="inline-flex items-center justify-center h-9 px-4 rounded-md bg-accent-500 text-accent-50 hover:bg-accent-400 border-0 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
            onClick={handleAdd}
            disabled={!isValid}
          >
            Add
          </button>
        </div>
      </div>
    </div>
  )
}
