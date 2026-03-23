interface Disposable {
  dispose(): void
}

interface SelectableTerminal {
  onSelectionChange(listener: () => void): Disposable
  getSelection(): string
}

export async function writeClipboardText(text: string): Promise<void> {
  try {
    await window.api.clipboardWriteText(text)
  } catch {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
    }
  }
}

export function bindCopyOnSelect(
  terminal: SelectableTerminal,
  writeText: (text: string) => Promise<void> = writeClipboardText
): Disposable {
  return terminal.onSelectionChange(() => {
    const selection = terminal.getSelection()
    if (!selection) return
    void writeText(selection).catch(() => {})
  })
}
