import type { TabStatusValue } from '../context/TabStatusContext'

// Shells and TUIs set the window title with OSC <text> BEL, so a raw \x07 only
// counts as a bell once those sequences are stripped — otherwise every prompt rings.
const OSC_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g
const READY_RE = /\b(ready|listening|served|compiled successfully)\b/i

/** True when the chunk contains a real terminal bell (not an OSC terminator). */
export function hasBell(chunk: string): boolean {
  return chunk.replace(OSC_RE, '').includes('\x07')
}

/**
 * Status for a plain terminal tab from a chunk of PTY output.
 *
 * Attention comes from the bell only. Matching text like "error"/"failed" was far
 * too eager — `npm test` printing "1 failed", a grep hit, a stack trace in a dev
 * server log — and it rolled up into the inbox's "Needs you" tier identically to a
 * blocked agent. A bell is something a program rings on purpose.
 */
export function terminalStatusFromOutput(chunk: string, prev: TabStatusValue): TabStatusValue {
  if (hasBell(chunk)) return 'attention'

  // Title updates ride along with every prompt redraw; they are not output.
  const lines = chunk.replace(OSC_RE, '').split(/\r?\n/).filter((l) => l.trim().length > 0)
  const lastLine = lines[lines.length - 1]
  // Nothing printable in this chunk — no news either way.
  if (!lastLine) return prev

  if (READY_RE.test(lastLine)) return null
  // Sticky until the user visits the tab — the bell already rang, output since then
  // doesn't mean it was answered.
  if (prev === 'attention') return 'attention'
  return 'working'
}
