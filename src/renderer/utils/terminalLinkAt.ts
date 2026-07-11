import type { Terminal } from '@xterm/xterm'

/** Same pattern as @xterm/addon-web-links default. */
export const WEB_LINK_REGEX =
  /(https?|HTTPS?):[/]{2}[^\s"'!*(){}|\\\^<>`]*[^\s"':,.!?{}|\\\^~\[\]`()<>]/

export function findLinkInLine(line: string, col: number): string | null {
  const flags = WEB_LINK_REGEX.flags.includes('g') ? WEB_LINK_REGEX.flags : `${WEB_LINK_REGEX.flags}g`
  const regex = new RegExp(WEB_LINK_REGEX.source, flags)
  let match: RegExpExecArray | null
  while ((match = regex.exec(line)) !== null) {
    const start = match.index
    const end = start + match[0].length
    if (col >= start && col < end) {
      return match[0]
    }
  }
  return null
}

export function findLinkAtPosition(term: Terminal, clientX: number, clientY: number): string | null {
  const screen = term.element?.querySelector('.xterm-screen')
  if (!screen) return null

  const rect = screen.getBoundingClientRect()
  if (rect.width === 0 || rect.height === 0) return null

  const col = Math.floor(((clientX - rect.left) / rect.width) * term.cols)
  const rowInView = Math.floor(((clientY - rect.top) / rect.height) * term.rows)
  if (col < 0 || col >= term.cols || rowInView < 0 || rowInView >= term.rows) return null

  const bufferRow = term.buffer.active.viewportY + rowInView
  const line = term.buffer.active.getLine(bufferRow)
  if (!line) return null

  const text = line.translateToString(true)
  return findLinkInLine(text, col)
}
