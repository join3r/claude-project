import React, { useEffect, useMemo, useState } from 'react'
import type { Tag } from '../../shared/types'
import { X } from 'lucide-react'

interface Props {
  selectedTagIds: string[]
  onChange: (tagIds: string[]) => void
  allTags: readonly Tag[]
  onEnsureTag: (name: string) => string
}

export default function TagPicker({
  selectedTagIds,
  onChange,
  allTags,
  onEnsureTag,
}: Props): React.ReactElement {
  const [query, setQuery] = useState('')
  const [showSuggestions, setShowSuggestions] = useState(false)
  const [optimisticTags, setOptimisticTags] = useState<readonly Tag[]>([])

  useEffect(() => {
    setOptimisticTags(prev => prev.filter(t => !allTags.some(at => at.id === t.id)))
  }, [allTags])

  const tagsById = useMemo(() => {
    const map = new Map(allTags.map(t => [t.id, t]))
    for (const tag of optimisticTags) {
      map.set(tag.id, tag)
    }
    return map
  }, [allTags, optimisticTags])

  const selectedTags = useMemo(
    () => selectedTagIds.map(id => tagsById.get(id)).filter((t): t is Tag => !!t),
    [selectedTagIds, tagsById]
  )

  const suggestions = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return []
    return allTags
      .filter(t => !selectedTagIds.includes(t.id) && t.name.toLowerCase().includes(q))
      .slice(0, 8)
  }, [allTags, query, selectedTagIds])

  const removeTag = (tagId: string) => {
    onChange(selectedTagIds.filter(id => id !== tagId))
  }

  const addTagById = (tagId: string) => {
    if (!tagId || selectedTagIds.includes(tagId)) return
    onChange([...selectedTagIds, tagId])
    setQuery('')
    setShowSuggestions(false)
  }

  const commitQuery = () => {
    const trimmed = query.trim()
    if (!trimmed) return
    const existing = [...allTags, ...optimisticTags].find(
      t => t.name.toLowerCase() === trimmed.toLowerCase()
    )
    if (existing) {
      addTagById(existing.id)
      return
    }
    const tagId = onEnsureTag(trimmed)
    if (!tagId) return
    setOptimisticTags(prev => (
      prev.some(t => t.id === tagId) ? prev : [...prev, { id: tagId, name: trimmed }]
    ))
    addTagById(tagId)
  }

  return (
    <div className="flex flex-col gap-2">
      <span className="text-[11px] font-semibold uppercase tracking-wider text-text-subtle">Tags</span>
      {selectedTags.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {selectedTags.map(tag => (
            <span
              key={tag.id}
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-surface-3 border border-border text-[11px] text-text"
            >
              {tag.name}
              <button
                type="button"
                className="bg-transparent border-0 p-0 cursor-pointer text-text-muted hover:text-text leading-none"
                onClick={() => removeTag(tag.id)}
                aria-label={`Remove tag ${tag.name}`}
              >
                <X size={12} />
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="relative">
        <input
          className="h-9 w-full px-3 rounded-md bg-surface-2 border border-border text-text text-[13px] focus:border-border-focus outline-none"
          value={query}
          onChange={(e) => { setQuery(e.target.value); setShowSuggestions(true) }}
          onFocus={() => setShowSuggestions(true)}
          onBlur={(e) => {
            const next = e.relatedTarget
            if (next instanceof Node && e.currentTarget.parentElement?.contains(next)) return
            setTimeout(() => setShowSuggestions(false), 150)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              commitQuery()
            } else if (e.key === 'Escape') {
              setQuery('')
              setShowSuggestions(false)
            }
          }}
          placeholder="Add tag…"
        />
        {showSuggestions && (suggestions.length > 0 || query.trim()) && (
          <div className="absolute left-0 right-0 top-full mt-1 z-10 max-h-40 overflow-y-auto rounded-md border border-border bg-surface-2 shadow-lg">
            {suggestions.map(tag => (
              <button
                key={tag.id}
                type="button"
                className="w-full px-3 py-1.5 text-left bg-transparent border-0 cursor-pointer hover:bg-surface-3 text-text text-[13px]"
                onMouseDown={(e) => { e.preventDefault(); addTagById(tag.id) }}
              >
                {tag.name}
              </button>
            ))}
            {query.trim() && !suggestions.some(t => t.name.toLowerCase() === query.trim().toLowerCase()) && (
              <button
                type="button"
                className="w-full px-3 py-1.5 text-left bg-transparent border-0 cursor-pointer hover:bg-surface-3 text-text-subtle text-[13px] italic"
                onMouseDown={(e) => { e.preventDefault(); commitQuery() }}
              >
                Create &quot;{query.trim()}&quot;
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
