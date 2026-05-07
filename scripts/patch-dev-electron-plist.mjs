#!/usr/bin/env node
// Patches the dev-mode Electron binary's Info.plist so the macOS permission
// prompts during `npm run dev` show DevTool-specific copy instead of the
// generic Electron defaults. Packaged builds get the same text via
// electron-builder's `mac.extendInfo` config in package.json.
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
  NSMicrophoneUsageDescription:
    "DevTool forwards microphone access to terminal apps you run inside it, such as Claude Code's voice mode.",
  NSCameraUsageDescription:
    'DevTool forwards camera access to terminal apps you run inside it that request video input.'
}

for (const [key, value] of Object.entries(entries)) {
  execFileSync('plutil', ['-replace', key, '-string', value, plist])
}
