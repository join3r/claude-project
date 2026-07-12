import React, { useEffect, useMemo, useRef, useState } from 'react'
import { AI_TAB_TYPES, AI_TAB_META } from '../../shared/types'
import type { Project, AiTabType } from '../../shared/types'
import { useApp } from '../context/AppContext'
import TagPicker from './TagPicker'
import { Modal, SetBlock, Field, HelperText, PrimaryButton } from './ui'
import {
  dashboardIconUrl,
  fetchDashboardIconsMetadata,
  searchDashboardIcons,
  type DashboardIconsMetadata,
} from './dashboardIcons'

interface Props {
  project: Project
  onSave: (payload: {
    aiToolArgs: Partial<Record<AiTabType, string>>
    emoji?: string
    icon?: string
    tagIds?: string[]
  }) => void
  onClose: () => void
}

export default function ProjectSettings({ project, onSave, onClose }: Props): React.ReactElement {
  const { effectiveTheme, tags, addTag } = useApp()
  const [args, setArgs] = useState<Partial<Record<AiTabType, string>>>(
    project.aiToolArgs ?? {}
  )
  const [emoji, setEmoji] = useState(project.emoji ?? '')
  const [icon, setIcon] = useState(project.icon ?? '')
  const [iconQuery, setIconQuery] = useState('')
  const [iconMetadata, setIconMetadata] = useState<DashboardIconsMetadata | null>(null)
  const [iconError, setIconError] = useState<string | null>(null)
  const [showSuggestions, setShowSuggestions] = useState(false)
  const [tagIds, setTagIds] = useState<string[]>(project.tagIds ?? [])
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
      tagIds,
    })
    onClose()
  }

  const pickSuggestion = (slug: string) => {
    setIcon(slug)
    setIconQuery('')
    setShowSuggestions(false)
  }

  return (
    <Modal
      title="Project Settings"
      onClose={onClose}
      footer={<PrimaryButton onClick={handleSave}>Save</PrimaryButton>}
    >
      <SetBlock label="Dashboard icon">
        <div className="flex items-center gap-2.5 relative">
          <div className="size-(--ctl-h-lg) rounded-md border border-border bg-field flex items-center justify-center shrink-0 overflow-hidden">
            {previewUrl ? (
              <img
                src={previewUrl}
                alt=""
                className="w-6 h-6 object-contain"
                onError={(e) => { (e.currentTarget as HTMLImageElement).style.visibility = 'hidden' }}
                onLoad={(e) => { (e.currentTarget as HTMLImageElement).style.visibility = 'visible' }}
              />
            ) : emoji ? (
              <span className="text-lg leading-none">{emoji}</span>
            ) : (
              <span className="text-text-subtle text-2xs">none</span>
            )}
          </div>
          <div className="flex-1 flex flex-col gap-1 min-w-0">
            <Field
              value={icon}
              onChange={(e) => { setIcon(e.target.value); setIconQuery(e.target.value); setShowSuggestions(true) }}
              onFocus={() => setShowSuggestions(true)}
              onBlur={() => setTimeout(() => setShowSuggestions(false), 150)}
              placeholder="slug (e.g. vscode) or full URL"
            />
            <span className="text-xs text-text-subtle">
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
              className="absolute left-[42px] right-0 top-[32px] z-(--z-popover) max-h-60 overflow-y-auto rounded-lg border border-border bg-surface shadow-pop p-1"
            >
              {suggestions.map((hit) => {
                const url = dashboardIconUrl(hit.slug, { theme: effectiveTheme, metadata: iconMetadata ?? undefined })
                return (
                  <button
                    key={hit.slug}
                    type="button"
                    onMouseDown={(e) => { e.preventDefault(); pickSuggestion(hit.slug) }}
                    className="w-full flex items-center gap-2 rounded-md px-2 py-1 text-left bg-transparent border-0 cursor-pointer hover:bg-sel text-text text-base"
                  >
                    {url && <img src={url} alt="" className="w-4 h-4 object-contain shrink-0" />}
                    <span className="truncate">{hit.slug}</span>
                    {hit.matchedAlias && (
                      <span className="text-text-subtle text-xs truncate">— {hit.matchedAlias}</span>
                    )}
                  </button>
                )
              })}
            </div>
          )}
        </div>
      </SetBlock>

      <TagPicker
        selectedTagIds={tagIds}
        onChange={setTagIds}
        allTags={tags}
        onEnsureTag={addTag}
      />

      <SetBlock label="Emoji (fallback)">
        <Field
          className="w-20"
          value={emoji}
          onChange={(e) => setEmoji(e.target.value.slice(0, 4))}
          placeholder="e.g. 📁"
        />
      </SetBlock>

      <SetBlock label="AI tool arguments">
        <div className="flex flex-col gap-1.5">
          {AI_TAB_TYPES.map((tool) => (
            <div key={tool} className="flex items-center gap-2.5">
              <span className="text-base text-text min-w-[90px] shrink-0">{AI_TAB_META[tool].label}</span>
              <Field
                className="flex-1"
                value={args[tool] ?? ''}
                onChange={(e) => setArgs({ ...args, [tool]: e.target.value })}
                placeholder="e.g. --model sonnet"
              />
            </div>
          ))}
        </div>
        <HelperText>Extra CLI arguments passed when the tool starts in this project.</HelperText>
      </SetBlock>
    </Modal>
  )
}
