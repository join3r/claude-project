/**
 * Names a peer chose for itself (a phone's `deviceName`, a desktop's or a
 * server's name, a build version from a handshake) are untrusted text: anyone
 * holding a pairing link picks one. Printed raw in a terminal, ESC/CSI/OSC
 * sequences, carriage returns or backspaces in it could rewrite or hide the
 * prompt the user is answering, and bidi controls can reorder what the user
 * reads anywhere, a web page included.
 */

/** Unicode bidi embeddings, overrides, isolates and marks, and the line and paragraph separators. */
const BIDI_AND_SEPARATORS = /[\u200e\u200f\u202a-\u202e\u2066-\u2069\u2028\u2029]/gu
/** C0 and C1 control characters, DEL included (ESC, CR, LF, TAB, BS...). */
const CONTROLS = /[\u0000-\u001f\u007f-\u009f]/gu

/** At most this many characters of a peer's name are shown. */
export const PRINTABLE_MAX = 64

/** The text without bidi controls or line separators: what a page may show of a peer's name. */
export function stripBidi(text: string): string {
  return text.replace(BIDI_AND_SEPARATORS, '')
}

/**
 * A peer-chosen name made safe to print in a terminal or a log: bidi controls
 * dropped, control characters shown as U+FFFD, trimmed, and cut to `max`
 * characters with an ellipsis. Empty after that, it is `(no name)`.
 */
export function printable(text: unknown, max = PRINTABLE_MAX): string {
  const clean = stripBidi(typeof text === 'string' ? text : String(text ?? '')).replace(CONTROLS, '\ufffd').trim()
  const chars = Array.from(clean)
  const cut = chars.length > max ? `${chars.slice(0, Math.max(1, max - 1)).join('').trimEnd()}…` : clean
  return cut || '(no name)'
}
