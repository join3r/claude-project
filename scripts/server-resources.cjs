// electron-builder hooks for the server bundle (package.json build.afterPack / afterSign).
//
// extraResources copies out/server to <resources>/server, but electron-builder
// leaves out every node_modules dir there, filter or not, so the bundle lost
// node-pty and no longer matched the sha256 in its manifest: servers refused it
// ("the bundle's content hash is ..., expected ..."). afterPack copies it in.
// mac.signIgnore keeps codesign off <resources>/server, since signing node-pty's
// darwin prebuilds would change them again. afterSign checks the result.
const fs = require('node:fs')
const path = require('node:path')
const winRcedit = require('./win-rcedit.cjs')

const root = path.resolve(__dirname, '..')

function resourcesDir(context) {
  const { appOutDir, electronPlatformName, packager } = context
  return electronPlatformName === 'darwin' || electronPlatformName === 'mas'
    ? path.join(appOutDir, `${packager.appInfo.productFilename}.app`, 'Contents', 'Resources')
    : path.join(appOutDir, 'resources')
}

async function afterPack(context) {
  await winRcedit(context)
  const source = path.join(root, 'out/server/node_modules')
  const dest = path.join(resourcesDir(context), 'server', 'node_modules')
  console.log(`  • copying server node_modules  destination=${dest}`)
  fs.cpSync(source, dest, { recursive: true, verbatimSymlinks: true })
}

async function afterSign(context) {
  const { MANIFEST_FILE, bundleSha256 } = await import('./server-bundle.mjs')
  const dir = path.join(resourcesDir(context), 'server')
  const expected = JSON.parse(fs.readFileSync(path.join(dir, MANIFEST_FILE), 'utf8')).sha256
  const actual = bundleSha256(dir)
  if (actual !== expected) {
    throw new Error(`the packaged server bundle's content hash is ${actual}, its manifest says ${expected}`)
  }
  console.log(`  • server bundle checked  sha256=${actual.slice(0, 12)}`)
}

module.exports = { afterPack, afterSign }
