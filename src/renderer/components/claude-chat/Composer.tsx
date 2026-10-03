import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ArrowUp, Square, SquareTerminal, X } from 'lucide-react'
import {
  CHAT_PERMISSION_MODES,
  PERMISSIONS_COMMAND,
  TERMINAL_ONLY_COMMANDS,
  findModelOption,
  parseSideQuestion,
  type ChatCommand,
  type ChatImage,
  type ChatModelOption,
  type ChatSessionInfo,
  type ChatUsage
} from '../../../shared/claude-chat'
import ChipMenu from './ChipMenu'
import UsageMeter from './UsageMeter'
import { menuCls } from '../ui'
import { onAgentInsert } from '../../agentLink/linkToAgent'

interface Attachment extends ChatImage {
  id: string
  preview: string
}

interface Props {
  busy: boolean
  disabled?: boolean
  info: ChatSessionInfo
  usage?: ChatUsage
  models: ChatModelOption[]
  commands: ChatCommand[]
  /** Loaded on the first `@`; the project's files as git lists them. */
  loadFiles: () => Promise<string[]>
  onSend: (text: string, images: ChatImage[]) => void
  /** `/btw <question>`: answered beside the conversation, not sent into it. */
  onSideQuestion: (question: string) => void
  /** `!command`: run in the project's shell; Claude gets it with the next message. */
  onBash: (command: string) => void
  /** `/permissions`: DevTool's own rules editor (the CLI's is terminal-only). */
  onPermissions: () => void
  onStop: () => void
  onSetModel: (model: string | undefined) => void
  onSetMode: (mode: string) => void
  onSetEffort: (effort: string | undefined) => void
  onOpenInTerminal: () => void
  /** Focus the textarea when this flips true (tab shown). */
  focusSignal: boolean
  /** Receive agent links (Ctrl+L from an editor/notebook) addressed to this tab. */
  tabId?: string
}

const MAX_IMAGE_BYTES = 5 * 1024 * 1024
const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max']
const MODE_CYCLE = ['default', 'acceptEdits', 'plan', 'auto']

type Suggest =
  | { kind: 'file'; start: number; query: string }
  | { kind: 'command'; start: number; query: string }

/** The `@file` or leading `/command` token the caret is in, if any. */
function tokenAt(text: string, caret: number): Suggest | null {
  let start = caret
  while (start > 0 && !/\s/.test(text[start - 1])) start--
  const token = text.slice(start, caret)
  if (token.startsWith('@')) return { kind: 'file', start, query: token.slice(1) }
  if (token.startsWith('/') && start === 0) return { kind: 'command', start, query: token.slice(1) }
  return null
}

function rankFiles(files: string[], query: string): string[] {
  const q = query.toLowerCase()
  if (!q) return files.slice(0, 50)
  const scored: { file: string; score: number }[] = []
  for (const file of files) {
    const lower = file.toLowerCase()
    const at = lower.indexOf(q)
    if (at < 0) continue
    const base = lower.slice(lower.lastIndexOf('/') + 1)
    const score = (base.startsWith(q) ? 0 : base.includes(q) ? 100 : 200) + at * 0.01 + file.length * 0.001
    scored.push({ file, score })
  }
  return scored.sort((a, b) => a.score - b.score).slice(0, 50).map((entry) => entry.file)
}

function readImage(file: File): Promise<Attachment | null> {
  if (!file.type.startsWith('image/') || file.size > MAX_IMAGE_BYTES) return Promise.resolve(null)
  return new Promise((resolve) => {
    const reader = new FileReader()
    reader.onload = () => {
      const url = String(reader.result ?? '')
      const comma = url.indexOf(',')
      if (comma < 0) return resolve(null)
      resolve({ id: `${Date.now()}-${Math.random()}`, mediaType: file.type, data: url.slice(comma + 1), preview: url })
    }
    reader.onerror = () => resolve(null)
    reader.readAsDataURL(file)
  })
}

export default function Composer(props: Props): React.ReactElement {
  const { busy, disabled, info, usage, models, commands, loadFiles, onSend, onSideQuestion, onBash, onPermissions, onStop, onSetModel, onSetMode, onSetEffort, onOpenInTerminal, focusSignal, tabId } = props
  const [text, setText] = useState('')
  const textRef = useRef(text)
  textRef.current = text
  const [images, setImages] = useState<Attachment[]>([])
  const [suggest, setSuggest] = useState<Suggest | null>(null)
  const [highlight, setHighlight] = useState(0)
  const [files, setFiles] = useState<string[] | null>(null)
  const filesLoading = useRef(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (focusSignal) textareaRef.current?.focus()
  }, [focusSignal])

  // An agent link lands at the caret (a space before it if it would touch a word),
  // and the caret ends up after it, ready for the question.
  useEffect(() => {
    if (!tabId) return
    return onAgentInsert(tabId, (insert) => {
      const el = textareaRef.current
      const prev = textRef.current
      const caret = Math.min(el?.selectionStart ?? prev.length, prev.length)
      const lead = caret > 0 && !/\s/.test(prev[caret - 1]) ? ' ' : ''
      const next = prev.slice(0, caret) + lead + insert + prev.slice(caret)
      const position = caret + lead.length + insert.length
      textRef.current = next
      setText(next)
      setSuggest(null)
      requestAnimationFrame(() => {
        el?.focus()
        el?.setSelectionRange(position, position)
      })
    })
  }, [tabId])

  // Autosize up to a cap; the timeline keeps the rest of the pane. A hidden
  // tab measures 0, so leave the natural one-row height and re-measure on show.
  useLayoutEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    if (el.scrollHeight === 0) return
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`
  }, [text, focusSignal])

  useEffect(() => {
    if (suggest?.kind !== 'file' || files || filesLoading.current) return
    filesLoading.current = true
    void loadFiles().then((list) => setFiles(list)).finally(() => { filesLoading.current = false })
  }, [suggest, files, loadFiles])

  const options = useMemo(() => {
    if (!suggest) return []
    if (suggest.kind === 'file') {
      return rankFiles(files ?? [], suggest.query).map((file) => ({ value: file, label: file, description: undefined as string | undefined }))
    }
    const q = suggest.query.toLowerCase()
    const rank = (name: string): number => (name.startsWith(q) ? 0 : name.includes(q) ? 1 : 2)
    return commands
      .filter((command) => rank(command.name.toLowerCase()) < (q.length > 1 ? 2 : 1))
      .sort((a, b) => rank(a.name.toLowerCase()) - rank(b.name.toLowerCase()) || a.name.localeCompare(b.name))
      .slice(0, 50)
      .map((command) => ({
        value: command.name,
        label: `/${command.name}${command.argumentHint ? ` ${command.argumentHint}` : ''}`,
        description: TERMINAL_ONLY_COMMANDS.has(command.name) && command.name !== PERMISSIONS_COMMAND.name ? 'Terminal only — opens this session in a terminal tab' : command.description
      }))
  }, [suggest, files, commands])

  useEffect(() => { setHighlight(0) }, [suggest?.kind, suggest?.query])

  const refreshSuggest = (value: string, caret: number): void => {
    setSuggest(tokenAt(value, caret))
  }

  const accept = (value: string): void => {
    if (!suggest) return
    const el = textareaRef.current
    const caret = el?.selectionStart ?? text.length
    if (suggest.kind === 'command' && value === PERMISSIONS_COMMAND.name) {
      setSuggest(null)
      setText('')
      onPermissions()
      return
    }
    if (suggest.kind === 'command' && TERMINAL_ONLY_COMMANDS.has(value)) {
      setSuggest(null)
      onOpenInTerminal()
      return
    }
    const insert = suggest.kind === 'file' ? `@${value} ` : `/${value} `
    const next = text.slice(0, suggest.start) + insert + text.slice(caret)
    setText(next)
    setSuggest(null)
    const position = suggest.start + insert.length
    requestAnimationFrame(() => {
      el?.focus()
      el?.setSelectionRange(position, position)
    })
  }

  const submit = (): void => {
    const trimmed = text.trim()
    if (!trimmed && images.length === 0) return
    if (trimmed.startsWith('!')) {
      // Attached images stay for the next real message.
      const command = trimmed.slice(1).trim()
      if (!command) return
      onBash(command)
      setText('')
      setSuggest(null)
      return
    }
    const command = /^\/(\S+)/.exec(trimmed)?.[1]
    if (command === PERMISSIONS_COMMAND.name) {
      onPermissions()
      setText('')
      setSuggest(null)
      return
    }
    if (command && TERMINAL_ONLY_COMMANDS.has(command)) {
      onOpenInTerminal()
      return
    }
    const side = parseSideQuestion(trimmed)
    if (side !== null) {
      // Text only: attached images stay for the next real message.
      if (!side) return
      onSideQuestion(side)
      setText('')
      setSuggest(null)
      return
    }
    onSend(trimmed, images.map(({ mediaType, data }) => ({ mediaType, data })))
    setText('')
    setImages([])
    setSuggest(null)
  }

  const addFiles = useCallback(async (list: FileList | File[]): Promise<void> => {
    const read = await Promise.all(Array.from(list).map(readImage))
    const ok = read.filter((a): a is Attachment => a !== null)
    if (ok.length) setImages((prev) => [...prev, ...ok])
  }, [])

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (suggest && options.length > 0) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setHighlight((h) => (h + 1) % options.length); return }
      if (e.key === 'ArrowUp') { e.preventDefault(); setHighlight((h) => (h - 1 + options.length) % options.length); return }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); accept(options[highlight].value); return }
    }
    if (e.key === 'Escape') {
      if (suggest) { e.preventDefault(); setSuggest(null); return }
      if (busy) { e.preventDefault(); onStop(); return }
    }
    if (e.key === 'Tab' && e.shiftKey) {
      e.preventDefault()
      const current = MODE_CYCLE.indexOf(info.permissionMode ?? 'default')
      onSetMode(MODE_CYCLE[(current + 1) % MODE_CYCLE.length])
      return
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.altKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      submit()
    }
  }

  // The CLI's own "Default" row resolves to a real model; name that model, not the row.
  const pickable = models.filter((m) => m.value !== 'default')
  const modelName = (model: string | undefined): string | undefined =>
    model ? findModelOption(pickable, model)?.displayName ?? model.replace(/^claude-/, '') : undefined
  const currentModel = findModelOption(pickable, info.applied?.model ?? info.model)
  // A tab that never picked a model runs the settings default; `applied` names it once read.
  const defaultModel = info.modelPicked ? undefined : modelName(info.applied?.model ?? info.model)
  const modelLabel = info.modelPicked
    ? modelName(info.model) ?? 'Model'
    : defaultModel ? `Model: Default (${defaultModel})` : 'Model: Default'
  const modelOptions = [
    { value: '', label: defaultModel ? `Default (${defaultModel})` : 'Default', description: 'What your Claude settings pick' },
    ...pickable.map((m) => ({ value: m.value, label: m.displayName, description: m.description }))
  ]
  const effortLevels = currentModel?.supportedEffortLevels?.length ? currentModel.supportedEffortLevels : EFFORT_LEVELS
  // `applied.effort` is null when no effort is sent (a model without effort levels).
  const defaultEffort = info.effort ? undefined : info.applied?.effort ?? undefined
  const modeLabel = CHAT_PERMISSION_MODES.find((m) => m.value === info.permissionMode)?.label ?? 'Ask'
  const canSend = !disabled && (text.trim().length > 0 || images.length > 0)
  const bashMode = text.trimStart().startsWith('!')

  return (
    <div
      className={`relative rounded-xl border-[0.5px] bg-field shadow-[0_1px_3px_rgba(0,0,0,0.12)] transition-colors duration-(--motion-fast) ${bashMode ? 'border-accent' : 'border-border-strong focus-within:border-border-focus'}`}
      onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) e.preventDefault() }}
      onDrop={(e) => {
        if (e.dataTransfer.files.length === 0) return
        e.preventDefault()
        void addFiles(e.dataTransfer.files)
      }}
    >
      {suggest && options.length > 0 && (
        <div className={`absolute bottom-full mb-1.5 left-0 right-0 z-(--z-menu) max-h-64 overflow-auto ${menuCls}`}>
          {options.map((option, index) => (
            <button
              key={`${index}:${option.value}`}
              type="button"
              onMouseDown={(e) => { e.preventDefault(); accept(option.value) }}
              onMouseEnter={() => setHighlight(index)}
              className={`block w-full rounded-md px-2.5 py-1 border-0 text-left cursor-pointer ${index === highlight ? 'bg-sel' : 'bg-transparent'}`}
            >
              <div className={`text-sm text-text truncate ${suggest.kind === 'file' ? 'font-mono text-xs' : ''}`}>{option.label}</div>
              {option.description && <div className="text-xs text-text-muted truncate">{option.description}</div>}
            </button>
          ))}
        </div>
      )}
      {images.length > 0 && (
        <div className="flex flex-wrap gap-1.5 px-2.5 pt-2.5">
          {images.map((image) => (
            <div key={image.id} className="relative group">
              <img src={image.preview} alt="" className="h-14 w-14 object-cover rounded-md border-[0.5px] border-border" />
              <button
                type="button"
                title="Remove"
                onClick={() => setImages((prev) => prev.filter((i) => i.id !== image.id))}
                className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full border-0 bg-surface-3 text-text flex items-center justify-center cursor-pointer opacity-0 group-hover:opacity-100"
              >
                <X size={10} />
              </button>
            </div>
          ))}
        </div>
      )}
      <textarea
        ref={textareaRef}
        rows={1}
        value={text}
        disabled={disabled}
        placeholder={busy ? 'Add to the conversation — Claude reads it at its next step' : 'Message Claude — @ for files, / for commands, ! for shell'}
        onChange={(e) => {
          setText(e.target.value)
          refreshSuggest(e.target.value, e.target.selectionStart)
        }}
        onSelect={(e) => refreshSuggest(e.currentTarget.value, e.currentTarget.selectionStart)}
        onBlur={() => setSuggest(null)}
        onKeyDown={onKeyDown}
        onPaste={(e) => {
          const pasted = Array.from(e.clipboardData.files).filter((file) => file.type.startsWith('image/'))
          if (pasted.length > 0) {
            e.preventDefault()
            void addFiles(pasted)
          }
        }}
        className="block w-full resize-none bg-transparent border-0 outline-none px-3 pt-2.5 pb-1 text-base text-text placeholder:text-text-subtle leading-[1.5] min-h-[38px] max-h-60"
      />
      <div className="flex items-center gap-0.5 px-1.5 pb-1.5">
        {bashMode && (
          <span className="px-1.5 text-xs text-accent" title="Runs in the project's shell. Claude gets the command and its output with your next message.">
            Shell command
          </span>
        )}
        <ChipMenu
          label={modelLabel}
          title="Model"
          options={modelOptions}
          value={info.modelPicked ? currentModel?.value ?? info.model ?? '' : ''}
          onChange={(value) => onSetModel(value || undefined)}
        />
        <ChipMenu
          label={modeLabel}
          title="Permission mode (Shift+Tab cycles)"
          options={CHAT_PERMISSION_MODES.map((m) => ({ value: m.value, label: m.label, description: MODE_HELP[m.value] }))}
          value={info.permissionMode ?? 'default'}
          onChange={onSetMode}
        />
        <ChipMenu
          label={info.effort ? `Effort: ${info.effort}` : defaultEffort ? `Effort: Default (${defaultEffort})` : 'Effort: Default'}
          title="Thinking effort"
          options={[{ value: '', label: defaultEffort ? `Default (${defaultEffort})` : 'Default' }, ...effortLevels.map((level) => ({ value: level, label: level }))]}
          value={info.effort ?? ''}
          onChange={(value) => onSetEffort(value || undefined)}
        />
        <div className="flex-1" />
        <UsageMeter usage={usage ?? {}} />
        <button
          type="button"
          title="Open this session in a terminal tab"
          onClick={onOpenInTerminal}
          className="w-6 h-6 inline-flex items-center justify-center rounded-md border-0 bg-transparent text-text-subtle cursor-pointer hover:bg-surface-3 hover:text-text"
        >
          <SquareTerminal size={14} />
        </button>
        {busy && (
          <button
            type="button"
            title="Stop (Esc)"
            onClick={onStop}
            className="w-6 h-6 inline-flex items-center justify-center rounded-md border-0 bg-surface-3 text-text cursor-pointer hover:brightness-110"
          >
            <Square size={10} fill="currentColor" />
          </button>
        )}
        <button
          type="button"
          title="Send (Enter)"
          disabled={!canSend}
          onClick={submit}
          className="w-6 h-6 inline-flex items-center justify-center rounded-md border-0 bg-accent text-accent-ink cursor-pointer hover:brightness-105 disabled:opacity-35 disabled:cursor-default"
        >
          <ArrowUp size={14} strokeWidth={2.5} />
        </button>
      </div>
    </div>
  )
}

export const MODE_HELP: Record<string, string> = {
  default: 'Ask before edits and commands your rules don’t allow',
  acceptEdits: 'Edit files without asking; still ask for commands',
  plan: 'Research and propose a plan; change nothing',
  auto: 'Let Claude’s classifier approve safe actions',
  bypassPermissions: 'Never ask — everything is allowed'
}
