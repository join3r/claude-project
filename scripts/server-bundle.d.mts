import type { Plugin } from 'esbuild'

export const MANIFEST_FILE: string
export const SERVER_NODE_VERSION: string
export function noNativeGuardPlugin(root?: string): Plugin
export function electronGuardPlugin(root?: string): Plugin
export function bundleFiles(dir: string): string[]
export function bundleSha256(dir: string): string
