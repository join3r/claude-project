import { app, powerSaveBlocker, safeStorage } from 'electron'
import fs from 'fs'
import path from 'path'
import { CONFIG_DIR } from './config-dir'
import type { HostEnv } from './host/host-env'
import { nativeImageCodec } from './mobile/image-codec'

const DEBUG_LOG_PATH = path.join(CONFIG_DIR, 'debug.log')

/** Appends to `<config dir>/debug.log`; best effort. */
export function logDebug(message: string): void {
  try {
    if (!fs.existsSync(CONFIG_DIR)) {
      fs.mkdirSync(CONFIG_DIR, { recursive: true })
    }
    fs.appendFileSync(DEBUG_LOG_PATH, `[${new Date().toISOString()}] ${message}\n`)
  } catch {
    // Best-effort logging only.
  }
}

/**
 * Absolute path to a file the build copies next to the main bundle (copyMainAssets
 * in electron.vite.config.ts): the pi status extension and the notebook kernel helper.
 *
 * In a packaged app __dirname lives inside app.asar, but pi and python are external
 * processes that can't read paths inside the asar archive — so the files are unpacked
 * (see package.json `asarUnpack`) and we point at their real on-disk location under
 * app.asar.unpacked. In dev there is no asar, so the replacement is a no-op.
 */
export function bundledResourcePath(name: string): string {
  const p = path.join(__dirname, name)
  const packed = `app.asar${path.sep}`
  return p.includes(packed) ? p.replace(packed, `app.asar.unpacked${path.sep}`) : p
}

/** The {@link HostEnv} of the desktop's own host: Electron's config dir, keychain, power and images. */
export function createDesktopHostEnv(): HostEnv {
  return {
    configDir: CONFIG_DIR,
    appVersion: app.getVersion(),
    resourcePath: bundledResourcePath,
    secrets: {
      isAvailable: () => safeStorage.isEncryptionAvailable(),
      encrypt: (plaintext) => safeStorage.encryptString(plaintext),
      decrypt: (ciphertext) => safeStorage.decryptString(ciphertext)
    },
    powerSave: powerSaveBlocker,
    images: nativeImageCodec,
    log: logDebug
  }
}
