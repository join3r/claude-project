# DevTool server link, v1 (normative)

This is the wire spec for the link between a DevTool desktop and a DevTool server. A server is a headless DevTool host (`src/server/`). Both ends come from this repo, so the spec is TypeScript only: there is no JSON Schema, no Swift and no test vectors. The code is the reference, and this file says what it must keep doing. Phones never see any of it.

It builds on the mobile protocol in [SPEC.md](SPEC.md). The relay rules are §3 there (roles in §3.8, binary frames in §3.9, flow control in §3.10). The envelope and Noise come from §4.1 and §4.2, and fragmentation from §6.1.

## 1. Overview

- The desktop and the server talk through the relay only, over the same socket and identity each of them uses for phones.
- The relay sees opaque envelopes. Everything above it is end-to-end encrypted with Noise IK, with the desktop as the initiator.
- Inside the session, binary app messages carry RPC calls into the server's host channels (the same channels and argument schemas a local window uses), events back to the desktop's windows, and multiplexed byte streams with credit-based flow control.

## 2. Channel

### 2.1 Envelope and Noise

- `frame` bytes are the §4.1 envelope: `0x01` message 1 (desktop to server), `0x02` message 2 (server to desktop), `0x03` transport, `0x04` reset. Pairing adds `0x05` and `0x06` (§7.2).
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
The desktop's `build` is the server bundle it carries (§10): its commit, build time and content hash. Message 2 (server) is the same shape with `app: "devtool-server"`, its own `build` from `manifest.json` (all empty in a server that has no bundle yet), its display name, `host: {os, arch, hostname, node}` and `result`:
- `ok`: the session is up.
- `incompatible`: no common version (§2.3). No session.
- `unknown-device`: the server has no pairing whose Noise key matches. No session.

Rules:
- The server accepts a desktop only when its pairings (`<data>/desktops.json`) have a record for the relay-authenticated sender ID and that record's `x25519Pub` equals the static key message 1 revealed. The sender ID is the hash of the Ed25519 key the relay checked, so this binds both keys.
- Unknown fields are ignored. A desktop sends no `features` in version 1. A server being installed says `features: ["bootstrap"]` (§11).

### 2.3 Versions

- `HOST_LINK_PROTOCOL_VERSION` is 1 and the minimum is 1 (`src/main/host/link/version.ts`). `npm run build:server` writes the version into `manifest.json` as `protocol`.
- Negotiation is SPEC §4.3's: `chosen = min(v)`, and the answer is `incompatible` when `chosen < max(min)`. The server reads only `{v, min}` first, so a desktop whose hello has a future shape still gets a clean `incompatible`.
- The side whose `v` is below the other's `min` is the one to update. The desktop shows the server as `incompatible` with `update: "desktop"` or `update: "server"`.

## 3. Relay

- A host has one relay socket and one identity (`<configDir>/mobile/identity.json`, plaintext 0600 on a server). The phones and the link share it. `RelayMux` (`src/main/host/link/relay-mux.ts`) routes by peer ID: `frame`, `peer` and `error { to }` about a peer the link owns go to the link, everything else to the mobile service. Errors without `to` go to both.
- The desktop owns the IDs in `servers.json` and the servers it is proving a code to. A `0x05` pairing hello from a peer nobody owns goes to the desktop's hub (§7.3). A server owns every peer that is not a phone. There are no phones on a server before step 10, so it answers any unknown desktop with `unknown-device`.
- Both ends say `binary: true` in hello and send binary frames (SPEC §3.9). A desktop whose `ready` lacks `binary: true` is on a relay from before servers. It reports "This relay is too old for servers", keeps its phones on JSON and sends no `pair`, `watch` or binary frames.
- The desktop's socket runs while Mobile is on, any server is paired, an invite is live or a code is being proven. It uses the Mobile relay URL setting until step 5 makes it a shared Relay setting. The server's relay URL is in `<data>/server.json`.
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

### 5.1 Link-level calls

A few channels are the server's own rather than a host channel. A desktop calls them as the client `hub`, and the server answers them before the registry (`src/main/host/link/link-channels.ts`):

| channel | args | result |
|---|---|---|
| `server-pair-code` | none | `{code, expiresAt}`: a device ticket (§7.4) for another desktop, `expiresAt` in epoch ms |
| `server-info` | none | `{update}`: `null`, or `{state: "staged" \| "restarting", version, commit, builtAt}` (§10) |
| `server-restart` | none | `{restarting: true}`: switch to a staged bundle if there is one, and restart now, working tabs or not |
| `server-uninstall` | `{deleteData?: boolean}` | `{ok: true}`, then the server stops, removes its service and files (`data/` too with `deleteData`, after revoking every desktop at the relay) |
| `server-bootstrap-done` | `{uploaded: boolean}` | `{ok: true}`: only a bootstrap serves it (§11) |

The server pushes the event `server-status` with the same payload as `server-info` to `*` whenever its update state changes. The desktop keeps it for itself and doesn't hand it to windows.

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

A side serves the kinds in its registry (`StreamKinds`). Later steps add `file` and `tcp`. Version 1 has three diagnostic kinds that every server serves. They only move bytes the desktop sends or asks for, so they double as a speed test, and `bundle` (§10).

- `echo`: writes back everything it reads, then ends.
- `sink {delayMs?}`: reads to the end, pausing `delayMs` (at most 1000) after each chunk to play a slow reader. Then it writes `{"bytes":N,"sha256":"<hex>"}` and ends.
- `source {bytes, seed?}`: writes `bytes` bytes (at most 4 GiB) of `sourceByte(i, seed) = (i*31 + seed + (i >>> 8)) & 0xff`, then ends.
- `bundle {version, commit, builtAt, sha256, bytes}`: the desktop writes a server bundle archive (§10.1) of exactly `bytes` bytes (at most 256 MiB) and ends. On success the server writes `{"ok":true,"state":...}` and ends; on any failure it aborts the stream with `close {reason: "error", message}`.

## 7. Pairing

A desktop and a server pair with the one-time secret, HKDF and proof of SPEC §2. The side that minted the secret makes the relay `offer` and checks the proof. The side that was handed a ticket joins the offer (`pair`) and proves the secret inside a Noise handshake of its own. The relay only ever sees `SHA-256(relayToken)` and can't compute `pairProof`.

- **Token flow** (the install one-liner): the desktop mints an `install` ticket and the new server, run by the bootstrap, holds it.
- **Code flow** (`devtool-server pair`, "Add another device"): the server mints a `device` ticket and a desktop holds it.

Code: `src/main/host/link/pairing.ts`.

### 7.1 Tickets

A ticket is base64url (no padding) of a small binary record:

```
format:u8 = 1   kind:u8 (1 install, 2 device)
x25519:32  ed25519:32  secret:32  exp:u32be (unix s)
relayLength:u8  relay (UTF-8; empty means wss://relay.devtool.awantech.sk)
nameLength:u8   name (UTF-8, at most 64 bytes, cut on a character boundary)
```

- The keys and the name are the issuer's. Its device ID is `deviceId(ed25519)` and is not sent.
- An install ticket's text is `<base64url>.<node version>`, for example `...Q.24.21.0`. `site/install` reads the Node version after the first dot with plain sh, so it can fetch Node before the bootstrap runs. A device ticket has no dot.
- A decoder rejects another format byte, a length that doesn't add up, a relay that isn't `ws://` or `wss://`, an install ticket without a `d.d.d` Node version, and a ticket of the other kind than the one it takes ("This is an install token for a new server, not a pairing code"). Expiry is a separate check.
- A ticket lives 15 minutes (the relay's limit on an offer) and works once.

### 7.2 Pairing handshake

- Envelopes: `0x05` carries Noise message 1 (ticket holder to minter) and `0x06` message 2 (minter to holder). They sit next to the link's `0x01` to `0x04` (§2.1) and a phone never sees them.
- `Noise_IK_25519_AESGCM_SHA256` with the prologue `utf8("devtool-server-pair-v1")`. The holder is the initiator, since the ticket gives it the minter's static key. The handshake opens no session: after message 2 both sides drop its state.
- Message 1 payload:
  ```json
  { "v": 1, "min": 1, "app": "devtool-server" | "devtool-desktop",
    "proof": "<b64u pairProof>", "ed": "<b64u Ed25519 pub>", "name": "...",
    "build": { "version", "commit", "builtAt", "bundleSha" },
    "host": { "os", "arch", "hostname", "node" },  // a server's only
    "bootstrap": 1 }                                 // a server being installed only
  ```
- Message 2 payload: `{ v, min, app, name, build, host?, result: "ok" | "rejected" | "incompatible", reason? }`, with `reason` one of `expired`, `used`, `wrong-secret`, `no-offer`, `bad-key`, `role`.
- The minter's rules, in order:
  - `{v, min}` are negotiated first as in SPEC §4.3; no common version answers `incompatible`. These are the pairing handshake's own versions (1 and 1), apart from the link's.
  - `app` must be the other role (`role`), and `deviceId(ed)` must equal the relay-authenticated sender (`bad-key`).
  - There must be a live offer (`no-offer`), unexpired (`expired`), and `proof` must equal its `pairProof` in a constant-time compare (`wrong-secret`).
  - The first correct proof consumes the offer. The same device (same ID and Noise key) proving it again before `exp` is answered `ok` again, in case message 2 was lost. Any other device gets `used`.
- On `ok` the minter stores the holder: its Noise key is the static key message 1 revealed, its Ed25519 key is `ed`. It sends the relay `authorize { peer, pub: ed }`.
- A message 1 that doesn't decrypt or parse is dropped without a reply.

### 7.3 Token flow

1. The desktop mints a secret and sends `offer`. Its install ticket names the desktop's relay, its keys, its name and the Node version of the server bundle it carries. The one-liner carries it in the environment, `curl -fsSL <base>/install | DEVTOOL_TOKEN=<token> sh`, never in a command line: anyone on the machine can read argv from `ps` and, since the desktop accepts a valid token without a click, pair first. `site/install` keeps it in an unexported variable and hands it to the bootstrap the same way, which drops it from its own environment before it starts anything. A token given as an argument still works, with a warning.
2. The bootstrap connects as role `server` with its new identity, sends `pair { to: desktopId, token: b64u(relayToken) }` after `ready`, then the `0x05` message 1 with `bootstrap: 1`. A relay `error forbidden` for the desktop means the token was used, expired, or the invite is gone; `error offline` means DevTool isn't on the relay.
3. The desktop routes a `0x05` from a peer it doesn't know yet to the server hub (the frame's first byte, since a phone's first frame is `0x01`). It checks the proof, stores the server in `servers.json`, sends `authorize`, `watch`es its servers again, answers `0x06 ok`, and starts the link handshake (§2) at once. There is no Accept click.
4. The bootstrap stores the desktop in `desktops.json` when it reads `ok`, so the link handshake that follows is accepted.

### 7.4 Code flow

1. The server mints a secret, sends `offer` (again after each reconnect until `exp`) and shows a device ticket.
2. The desktop checks the ticket's expiry and that its relay is the desktop's own. Its socket runs while the pairing lasts. It sends `pair { to: serverId, token }` and the `0x05` message 1, and treats the server's frames as its own while it waits (20 s).
3. The server checks the proof (§7.2), stores the desktop, sends `authorize` and answers `0x06 ok`.
4. The desktop stores the server and starts the link handshake.

A desktop already paired with a server asks it for a code with the link call `server-pair-code` (§5.1) for "Add another device".

### 7.5 One offer per host

The relay keeps one live offer per host (SPEC §3.2), shared by a desktop's phone QR and its server invite, and by a server's desktop code and (later) phone QR. A host has one invite at a time: whoever sends `offer` last holds it, and the shared socket (`RelayMux`) tells the one before, which drops its invite. Cancelling an invite doesn't withdraw the relay offer. A desktop with no server paired leaves the relay when its invite ends, which drops the offer; otherwise the desktop answers a late pairing hello `no-offer`.

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
| `src/main/host/link/pairing.ts` | §7: tickets, the pairing handshake, offers |
| `src/main/servers/` | the desktop: `ServerHub`, one `ServerConnection` per server |
| `src/server/server-link.ts` | the server: responder, one session per desktop, client registration, holds |
| `src/server/server-config.ts` | `<data>/server.json` |
| `src/main/host/link/bundle-archive.ts`, `update-policy.ts` | §10: the archive, when to upload |
| `src/server/updater.ts`, `node-install.ts`, `restart.ts` | §10: staging, Node, switching, restarting |
| `src/server/bootstrap.ts` | §11 (`site/server/bootstrap.mjs`); `site/install` comes from `scripts/server-install.sh` |
| `src/server/service.ts`, `control.ts`, `cli.ts` | the service, the CLI's control socket, `devtool-server` |

Tests: `tests/host-link-wire.test.ts` and `tests/host-link-session.test.ts` (loopback), `tests/relay-mux.test.ts`, `tests/server-link-e2e.test.ts` (desktop, relay and server in one process), `tests/server-pairing.test.ts` (tickets, offers, the pairing handshake, both flows through a relay) and `tests/server-updates.test.ts` (archive, policy, uploads through a relay).

## 10. Updates

The server runs the bundle its desktops carry (`out/server/`, built by `npm run build:server`; a packaged desktop has it in `<resources>/server`). The desktop's hello `build` is that bundle's `{commit, builtAt, bundleSha}` next to the app version.

### 10.1 Bundle archive

`src/main/host/link/bundle-archive.ts`. Every file of the bundle, `manifest.json` included:

```
"DTBUNDL1"  indexLength:u32be  index (UTF-8 JSON)  file bytes, back to back in index order
index = { "v": 1, "files": [ { "p": "<relative POSIX path>", "n": <bytes>, "x"?: 1 } ] }
```

`x: 1` is an executable (0755); every other file is 0644. The reader refuses a path that is absolute, has `..`, `.`, an empty segment or a backslash, a path that appears twice (case-insensitively), an archive that ends early or has bytes past its last file, and more bytes than `params.bytes`. After unpacking, the tree's content hash (`bundleSha256`, scripts/server-bundle.mjs) must equal the manifest's `sha256`, which must equal `params.sha256`.

### 10.2 When the desktop uploads

After every link handshake the desktop compares its bundle with the server's hello build (`decideUpdate`, `src/main/host/link/update-policy.ts`):
- The server has no bundle (`bundleSha` empty, the bootstrap): upload.
- Same `bundleSha`: nothing.
- Different, and the desktop's `builtAt` is later: upload. Otherwise nothing: a server is never downgraded. A server from a source checkout (`bundleSha: "dev"`) is left alone.

The server checks the same rule on its side and refuses a bundle built before the one it runs. A bundle the server refused is not sent to it again until the desktop restarts. While the upload runs the desktop shows the server as `updating` with `upload: {sent, total}`.

A desktop whose link version is below the server's `min` gets `incompatible` with `update: "desktop"` and shows "Update DevTool". While `HOST_LINK_MIN_VERSION` is 1 the opposite can't happen; whoever raises `min` must keep a path that lets an old server receive a bundle.

### 10.3 What the server does with it

`src/server/updater.ts`:
1. Unpack to `app/.incoming-<random>`, verify (§10.1). Fetch the Node the manifest names into `node/<version>` if it isn't there (nodejs.org `.tar.gz`, checked against `SHASUMS256.txt`, `DEVTOOL_NODE_MIRROR` overrides the base URL). Move it to `app/<version>-<sha8>` and write `run/staged.json`.
2. If no tab is working (the activity registry), answer `restarting` and restart. If one is, answer `staged`, push `server-status` (the desktop shows `updateReady`), and restart when the last working tab stops, on `server-restart`, or whenever the process stops anyway.
3. Switching flips `node/current` and `current` (a new symlink renamed over the old one), deletes `staged.json`, and deletes every bundle but the new one and the one that was running. A daemon that starts and finds a `staged.json` it never switched to switches first and restarts.
4. Restart: under systemd and launchd the process exits with code 75 and the service manager starts `current/main.js` again. Under the nohup fallback, or when run by hand, it starts the new `current` itself, detached, after letting go of the instance lock, then exits.

The desktop shows `updating` from `restarting` until the server's next handshake, or for at most 2 minutes.

## 11. Bootstrap

`site/server/bootstrap.mjs` (`src/server/bootstrap.ts`, built by `npm run build:installer`) is what `site/install` runs once it has Node. It installs a server: it pairs, receives the bundle, installs the service, and waits until the desktop's link to the new service is up. It is served by the site and the desktop is released apart from it, so it speaks a small part of this protocol that desktops keep serving: bootstrap protocol 1.

- Pairing (§7) with `bootstrap: 1` in its pairing hello, using a new or the existing identity in `data/`.
- The link handshake (§2) as the server, with `features: ["bootstrap"]` and the build of the bundle already installed (`current/manifest.json`), or an empty build.
- The `bundle` stream (§10.1) and the link calls `server-info` (`{update: null}`) and `server-bootstrap-done`.

A desktop that connects to a server with the `bootstrap` feature runs its update check (§10.2; an empty build always uploads), then calls `server-bootstrap-done {uploaded}`. The bootstrap then checks that `current/main.js --check` runs, gives up its relay socket and installs the service, which connects with the same identity. Any future desktop must keep accepting bootstrap protocol 1 like this, or bump `BOOTSTRAP_PROTOCOL` together with a new `site/server/bootstrap.mjs`.
