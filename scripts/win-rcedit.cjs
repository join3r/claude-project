// electron-builder afterPack hook (package.json build.afterPack).
//
// Stamps DevTool's icon and version resources on DevTool.exe with the `rcedit`
// npm package. electron-builder can do this itself (win.signAndEditExecutable),
// but on Windows it fetches rcedit from the winCodeSign archive, and 7-Zip cannot
// unpack that archive's macOS symlinks without Developer Mode or admin. So
// signAndEditExecutable stays false and this hook does the resource edit instead.
// The exe stays unsigned either way.
const path = require('node:path')
const sign = require('./sign-win.cjs')

async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return
  const { packager, appOutDir } = context
  const { appInfo } = packager
  const exe = path.join(appOutDir, `${appInfo.productFilename}.exe`)
  // The .ico electron-builder already converted from build/icon.png.
  const icon = await packager.getIconPath()
  const { rcedit } = await import('rcedit')
  console.log(`  • stamping resources  file=${exe}`)
  await rcedit(exe, {
    icon: icon ?? undefined,
    'file-version': appInfo.shortVersion || appInfo.buildVersion,
    'product-version': appInfo.shortVersionWindows || appInfo.getVersionInWeirdWindowsForm(),
    'version-string': {
      ProductName: appInfo.productName,
      FileDescription: appInfo.productName,
      LegalCopyright: appInfo.copyright,
      // package.json has no author, so overwrite Electron's "GitHub, Inc." and
      // "electron.exe" rather than leave them in file properties.
      CompanyName: appInfo.companyName || appInfo.productName,
      InternalName: appInfo.productFilename,
      OriginalFilename: path.basename(exe)
    }
  })
  // With signAndEditExecutable off, electron-builder no longer signs the app exe
  // (only the NSIS installer/uninstaller), so sign it here after stamping.
  // No-op unless DEVTOOL_SIGN_CMD is set.
  await sign({ path: exe })
}

module.exports = afterPack
module.exports.default = afterPack
