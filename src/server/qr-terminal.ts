import QRCore from 'qrcode/lib/core/qrcode.js'
import TerminalSmall from 'qrcode/lib/renderer/terminal/terminal-small.js'

/**
 * `text` as a QR code for a terminal (`devtool-server pair --phone`): two module
 * rows per line in half blocks, dark on a light background whatever the
 * terminal's colours, from the `qrcode` package already in the app.
 */
export function renderTerminalQr(text: string): string {
  return TerminalSmall.render(QRCore.create(text, { errorCorrectionLevel: 'L' }))
}
