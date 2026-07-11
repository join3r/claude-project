import { copyFileSync, mkdirSync } from 'fs'
import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import type { Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Copy static runtime assets (loaded by external processes, not bundled) into
// out/main so the main process can resolve them via join(__dirname, ...) in both
// `electron-vite dev` and packaged builds. Currently: the pi status extension.
function copyMainAssets(): Plugin {
  return {
    name: 'devtool-copy-main-assets',
    writeBundle(options) {
      const outDir = options.dir ?? resolve('out/main')
      mkdirSync(outDir, { recursive: true })
      copyFileSync(
        resolve('resources/pi-status-extension.mjs'),
        resolve(outDir, 'pi-status-extension.mjs')
      )
    }
  }
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin(), copyMainAssets()],
    build: {
      outDir: 'out/main'
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'out/preload'
    }
  },
  renderer: {
    plugins: [react(), tailwindcss()],
    root: resolve('src/renderer'),
    build: {
      outDir: resolve('out/renderer'),
      rollupOptions: {
        input: resolve('src/renderer/index.html')
      }
    }
  }
})
