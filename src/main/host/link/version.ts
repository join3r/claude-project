/**
 * The desktop↔server link's protocol version (protocol/SERVER.md §2).
 * `scripts/build-server.mjs` reads it from this file into the bundle's
 * manifest.json, so keep the declaration on one line.
 */
export const HOST_LINK_PROTOCOL_VERSION = 1
/** The oldest version this build still speaks. */
export const HOST_LINK_MIN_VERSION = 1
