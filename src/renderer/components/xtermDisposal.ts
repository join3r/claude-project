/**
 * Workaround for an upstream xterm.js bug that crashes the renderer with
 * "Cannot read properties of undefined (reading 'dimensions')".
 *
 * When the app running in the terminal enables mouse tracking (Claude Code,
 * vim, htop, ...), xterm's bindMouse() arms raw document-level mouseup and
 * mousemove listeners on every mousedown. They normally disarm themselves on
 * the next document mouseup, but if the button is released outside the window
 * (drag out to another app) they stay armed — and Terminal.dispose() does not
 * remove them. The next mouseup in the window then calls
 * getMouseReportCoords() on the disposed terminal, whose RenderService reads
 * `this._renderer.value.dimensions` with value already undefined. Worse, the
 * throw happens before the listener's self-removal, so every subsequent click
 * crashes again until the app is restarted.
 *
 * The armed listeners live in a closure xterm doesn't expose, so the only
 * non-forking way to disarm them is to deliver the document mouseup they are
 * waiting for. Must be called BEFORE term.dispose() — afterwards the listener
 * itself throws.
 */
export function disarmXtermDocMouseListeners(doc: Document = document): void {
  doc.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0, buttons: 0 }))
}
