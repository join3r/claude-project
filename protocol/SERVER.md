# DevTool server link, v1 (normative)

This is the wire spec for the link between a DevTool desktop and a DevTool server. A server is a headless DevTool host (`src/server/`). Both ends come from this repo, so the spec is TypeScript only: there is no JSON Schema, no Swift and no test vectors. The code is the reference, and this file says what it must keep doing. Phones never see any of it.

It builds on the mobile protocol in [SPEC.md](SPEC.md). The relay rules are §3 there (roles in §3.8, binary frames in §3.9, flow control in §3.10). The envelope and Noise come from §4.1 and §4.2, and fragmentation from §6.1.

## 1. Overview

- The desktop and the server talk through the relay only, over the same socket and identity each of them uses for phones.
- The relay sees opaque envelopes. Everything above it is end-to-end encrypted with Noise IK, with the desktop as the initiator.
- Inside the session, binary app messages carry RPC calls into the server's host channels (the same channels and argument schemas a local window uses), events back to the desktop's windows, and multiplexed byte streams with credit-based flow control.

## 2. Channel

### 2.1 Envelope and Noise

- `frame` bytes are the §4.1 envelope: `0x01` message 1 (desktop to server), `0x02` message 2 (server to desktop), `0x03` transport, `0x04` reset.
- `Noise_IK_25519_AESGCM_SHA256` as in SPEC §4.2, with the prologue `utf8("devtool-server-v1")`. A phone's prologue is `devtool-mobile-v1`, so a handshake meant for one can't be read by the other.
- The desktop knows the server's static X25519 key from its pairing record and starts every handshake. The server learns the desktop's static key from message 1.
- A new handshake happens on every (re)connect of either side. Message 1 always replaces the server's existing session for that desktop.
- A transport frame that doesn't decrypt, or one that arrives without a session, is answered with `0x04` and dropped. On `0x04` the desktop drops its session and handshakes again. On `0x04` the server drops its session for that desktop.
- A message 1 the server can't read (bad decryption, truncated, not a desktop hello) is dropped without a reply, as in SPEC §4.3.

### 2.2 Handshake payloads (UTF-8 JSON)

Message 1 (desktop):
```json
{ "v": 1, "min": 1, "app": "devtool-desktop",
  "build": { "version": "0.6.0", "commit": "", "builtAt": "", "bundleSha": "" },
  "features": [], "name": "join3r-mbp" }
```
Message 2 (server) is the same shape with `app: "devtool-server"`, its own `build` from `manifest.json` and its display name, plus `result`:
- `ok`: the session is up.
- `incompatible`: no common version (§2.3). No session.
- `unknown-device`: the server has no pairing whose Noise key matches. No session.

Rules:
- The server accepts a desktop only when its pairings (`<data>/desktops.json`) have a record for the relay-authenticated sender ID and that record's `x25519Pub` equals the static key message 1 revealed. The sender ID is the hash of the Ed25519 key the relay checked, so this binds both keys.
- Unknown fields are ignored. `features` is empty in version 1.

### 2.3 Versions

- `HOST_LINK_PROTOCOL_VERSION` is 1 and the minimum is 1 (`src/main/host/link/version.ts`). `npm run build:server` writes the version into `manifest.json` as `protocol`.
- Negotiation is SPEC §4.3's: `chosen = min(v)`, and the answer is `incompatible` when `chosen < max(min)`. The server reads only `{v, min}` first, so a desktop whose hello has a future shape still gets a clean `incompatible`.
- The side whose `v` is below the other's `min` is the one to update. The desktop shows the server as `incompatible` with `update: "desktop"` or `update: "server"`.

## 3. Relay

- A host has one relay socket and one identity (`<configDir>/mobile/identity.json`, plaintext 0600 on a server). The phones and the link share it. `RelayMux` (`src/main/host/link/relay-mux.ts`) routes by peer ID: `frame`, `peer` and `error { to }` about a peer the link owns go to the link, everything else to the mobile service. Errors without `to` go to both.
- The desktop owns the IDs in `servers.json`. A server owns every peer that is not a phone. There are no phones on a server before step 10, so it answers any unknown desktop with `unknown-device`.
- Both ends say `binary: true` in hello and send binary frames (SPEC §3.9). A desktop whose `ready` lacks `binary: true` is on a relay from before servers. It reports "This relay is too old for servers", keeps its phones on JSON and sends no `pair`, `watch` or binary frames.
- The desktop's socket runs while Mobile is on or any server is paired. It uses the Mobile relay URL setting until step 5 makes it a shared Relay setting. The server's relay URL is in `<data>/server.json`.
- Presence: the desktop sends one `watch` with all its server IDs after every `ready` (SPEC §3.3). It handshakes with each server the relay reports online. A server gets its desktops' presence without asking, and drops a desktop's session on `peer offline`, `peer revoked` or `error offline`.
- Retries: a handshake has 10 s to get message 2. A failed attempt retries with backoff from 1 s to 30 s while the relay still reports the server online. A session that comes up resets the backoff.
- Liveness (SPEC §3.10): the client gives up on the relay after 60 s of total silence, or after 180 s while its own sends are still queued (`bufferedAmount > 0`), since a relay that stopped reading a socket also delays its pongs.

## 4. App messages

Every transport plaintext is one whole app message, or a §6.1 fragment of one. The first byte of a whole message is its type, which is never `0x01` (a fragment) or `0x7B` (phone JSON).

```
type:u8  headerLength:u32be  header (UTF-8 JSON, headerLength bytes)  payload (the rest)
```

| type | name | header | payload |
|---|---|---|---|
| `0x10` | call | `{id, client, ch, args, focused?, tail?}` | final string argument when `tail` |
| `0x11` | result | `{id, ok: true, value?}` or `{id, ok: false, error: {code, message}}` | none |
| `0x12` | event | `{client, ch, args, tail?}` | final string argument when `tail` |
| `0x13` | detach | `{client}` | none |
| `0x20` | open | `{sid, kind, params}` | none |
| `0x21` | data | `{sid}` | the stream's bytes |
| `0x22` | credit | `{sid, n}` | none |
| `0x23` | close | `{sid, reason: "end" \| "error" \| "refused", message?}` | none |

- A message is at most 4 MiB (the §6.1 reassembly limit). A sender never builds a bigger one. A result that would be too big goes out as `{ok: false, error: {code: "too-large"}}` instead, and a call whose arguments are too big fails on the caller's side with the same code. Callers that need more data use a stream.
- `tail`: when the last argument of a call or event is a string, it travels as the raw UTF-8 payload instead of an escaped JSON string. Terminal output is mostly escape sequences, and JSON would make each `ESC` six bytes.
- Values are JSON, plus what Electron's structured clone keeps and JSON loses. An object whose key is NUL (`"\u0000"`) is a tagged value: `{"\u0000":"u"}` is `undefined` (an array element or the whole value), `{"\u0000":"b","d":"<b64u>"}` is a `Uint8Array`, `{"\u0000":"d","d":<ms>}` is a `Date`, and `{"\u0000":"n","d":"NaN"}` (or `"Infinity"`, `"-Infinity"`) is a number. An object property that is `undefined` is left out, as JSON does. A `bigint` can't be sent.
- A malformed message is logged and dropped. The session survives it.
- Messages within one session arrive in the order they were sent.

## 5. Calls, events and clients

- `call` runs a host channel on the server as a client of the desktop. `client` is the desktop's own window ID (`win:3`). The server registers it as `link:<desktopId>:<client>` on its first call, with the window's focus from the latest call's `focused`. `pty-resize` from an unfocused window only applies while it controls the PTY, as on a desktop.
- The server validates every call with the same registrar and argument schemas a local window goes through. A refusal, a bad argument or a handler error answers `remote-error` with the handler's message.
- `scrollback-save-sync` is for local windows only and answers `unsupported`, as does a channel the server doesn't have.
- `event` carries a host push. `client` is the window it is for, or `*` for a broadcast. A broadcast goes to a desktop once, whatever number of its windows the server knows, including none yet.
- `detach` says the desktop's window closed. The server unregisters that client, so PTYs and chats let go of it. When a session ends, the server unregisters every client of that desktop.
- Calls go from the desktop to the server only. A call toward the desktop answers `unsupported`.
- Error codes (`LinkErrorCode`): `server-offline` (no session, or it ended while the call was pending), `too-large`, `remote-error`, `unsupported`, `refused`, `aborted`, `protocol-error`. A desktop fails a call at once with `server-offline` when the server isn't connected. It never queues calls.

## 6. Streams

### 6.1 Messages

- `open {sid, kind, params}` starts a stream. The desktop uses odd IDs and the server even ones. The opener may write at once, within the initial window.
- `data {sid}` carries bytes. One `data` message has at most 59,963 bytes, so it fits one unfragmented plaintext.
- `close {sid, reason: "end"}` half-closes: its sender sends no more, and the other side's reader gets EOF after what it has. A stream is done when both sides have sent `end`.
- `close {sid, reason: "error" | "refused", message}` aborts both directions. The receiver of an `open` for a kind it doesn't serve, or with a bad `sid`, answers `refused`.
- Messages for a stream ID the receiver doesn't know are ignored.

### 6.2 Flow control

- Each direction of a stream has a window of 256 KiB. A sender may have at most that many `data` bytes beyond the credit it has received. Credit only grows.
- The receiver grants credit with `credit {sid, n}` as its reader consumes: it keeps bytes in flight plus bytes buffered unread at or below 256 KiB, and grants once at least 64 KiB of the window is free.
- A `data` past the credit granted is a protocol error. The receiver aborts the stream.
- On top of credit, a sender stops writing while its relay socket has more than 512 KiB queued (`bufferedAmount`) and resumes below 128 KiB. That keeps a link far below the relay's 4 MiB high-water mark (SPEC §3.10).
- When a session ends, every open stream aborts with `server-offline`.

### 6.3 Kinds

A side serves the kinds in its registry (`StreamKinds`). Later steps add `bundle`, `file` and `tcp`. Version 1 has three diagnostic kinds that every server serves. They only move bytes the desktop sends or asks for, so they double as a speed test.

- `echo`: writes back everything it reads, then ends.
- `sink {delayMs?}`: reads to the end, pausing `delayMs` (at most 1000) after each chunk to play a slow reader. Then it writes `{"bytes":N,"sha256":"<hex>"}` and ends.
- `source {bytes, seed?}`: writes `bytes` bytes (at most 4 GiB) of `sourceByte(i, seed) = (i*31 + seed + (i >>> 8)) & 0xff`, then ends.

## 7. Dev pairing

Real pairing (server invites and offers) comes with step 5. Until then a desktop and a server pair by exchanging public keys by hand, while the relay pair goes through the normal code flow (SPEC §3.8):

1. The desktop prints its keys as `<x25519Pub>.<ed25519Pub>` (`ServerHub.devKeys()`; a dev run logs them as `servers devKeys=` when `DEVTOOL_DEV_SERVER_PAIR=1`).
2. The server runs `node main.js --dev-pair <keys> [--name <desktop name>] [--relay <url>]`. It stores the desktop, starts as usual, sends a relay `offer` and prints a code: `devtool-dev-pair:` and base64url JSON `{id, x25519Pub, ed25519Pub, name, token, exp}`.
3. The desktop takes the code (`ServerHub.devPair(code)`, or `DEVTOOL_DEV_SERVER_PAIR=<code>` in a dev run). It stores the server, sends `pair { to, token }` and handshakes straight away, since frames already route for a pending pair. The server sends `authorize` when the desktop comes online, and the desktop sends `watch` again after its first handshake.

The relay offer lasts 15 minutes and is sent again after every reconnect of the server until then.

## 8. Terminal output

- The server batches `pty-data` per window and tab for up to 16 ms, at most 16384 characters per message (48 KiB of UTF-8, one Noise message). It never splits a surrogate pair.
- Any other message to the same desktop flushes every batch first, the result of a call included. So `pty-exit` arrives after the output before it, and a reattach's result comes before the output that followed the snapshot.
- Backpressure: when a `pty-data` event goes to a desktop whose relay socket has more than 512 KiB queued, the server holds that tab's output back. node-pty stops reading the PTY, so the program blocks on its writes. Once the socket is under 128 KiB, every tab that desktop held is released. A tab stays paused while any desktop holds it, and a desktop's holds go away with its session. No output is ever dropped while the session lasts. After a reconnect, `pty-spawn` on the running tab returns its scrollback.

## 9. Implementation map

| path | what |
|---|---|
| `src/main/host/link/version.ts` | protocol version and minimum |
| `src/main/host/link/handshake.ts` | prologue, hello and reply payloads |
| `src/main/host/link/secure.ts` | `LinkInitiator`, `answerHandshake`, `SealedChannel` (FramedTransport that lets link messages through) |
| `src/main/host/link/wire.ts` | message types, value encoding, `encodeLinkMessage`/`decodeLinkMessage` |
| `src/main/host/link/session.ts` | `LinkSession`: calls, events, batching, streams |
| `src/main/host/link/stream.ts` | `LinkStream` (a Node Duplex with credit), `StreamKinds` |
| `src/main/host/link/diagnostic-streams.ts` | `echo`, `sink`, `source` |
| `src/main/host/link/relay-mux.ts`, `relay-transport.ts` | the shared relay socket, and a session's transport over it |
| `src/main/host/link/peer-store.ts` | `servers.json` and `desktops.json` |
| `src/main/host/link/dev-pair.ts` | §7 codes |
| `src/main/servers/` | the desktop: `ServerHub`, one `ServerConnection` per server |
| `src/server/server-link.ts` | the server: responder, one session per desktop, client registration, holds |
| `src/server/server-config.ts` | `<data>/server.json` |

Tests: `tests/host-link-wire.test.ts` and `tests/host-link-session.test.ts` (loopback), `tests/relay-mux.test.ts`, and `tests/server-link-e2e.test.ts` (desktop, relay and server in one process).
