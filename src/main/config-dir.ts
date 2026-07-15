import { app } from 'electron'
import os from 'os'
import path from 'path'

// Dev and production builds must not share a config dir: saves write full
// snapshots of projects.json (last writer wins), so two instances on the
// same dir silently lose each other's changes.
export const CONFIG_DIR =
  process.env.DEVTOOL_CONFIG_DIR ||
  path.join(os.homedir(), app.isPackaged ? '.devtool' : '.devtool-dev')
