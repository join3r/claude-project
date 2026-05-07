import React, { useEffect, useMemo, useRef, useState } from 'react'
import { AI_TAB_TYPES, AI_TAB_META } from '../../shared/types'
import type { Project, AiTabType } from '../../shared/types'
import { useApp } from '../context/AppContext'
import {
  dashboardIconUrl,
  fetchDashboardIconsMetadata,
  searchDashboardIcons,
  type DashboardIconsMetadata,
} from './dashboardIcons'

interface Props {
  project: Project
  onSave: (payload: { aiToolArgs: Partial<Record<AiTabType, string>>; emoji?: string; icon?: string }) => void
  onClose: () => void
}

export default function ProjectSettings({ project, onSave, onClose }: Props): React.ReactElement {
  const { effectiveTheme } = useApp()
  const [args, setArgs] = useState<Partial<Record<AiTabType, string>>>(
    project.aiToolArgs ?? {}
  )
  const [emoji, setEmoji] = useState(project.emoji ?? '')
  const [icon, setIcon] = useState(project.icon ?? '')
  const [iconQuery, setIconQuery] = useState('')
  const [iconMetadata, setIconMetadata] = useState<DashboardIconsMetadata | null>(null)
  const [iconError, setIconError] = useState<string | null>(null)
  const [showSuggestions, setShowSuggestions] = useState(false)
  const suggestionsRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let cancelled = false
    fetchDashboardIconsMetadata()
      .then((m) => { if (!cancelled) setIconMetadata(m) })
      .catch((e) => { if (!cancelled) setIconError(e instanceof Error ? e.message : 'Failed to load icons') })
    return () => { cancelled = true }
  }, [])

  const suggestions = useMemo(() => {
    if (!iconMetadata || !iconQuery.trim()) return []
    return searchDashboardIcons(iconMetadata, iconQuery, 12)
  }, [iconMetadata, iconQuery])

  const previewUrl = useMemo(
    () => dashboardIconUrl(icon, { theme: effectiveTheme, metadata: iconMetadata ?? undefined }),
    [icon, effectiveTheme, iconMetadata],
  )

  const handleSave = () => {
    const cleaned: Partial<Record<AiTabType, string>> = {}
    for (const tool of AI_TAB_TYPES) {
      const val = args[tool]?.trim()
      if (val) cleaned[tool] = val
    }
    onSave({
      aiToolArgs: cleaned,
      emoji: emoji.trim() || undefined,
      icon: icon.trim() || undefined,
    })
    onClose()
  }

  const pickSuggestion = (slug: string) => {
    setIcon(slug)
    setIconQuery('')
    setShowSuggestions(false)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        className="w-[440px] max-w-[90vw] rounded-xl border border-border bg-surface-2 shadow-2xl flex flex-col max-h-[85vh]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-border shrink-0">
          <h2 className="text-[14px] font-semibold text-text m-0">Project Settings</h2>
          <button
            onClick={onClose}
            className="bg-transparent border-0 text-text-muted cursor-pointer text-[18px] leading-none px-1 rounded-sm hover:text-text"
          >
            &times;
          </button>
        </div>

        {/* body */}
        <div className="p-5 flex flex-col gap-4 overflow-y-auto">
          <div className="flex flex-col gap-1">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-text-subtle">Dashboard Icon</span>
            <div className="flex items-center gap-2.5 relative">
              <div className="w-9 h-9 rounded-md border border-border bg-surface-1 flex items-center justify-center shrink-0 overflow-hidden">
                {previewUrl ? (
                  <img
                    src={previewUrl}
                    alt=""
                    className="w-6 h-6 object-contain"
                    onError={(e) => { (e.currentTarget as HTMLImageElement).style.visibility = 'hidden' }}
                    onLoad={(e) => { (e.currentTarget as HTMLImageElement).style.visibility = 'visible' }}
                  />
                ) : emoji ? (
                  <span className="text-[18px] leading-none">{emoji}</span>
                ) : (
                  <span className="text-text-subtle text-[10px]">none</span>
                )}
              </div>
              <div className="flex-1 flex flex-col gap-1 min-w-0">
                <input
                  value={icon}
                  onChange={(e) => { setIcon(e.target.value); setIconQuery(e.target.value); setShowSuggestions(true) }}
                  onFocus={() => setShowSuggestions(true)}
                  onBlur={() => setTimeout(() => setShowSuggestions(false), 150)}
                  placeholder="slug (e.g. vscode) or full URL"
                  className="h-9 rounded-md bg-surface-2 border border-border px-2.5 text-text focus:border-border-focus outline-none text-[13px]"
                />
                <span className="text-[11px] text-text-subtle">
                  Search icons at{' '}
                  <a
                    href="https://dashboardicons.com/"
                    target="_blank"
                    rel="noreferrer"
                    className="underline hover:text-text"
                  >
                    dashboardicons.com
                  </a>
                  {iconError && <span className="ml-2 text-text-muted">({iconError})</span>}
                </span>
              </div>
              {showSuggestions && suggestions.length > 0 && (
                <div
                  ref={suggestionsRef}
                  className="absolute left-[46px] right-0 top-[40px] z-10 max-h-60 overflow-y-auto rounded-md border border-border bg-surface-2 shadow-lg"
                >
                  {suggestions.map((hit) => {
                    const url = dashboardIconUrl(hit.slug, { theme: effectiveTheme, metadata: iconMetadata ?? undefined })
                    return (
                      <button
                        key={hit.slug}
                        type="button"
                        onMouseDown={(e) => { e.preventDefault(); pickSuggestion(hit.slug) }}
                        className="w-full flex items-center gap-2 px-2 py-1.5 text-left bg-transparent border-0 cursor-pointer hover:bg-surface-3 text-text text-[13px]"
                      >
                        {url && <img src={url} alt="" className="w-4 h-4 object-contain shrink-0" />}
                        <span className="truncate">{hit.slug}</span>
                        {hit.matchedAlias && (
                          <span className="text-text-subtle text-[11px] truncate">— {hit.matchedAlias}</span>
                        )}
                      </button>
                    )
                  })}
                </div>
              )}
            </div>
          </div>

          <label className="flex flex-col gap-1">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-text-subtle">Emoji (fallback)</span>
            <input
              value={emoji}
              onChange={(e) => setEmoji(e.target.value.slice(0, 4))}
              placeholder="e.g. 📁"
              className="w-20 h-9 rounded-md bg-surface-2 border border-border px-2.5 text-text"
            />
          </label>

          <div className="flex flex-col gap-1">
            <label className="text-[11px] font-semibold uppercase tracking-wider text-text-subtle">
              AI Tool Arguments
            </label>
            <div className="flex flex-col gap-2 mt-1">
              {AI_TAB_TYPES.map((tool) => (
                <div key={tool} className="flex items-center gap-2.5">
                  <span className="text-[13px] text-text min-w-[90px] shrink-0">{AI_TAB_META[tool].label}</span>
                  <input
                    className="flex-1 h-9 px-3 rounded-md bg-surface-2 border border-border text-text focus:border-border-focus outline-none text-[13px]"
                    value={args[tool] ?? ''}
                    onChange={(e) => setArgs({ ...args, [tool]: e.target.value })}
                    placeholder="e.g. --model sonnet"
                  />
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* footer */}
        <div className="flex items-center justify-end px-5 py-3 border-t border-border shrink-0">
          <button
            onClick={handleSave}
            className="h-8 px-4 rounded-md bg-accent-500 hover:bg-accent-600 text-white text-[13px] font-medium border-0 cursor-pointer transition-colors"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  )
}
