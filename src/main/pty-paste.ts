/**
 * Text main pastes into a terminal agent on its own (a landing's "Ask agent to
 * fix"). Parts of it come from outside DevTool (file names from git), so every
 * control character but `\n` becomes U+FFFD first: an ESC or C1 byte could
 * otherwise end the bracketed paste early (`\x1b[201~`) and type the rest as
 * keystrokes.
 */

const CONTROL_CHARS = /[\x00-\x09\x0b-\x1f\x7f-\x9f]/g

export function sanitizePasteText(text: string): string {
  return text.replace(CONTROL_CHARS, '�')
}

/** `text`, sanitized, as one bracketed paste. */
export function bracketedPaste(text: string): string {
  return `\x1b[200~${sanitizePasteText(text)}\x1b[201~`
}
