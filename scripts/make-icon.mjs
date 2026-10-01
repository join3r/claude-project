#!/usr/bin/env node
// Builds the desktop app icon (build/icon.png) from the iOS app icon join3r
// designed. The iOS artwork is full-bleed and opaque — iOS masks it itself —
// so for desktop it is scaled to the macOS Big Sur grid (824px body on a
// 1024px canvas), given rounded corners, and padded with transparency.
// electron-builder derives .icns / .ico from this one PNG.
//
// One-shot: run by hand after the iOS artwork changes, commit the output.
//   node scripts/make-icon.mjs
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { PNG } from 'pngjs'

const SOURCE = resolve('ios/DevTool/Assets.xcassets/AppIcon.appiconset/AppIcon-1024.png')
const OUTPUT = resolve('build/icon.png')
const CANVAS = 1024
const BODY = 824
const RADIUS = 185

const src = PNG.sync.read(readFileSync(SOURCE))
const out = new PNG({ width: CANVAS, height: CANVAS })
const offset = (CANVAS - BODY) / 2
const scale = src.width / BODY

/** Area-average of the source pixels that map onto body pixel (x, y). */
function sample(x, y) {
  const x0 = x * scale
  const y0 = y * scale
  const x1 = x0 + scale
  const y1 = y0 + scale
  const acc = [0, 0, 0, 0]
  let weight = 0
  for (let sy = Math.floor(y0); sy < Math.ceil(y1); sy++) {
    const wy = Math.min(y1, sy + 1) - Math.max(y0, sy)
    for (let sx = Math.floor(x0); sx < Math.ceil(x1); sx++) {
      const wx = Math.min(x1, sx + 1) - Math.max(x0, sx)
      const w = wx * wy
      const i = (Math.min(sy, src.height - 1) * src.width + Math.min(sx, src.width - 1)) * 4
      for (let c = 0; c < 4; c++) acc[c] += src.data[i + c] * w
      weight += w
    }
  }
  return acc.map((v) => v / weight)
}

/** Coverage (0..1) of pixel (x, y) by the rounded-rect body, anti-aliased over one pixel. */
function coverage(x, y) {
  const cx = x + 0.5
  const cy = y + 0.5
  const half = BODY / 2
  const qx = Math.abs(cx - half) - (half - RADIUS)
  const qy = Math.abs(cy - half) - (half - RADIUS)
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0))
  const inside = Math.min(Math.max(qx, qy), 0)
  const dist = outside + inside - RADIUS
  return Math.min(Math.max(0.5 - dist, 0), 1)
}

for (let y = 0; y < BODY; y++) {
  for (let x = 0; x < BODY; x++) {
    const a = coverage(x, y)
    if (a === 0) continue
    const [r, g, b, srcA] = sample(x, y)
    const i = ((y + offset) * CANVAS + (x + offset)) * 4
    out.data[i] = Math.round(r)
    out.data[i + 1] = Math.round(g)
    out.data[i + 2] = Math.round(b)
    out.data[i + 3] = Math.round(a * srcA)
  }
}

writeFileSync(OUTPUT, PNG.sync.write(out))
console.log(`Wrote ${OUTPUT}`)
