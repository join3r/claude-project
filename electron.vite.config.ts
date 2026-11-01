import { copyFileSync, mkdirSync } from 'fs'
import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import type { Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Copy static runtime assets (loaded by external processes, not bundled) into
// out/main so the main process can resolve them via join(__dirname, ...) in both
// `electron-vite dev` and packaged builds: Pi status extension + notebook kernel helper.
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
      copyFileSync(
        resolve('resources/notebook-kernel.py'),
        resolve(outDir, 'notebook-kernel.py')
      )
    }
  }
}

// index.html carries the production CSP. The dev server additionally needs the
// inline React refresh preamble and the HMR websocket, so widen it in serve mode only.
function devCsp(): Plugin {
  return {
    name: 'devtool-dev-csp',
    apply: 'serve',
    transformIndexHtml(html) {
      return html.replace(/(<meta http-equiv="Content-Security-Policy" content=")([^"]*)"/, (_m, head: string, policy: string) => {
        const widened = policy
          .replace("script-src 'self'", "script-src 'self' 'unsafe-inline'")
          .replace("connect-src 'self'", "connect-src 'self' ws://localhost:* http://localhost:*")
        return `${head}${widened}"`
      })
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
    plugins: [react(), tailwindcss(), devCsp()],
    root: resolve('src/renderer'),
    // Fixed dev port so the window never picks up another project's vite server on 5173.
    // DEVTOOL_VITE_PORT gives a second dev run (another task's worktree) its own.
    server: {
      port: Number(process.env.DEVTOOL_VITE_PORT) || 5197,
      strictPort: true
    },
    build: {
      outDir: resolve('out/renderer'),
      rollupOptions: {
        input: resolve('src/renderer/index.html')
      }
    }
  }
})
