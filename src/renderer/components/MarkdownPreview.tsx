import React, { useMemo } from 'react'
import { marked } from 'marked'
import hljs from 'highlight.js/lib/common'
import DOMPurify from 'dompurify'

marked.setOptions({
  gfm: true,
  breaks: false
})

const renderer = new marked.Renderer()
renderer.code = function ({ text, lang }: { text: string; lang?: string }) {
  const language = lang && hljs.getLanguage(lang) ? lang : undefined
  const highlighted = language
    ? hljs.highlight(text, { language }).value
    : hljs.highlightAuto(text).value
  return `<pre><code class="hljs${language ? ` language-${language}` : ''}">${highlighted}</code></pre>`
}

marked.use({ renderer })

interface Props {
  content: string
  effectiveTheme: 'dark' | 'light'
  /** 'absolute' fills the nearest positioned ancestor (default). 'flow' lays out in normal document flow. */
  variant?: 'absolute' | 'flow'
}

export default function MarkdownPreview({ content, variant = 'absolute' }: Props): React.ReactElement {
  const sanitizedHtml = useMemo(() => {
    const raw = marked.parse(content) as string
    return DOMPurify.sanitize(raw)
  }, [content])

  const className = variant === 'absolute'
    ? 'note-preview absolute inset-0 overflow-y-auto px-8 py-6 font-sans text-[14px] leading-[1.6] text-text bg-bg'
    : 'note-preview font-sans text-[14px] leading-[1.6] text-text'

  // Content is sanitized via DOMPurify above before being inserted as innerHTML
  return (
    <div
      className={className}
      dangerouslySetInnerHTML={{ __html: sanitizedHtml }}
    />
  )
}
