import React, { useMemo } from 'react'
import { marked } from 'marked'
import hljs from 'highlight.js/lib/common'
import DOMPurify from 'dompurify'
import './MarkdownPreview.css'

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
}

export default function MarkdownPreview({ content }: Props): React.ReactElement {
  const sanitizedHtml = useMemo(() => {
    const raw = marked.parse(content) as string
    return DOMPurify.sanitize(raw)
  }, [content])

  // Content is sanitized via DOMPurify above before being set as innerHTML
  return (
    <div
      className="markdown-preview"
      dangerouslySetInnerHTML={{ __html: sanitizedHtml }}
    />
  )
}
