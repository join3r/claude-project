import fs from 'fs'
import path from 'path'
import {
  b64uDecodeLength,
  b64uEncode,
  deviceId,
  ed25519FromPrivate,
  generateEd25519,
  generateX25519,
  x25519FromPrivate
} from '../../../protocol/ts/index.ts'
import type { KeyPair } from '../../../protocol/ts/index.ts'
import { atomicWriteFileSync } from '../atomic-write'

/** This desktop's long-term keys (SPEC.md §1). One per config dir. */
export interface DesktopIdentity {
  id: string
  x25519: KeyPair
  ed25519: KeyPair
}

/** Electron `safeStorage` in production; a fake in tests. */
export interface SecretEncryptor {
  isAvailable(): boolean
  encrypt(plaintext: string): Buffer
  decrypt(ciphertext: Buffer): string
}

interface SecretKeys {
  x25519Priv: string
  ed25519Priv: string
}

type IdentityFile =
  | { enc: 'safeStorage'; data: string }
  | ({ enc: 'none' } & SecretKeys)

function fromSecrets(keys: SecretKeys): DesktopIdentity {
  const x25519 = x25519FromPrivate(b64uDecodeLength(keys.x25519Priv, 32, 'x25519Priv'))
  const ed25519 = ed25519FromPrivate(b64uDecodeLength(keys.ed25519Priv, 32, 'ed25519Priv'))
  return { id: deviceId(ed25519.pub), x25519, ed25519 }
}

function parseSecrets(value: unknown): SecretKeys {
  const o = value as Partial<SecretKeys> | null
  if (!o || typeof o.x25519Priv !== 'string' || typeof o.ed25519Priv !== 'string') {
    throw new Error('identity keys are missing')
  }
  return { x25519Priv: o.x25519Priv, ed25519Priv: o.ed25519Priv }
}

/**
 * `<configDir>/mobile/identity.json`. Loaded lazily, on first use: on macOS the first
 * `safeStorage` call can raise a Keychain prompt, which nobody who never turns
 * Mobile on should see.
 */
export class IdentityStore {
  private readonly file: string
  private identity: DesktopIdentity | null = null

  constructor(
    private readonly dir: string,
    private readonly encryptor: SecretEncryptor,
    private readonly log: (message: string) => void = () => {}
  ) {
    this.file = path.join(dir, 'identity.json')
  }

  /** Loads the identity, creating (and saving) one the first time. */
  get(): DesktopIdentity {
    if (!this.identity) this.identity = this.loadOrCreate()
    return this.identity
  }

  /** Only what is already loaded: never touches disk or the Keychain. */
  peekId(): string | null {
    return this.identity?.id ?? null
  }

  private loadOrCreate(): DesktopIdentity {
    const existing = this.load()
    if (existing) return existing
    const x25519 = generateX25519()
    const ed25519 = generateEd25519()
    const identity: DesktopIdentity = { id: deviceId(ed25519.pub), x25519, ed25519 }
    this.save(identity)
    this.log(`mobileIdentity created id=${identity.id}`)
    return identity
  }

  private load(): DesktopIdentity | null {
    let raw: string
    try {
      raw = fs.readFileSync(this.file, 'utf-8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw err
    }
    try {
      const parsed = JSON.parse(raw) as IdentityFile
      if (parsed.enc === 'safeStorage') {
        const json = this.encryptor.decrypt(Buffer.from(parsed.data, 'base64'))
        return fromSecrets(parseSecrets(JSON.parse(json)))
      }
      if (parsed.enc === 'none') return fromSecrets(parseSecrets(parsed))
      throw new Error('unknown identity encoding')
    } catch (err) {
      // An identity we cannot read (Keychain entry gone, file damaged) cannot be
      // recovered. Keep the file for inspection and start over: paired phones will
      // have to pair again, which is better than Mobile never working.
      const aside = `${this.file}.unreadable-${new Date().toISOString().replace(/[:.]/g, '-')}`
      try { fs.renameSync(this.file, aside) } catch { /* ignore */ }
      this.log(`mobileIdentity unreadable (${err instanceof Error ? err.message : String(err)}); moved to ${aside}`)
      return null
    }
  }

  private save(identity: DesktopIdentity): void {
    const secrets: SecretKeys = {
      x25519Priv: b64uEncode(identity.x25519.priv),
      ed25519Priv: b64uEncode(identity.ed25519.priv)
    }
    let file: IdentityFile
    if (this.encryptor.isAvailable()) {
      file = { enc: 'safeStorage', data: this.encryptor.encrypt(JSON.stringify(secrets)).toString('base64') }
    } else {
      this.log('mobileIdentity safeStorage unavailable; storing keys unencrypted (mode 0600)')
      file = { enc: 'none', ...secrets }
    }
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 })
    atomicWriteFileSync(this.file, JSON.stringify(file, null, 2), 0o600)
  }
}
