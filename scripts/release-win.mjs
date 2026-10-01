#!/usr/bin/env node
// Builds the Windows release on the local Windows box and uploads it as a DRAFT
// GitHub Release on join3r/claude-project. You publish the draft by hand.
//
//   npm run release:win                 unsigned: Setup.exe + portable zip
//   npm run release:win -- --signed     signed: also latest.yml (the auto-update feed)
//   npm run release:win -- --no-upload  build only, print what would be uploaded
//
// Unsigned releases never carry latest.yml, so no installed copy self-updates to
// an unsigned build: installs only hear "x.y.z is available" through the
// releases/latest redirect (src/main/updates.ts, `manual` mode). A signed build
// is stamped `devtoolSigned: true` in its package.json, which is what flips an
// NSIS install into electron-updater (`auto` mode).
//
// --signed needs DEVTOOL_SIGN_CMD (see scripts/sign-win.cjs) and
// DEVTOOL_PUBLISHER_NAME (the certificate subject CN; electron-updater checks
// downloaded installers against it). Upload needs `gh` logged in (or GH_TOKEN).
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const REPO = 'join3r/claude-project'
const args = new Set(process.argv.slice(2))
const signed = args.has('--signed')
const upload = !args.has('--no-upload')

function fail(message) {
  console.error(`release-win: ${message}`)
  process.exit(1)
}

function run(command, commandArgs) {
  console.log(`> ${command} ${commandArgs.join(' ')}`)
  // shell: npm / npx / gh are .cmd shims on Windows.
  const result = spawnSync(command, commandArgs, { stdio: 'inherit', shell: process.platform === 'win32' })
  if (result.status !== 0) fail(`${command} exited with ${result.status ?? result.signal}`)
}

if (process.platform !== 'win32') fail('run this on the Windows build machine')

const { version } = JSON.parse(readFileSync(resolve('package.json'), 'utf8'))
const tag = `v${version}`

const builderArgs = ['electron-builder', '--win', 'nsis', 'zip', '--publish', 'never']
if (signed) {
  if (!process.env.DEVTOOL_SIGN_CMD) fail('--signed needs DEVTOOL_SIGN_CMD (see scripts/sign-win.cjs)')
  const publisher = process.env.DEVTOOL_PUBLISHER_NAME
  if (!publisher) fail('--signed needs DEVTOOL_PUBLISHER_NAME (the certificate subject CN)')
  builderArgs.push(
    '-c.extraMetadata.devtoolSigned=true',
    `-c.win.signtoolOptions.publisherName=${JSON.stringify(publisher)}`
  )
} else {
  console.log('release-win: building UNSIGNED (no --signed); the release gets no latest.yml')
}

run('npm', ['run', 'build'])
run('npx', builderArgs)

const dist = resolve('dist')
const setup = join(dist, `DevTool-Setup-${version}.exe`)
const assets = [setup, `${setup}.blockmap`, join(dist, `DevTool-${version}-win.zip`)]
if (signed) {
  run('signtool', ['verify', '/pa', setup])
  run('signtool', ['verify', '/pa', join(dist, 'win-unpacked', 'DevTool.exe')])
  assets.push(join(dist, 'latest.yml'))
}
for (const file of assets) {
  if (!existsSync(file)) fail(`missing build output ${file}`)
}

console.log(`\nRelease ${tag} (${signed ? 'signed' : 'unsigned'}):`)
for (const file of assets) console.log(`  ${file}`)

if (!upload) process.exit(0)
run('gh', [
  'release', 'create', tag, ...assets,
  '--repo', REPO, '--draft', '--title', tag, '--generate-notes'
])
console.log(`\nDraft ${tag} created on ${REPO}. Review and publish it on GitHub.`)
