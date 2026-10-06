import { Marked } from 'marked'
import hljs from 'highlight.js/lib/common'
import DOMPurify from 'dompurify'

/**
 * Markdown for chat messages. Its own `Marked` instance so the chat's options can
 * never drift the note preview's (and vice versa); the look comes from the
 * `.note-preview.chat-md` rules in styles.css.
 */
const chatMarked = new Marked({ gfm: true, breaks: false })

chatMarked.use({
  renderer: {
    code({ text, lang }: { text: string; lang?: string }) {
      const language = lang && hljs.getLanguage(lang) ? lang : undefined
      const highlighted = language
        ? hljs.highlight(text, { language }).value
        : escapeHtml(text)
      const run = isRunnable(text, lang)
        ? `<button type="button" class="chat-code-btn" ${RUN_ATTR}="${BUTTON_TOKEN}" title="Run as a !command in this session">Run</button>`
        : ''
      return `<div class="chat-code"><pre><code class="hljs${language ? ` language-${language}` : ''}">${highlighted}</code></pre>`
        + `<div class="chat-code-actions">${run}<button type="button" class="chat-code-btn" ${COPY_ATTR}="${BUTTON_TOKEN}" title="Copy code">Copy</button></div></div>`
    }
  }
})

const COPY_ATTR = 'data-chat-copy'
const RUN_ATTR = 'data-chat-run'
/**
 * Our buttons carry this per-window secret, so raw HTML in a message can't
 * forge one: a fake Run over a hidden `<pre>` would run what you never saw.
 */
const BUTTON_TOKEN = crypto.randomUUID()
const COPIED_MS = 1200
const SHELL_LANGS = new Set(['sh', 'bash', 'zsh', 'shell', 'console', 'shell-session'])

/** A shell block, or one Claude wrote as a `!command` for you to run. */
function isRunnable(text: string, lang: string | undefined): boolean {
  if (!runnableCommand(text)) return false
  return text.trimStart().startsWith('!') || SHELL_LANGS.has((lang ?? '').trim().toLowerCase())
}

/**
 * The command a block's Run sends: without a leading `!` (it is already bash
 * mode) or `$ ` prompts when every line carries one.
 */
export function runnableCommand(text: string): string {
  let command = text.trim().replace(/^!\s*/u, '')
  const lines = command.split('\n')
  if (lines.every((line) => !line.trim() || /^\$\s/u.test(line))) {
    command = lines.map((line) => line.replace(/^\$\s+/u, '')).join('\n')
  }
  return command.trim()
}

function ownButton(target: EventTarget | null, attr: string): HTMLElement | null {
  const button = target instanceof Element ? target.closest(`[${attr}]`) : null
  return button instanceof HTMLElement && button.getAttribute(attr) === BUTTON_TOKEN ? button : null
}

function codeOf(button: Element): string {
  return button.closest('.chat-code')?.querySelector('pre')?.textContent ?? ''
}

function flash(button: HTMLElement, label: string): void {
  const idle = button.textContent
  button.textContent = label
  window.setTimeout(() => { button.textContent = idle }, COPIED_MS)
}

/**
 * A click on a code block's Copy button (the chat renders it as HTML, so one
 * delegated handler serves every message, plan and side answer). True when it
 * was one.
 */
export function handleCodeCopyClick(target: EventTarget | null): boolean {
  const button = ownButton(target, COPY_ATTR)
  if (!button) return false
  void window.api.clipboardWriteText(codeOf(button)).then(() => flash(button, 'Copied')).catch(() => {})
  return true
}

/**
 * A click on a code block's Run button: hands the command to `run`, exactly as
 * if it had been typed into the composer after a `!`. True when it was one.
 */
export function handleCodeRunClick(target: EventTarget | null, run: (command: string) => void): boolean {
  const button = ownButton(target, RUN_ATTR)
  if (!button) return false
  const command = runnableCommand(codeOf(button))
  if (command && button.textContent === 'Run') {
    run(command)
    flash(button, 'Sent')
  }
  return true
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export function renderChatMarkdown(text: string): string {
  const raw = chatMarked.parse(text, { async: false }) as string
  // No styles: they could hide part of a code block that Run would still run.
  return DOMPurify.sanitize(raw, { FORBID_TAGS: ['style'], FORBID_ATTR: ['style'] })
}
