import path from 'path'
import { readLocalBundle, type LocalBundle } from '../host/link/bundle-archive'

/**
 * Where the desktop's server bundle is: `<resources>/server` in a packaged app
 * (electron-builder `extraResources`), `out/server` in a dev run (`npm run dev`
 * builds it first), or `DEVTOOL_SERVER_BUNDLE`.
 */
export function desktopBundleDir(options: { packaged: boolean; resourcesPath: string; appPath: string; env?: NodeJS.ProcessEnv }): string {
  const override = (options.env ?? process.env).DEVTOOL_SERVER_BUNDLE?.trim()
  if (override) return path.resolve(override)
  return options.packaged ? path.join(options.resourcesPath, 'server') : path.join(options.appPath, 'out', 'server')
}

/**
 * The bundle, read again on every call: a dev run's `npm run build:server` replaces
 * it while the app runs, and the next connect (or "Update") should send the new one.
 */
export function desktopBundle(dir: string): () => LocalBundle | null {
  return () => readLocalBundle(dir)
}
