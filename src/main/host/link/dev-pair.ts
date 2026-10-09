import { b64uDecode, b64uDecodeLength, b64uEncode, deviceId, utf8Decode, utf8Encode } from '../../../../protocol/ts/index.ts'

/**
 * Dev-only pairing of a desktop and a server, until step 5 brings real pairing
 * (protocol/SERVER.md §7). Both sides exchange their public keys by hand:
 *
 *   1. The desktop prints its keys (`<x25519Pub>.<ed25519Pub>`, {@link encodeDevKeys}).
 *   2. The server is started with `--dev-pair <those keys>`: it stores the desktop,
 *      makes a relay `offer` and prints a {@link encodeDevPairCode} code.
 *   3. The desktop takes the code: it stores the server and sends relay `pair`;
 *      the server sees it come online and sends `authorize`.
 */

export const DEV_PAIR_PREFIX = 'devtool-dev-pair:'

/** Both public keys of a device, base64url. */
export interface DevKeys {
  x25519Pub: string
  ed25519Pub: string
}

/** What the server's code carries. */
export interface DevPairOffer extends DevKeys {
  /** The server's device ID. */
  id: string
  name: string
  /** b64u of the 32-byte relay token its `offer` was made for. */
  token: string
  /** Unix seconds; the offer lapses then. */
  exp: number
}

export function encodeDevKeys(keys: DevKeys): string {
  return `${keys.x25519Pub}.${keys.ed25519Pub}`
}

export function decodeDevKeys(text: string): DevKeys {
  const [x25519Pub, ed25519Pub, extra] = text.trim().split('.')
  if (extra !== undefined || !x25519Pub || !ed25519Pub) throw new Error('Expected <x25519Pub>.<ed25519Pub>')
  b64uDecodeLength(x25519Pub, 32, 'x25519Pub')
  b64uDecodeLength(ed25519Pub, 32, 'ed25519Pub')
  return { x25519Pub, ed25519Pub }
}

export function encodeDevPairCode(offer: DevPairOffer): string {
  return DEV_PAIR_PREFIX + b64uEncode(utf8Encode(JSON.stringify(offer)))
}

export function decodeDevPairCode(code: string): DevPairOffer {
  const text = code.trim()
  if (!text.startsWith(DEV_PAIR_PREFIX)) throw new Error(`A dev pairing code starts with ${DEV_PAIR_PREFIX}`)
  const o = JSON.parse(utf8Decode(b64uDecode(text.slice(DEV_PAIR_PREFIX.length)))) as Record<string, unknown>
  const keys = decodeDevKeys(`${String(o.x25519Pub)}.${String(o.ed25519Pub)}`)
  const id = deviceId(b64uDecode(keys.ed25519Pub))
  if (o.id !== id) throw new Error('The code\'s id does not match its key')
  if (typeof o.token !== 'string') throw new Error('The code has no token')
  b64uDecodeLength(o.token, 32, 'token')
  if (typeof o.exp !== 'number') throw new Error('The code has no expiry')
  return { ...keys, id, name: typeof o.name === 'string' ? o.name.slice(0, 100) : 'server', token: o.token, exp: o.exp }
}
