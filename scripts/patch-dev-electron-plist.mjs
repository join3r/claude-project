#!/usr/bin/env node
// Patches the dev-mode Electron binary's Info.plist so `npm run dev` looks like
// DevTool, not Electron: the bold menu-bar app name and Dock tooltip come from
// CFBundleName / CFBundleDisplayName of the running bundle, which in dev is
// node_modules/electron/dist/Electron.app — app.setName() cannot rename it.
// Also gives the macOS permission prompts DevTool-specific copy. Packaged builds
// get the name from `productName` and the prompt text from `mac.extendInfo` in
// package.json.
//
// Runs from postinstall and as predev (an `npm install` re-extracts Electron.app).
// Idempotent; a no-op off macOS or when the bundle is missing.
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { platform } from 'node:os'
import { resolve } from 'node:path'

if (platform() !== 'darwin') process.exit(0)

const plist = resolve(
  'node_modules/electron/dist/Electron.app/Contents/Info.plist'
)
if (!existsSync(plist)) process.exit(0)

const entries = {
  CFBundleName: 'DevTool',
  CFBundleDisplayName: 'DevTool',
  NSMicrophoneUsageDescription:
    "DevTool forwards microphone access to terminal apps you run inside it, such as Claude Code's voice mode.",
  NSCameraUsageDescription:
    'DevTool forwards camera access to terminal apps you run inside it that request video input.'
}

for (const [key, value] of Object.entries(entries)) {
  execFileSync('plutil', ['-replace', key, '-string', value, plist])
}
