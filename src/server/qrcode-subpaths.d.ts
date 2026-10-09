// The two parts of `qrcode` the CLI uses, imported by path so the bundle leaves
// out the PNG and SVG renderers its main entry loads (src/server/qr-terminal.ts).
declare module 'qrcode/lib/core/qrcode.js' {
  const core: { create(text: string, options?: { errorCorrectionLevel?: 'L' | 'M' | 'Q' | 'H' }): unknown }
  export default core
}

declare module 'qrcode/lib/renderer/terminal/terminal-small.js' {
  const renderer: { render(qr: unknown, options?: { inverse?: boolean }): string }
  export default renderer
}
