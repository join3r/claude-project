import type { ImageCodec } from '../mobile/chat-image'
import type { SecretEncryptor } from '../mobile/identity'
import type { PowerSaveApi } from '../sleep-blocker'

/**
 * What a host needs from the process it runs in. The desktop backs it with
 * Electron (`desktop-host-env.ts`); nothing under `host/` imports Electron.
 */
export interface HostEnv {
  /** Persistent state: projects.json, config, scrollback, archive, the mobile identity. */
  configDir: string
  /** This build's version, as the mobile handshake reports it (`devtool/<version>`). */
  appVersion: string
  /** A file shipped next to the main bundle for external processes (the pi extension, the notebook helper). */
  resourcePath(name: string): string
  /** Encrypts the mobile identity at rest. */
  secrets: SecretEncryptor
  /** Holds off system sleep while an agent works. */
  powerSave: PowerSaveApi
  /** Decodes and re-encodes images phones attach to chats. */
  images: ImageCodec
  /** The debug log (`<configDir>/debug.log`). */
  log(message: string): void
}
