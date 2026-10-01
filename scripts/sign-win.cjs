// electron-builder custom Windows sign hook (package.json build.win.signtoolOptions.sign).
//
// No certificate exists yet, so by default this does nothing and the build stays
// unsigned — rcedit still stamps DevTool's icon and version resources on the exe.
// Code-signing keys now live on a hardware token or cloud HSM, not in a .pfx, so
// signing is a command rather than CSC_LINK: set DEVTOOL_SIGN_CMD to the signtool
// (or vendor tool) invocation with `{file}` where the path goes, e.g.
//
//   DEVTOOL_SIGN_CMD='signtool sign /fd sha256 /tr http://time.certum.pl /td sha256 /n "Your Name" "{file}"'
//
// scripts/release-win.mjs --signed requires it and checks the result with
// `signtool verify /pa`.
const { execSync } = require('node:child_process')

/** The shell command for one file, or null when signing is not configured. */
function signCommand(file, template = process.env.DEVTOOL_SIGN_CMD) {
  if (!template || !template.trim()) return null
  if (!template.includes('{file}')) {
    throw new Error('DEVTOOL_SIGN_CMD must contain {file} where the path to sign goes')
  }
  return template.split('{file}').join(file.replace(/"/g, ''))
}

async function sign(configuration) {
  const command = signCommand(configuration.path)
  if (!command) {
    console.log(`  • not signing ${configuration.path} (DEVTOOL_SIGN_CMD is unset)`)
    return
  }
  console.log(`  • signing ${configuration.path}`)
  execSync(command, { stdio: 'inherit' })
}

module.exports = sign
module.exports.default = sign
module.exports.signCommand = signCommand
