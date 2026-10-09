# DevTool mobile protocol, v3 (normative)

This is the normative wire spec for the DevTool mobile client: identities, the pairing URI, the relay protocol, the encrypted phone ↔ desktop channel, and the test vectors. `protocol/ts`, `relay/`, the desktop (`src/main/mobile/`) and the iOS `DevToolKit` implement exactly what it says. If an implementation has to deviate, change this file in the same change. [PROTOCOL.md](PROTOCOL.md) is the short map.

Section numbers (§1–§11) are the ones code comments cite. §6 (chat) was added in M2 and §7 (push) in M3. Nothing had shipped yet, so both are part of protocol v1 with no version bump or feature flag. Version 2 (§9) moved the channel to the desktop's Project › Stream › Task model in one hard cutover; the relay protocol (§3), Noise (§4.2) and push (§7) did not change. Version 3 (§11) adds task worktrees and still accepts version 2 peers. §3.8–§3.11 (the `server` role, binary frames, per-role budgets and flow control) came with DevTool servers. They are additive and opt-in, so phones and older desktops see the same bytes as before.

## 1. Identities and encodings

- Every device has **two long-term keypairs**: X25519 (Noise static) and Ed25519 (relay auth). Raw 32-byte public keys.
- **Device ID** = lowercase hex of the first 16 bytes of `SHA-256(ed25519Pub)` (32 hex chars). Desktop IDs and phone IDs use the same formula.
- Binary in JSON is **base64url without padding** ("b64u") everywhere.
- Desktop identity is per config dir: `<configDir>/mobile/identity.json` holds `{ x25519Priv, ed25519Priv }` (b64u) encrypted with Electron `safeStorage` (`{ enc: "safeStorage", data: <b64 of encryptString(json)> }`). If `safeStorage.isEncryptionAvailable()` is false, write `{ enc: "none", ... }` with file mode 0600 and log a warning.

## 2. Pairing URI (QR payload)

```
devtool://pair?d=<b64u(JSON)>
JSON = {
  "v": 1,
  "relay": "wss://relay.devtool.awantech.sk",   // desktop's configured relay base URL
  "id": "<desktopId>",
  "x": "<b64u desktop x25519 pub>",
  "e": "<b64u desktop ed25519 pub>",
  "s": "<b64u 32-byte one-time secret>",
  "n": "<desktop display name, e.g. hostname>",
  "exp": <unix seconds>                            // now + 300
}
```

Two values derive from the secret `s`, using HKDF-SHA256 with an empty salt and 32-byte output:
- `relayToken = HKDF(s, info="devtool-relay-token-v1")`. Sent to the relay, which only ever sees `SHA-256(relayToken)` in the offer.
- `pairProof  = HKDF(s, info="devtool-pair-proof-v1")`. Sent only inside the Noise handshake payload. The relay can't compute it.

The secret is single-use and expires at `exp`. When a new QR is shown, the previous offer is invalidated.

Decoders reject a URI whose `v` isn't 1, whose `relay` isn't a `ws://` or `wss://` URL, whose `x`/`e`/`s` aren't 32 bytes, or whose `id` isn't `deviceId(e)`. A tampered QR could otherwise pair the phone with keys the relay routes to a different desktop. Expiry is a separate check, so the UI can say "expired" rather than "invalid". Unknown JSON fields are ignored. b64u decoding is strict everywhere: no padding, no characters outside the alphabet, and no non-canonical trailing bits.

## 3. Relay protocol v1

WebSocket at `<relay>/v1`. Text frames, one JSON object each, with discriminator `t`. After `ready`, frames can also travel as binary WebSocket messages (§3.9). The relay treats everything inside a frame's data as opaque.

There are three roles. A **phone** is the iOS app. A **desktop** is DevTool. A **server** is a headless DevTool host on another machine: toward phones it behaves exactly like a desktop, and desktops pair with it too. Desktops and servers are **hosts**. §3.8 has the pairing rules, and §3.8–§3.11 were added with servers. They are additive: still `/v1`, and phones see no difference.

### 3.1 Auth
1. Relay → `{ "t":"challenge", "nonce":"<b64u 32>" }` immediately on open.
2. Client → `{ "t":"hello", "role":"desktop"|"phone"|"server", "pub":"<b64u ed25519 pub>", "sig":"<b64u>", "pair"?: { "to":"<hostId>", "token":"<b64u relayToken>" }, "binary"?: true }`
   - `sig = Ed25519.sign(utf8("devtool-relay-v1\n" + role + "\n" + nonce))`, where `nonce` is the b64u string exactly as received.
   - `pair` makes the client pending under `to`'s live offer (§3.8). A phone sends it while it isn't yet authorized for that host. A server sends it when it installs against a desktop's offer.
   - `binary: true` asks for frames as binary messages (§3.9).
3. Relay → `{ "t":"ready", "id":"<deviceId>", "binary"?: true }`, or `{ "t":"error", "code":"auth", ... }` and close (code 4401).
   - `binary: true` is present only when the hello asked for it, so a phone's or older desktop's `ready` is unchanged.
   - A hello whose `role` this relay doesn't know gets `{ "t":"error", "code":"unsupported" }` and close 4401 (§3.11).
   - Hello must arrive within 10 s, or the relay closes with 4408.

### 3.2 Host → relay (desktops and servers)
- `{ "t":"offer", "tokenHash":"<b64u SHA-256(relayToken)>", "exp":<unix s> }`: replaces any previous offer from this host. Held in memory only.
- `{ "t":"authorize", "peer":"<deviceId>", "pub":"<b64u its ed25519 pub>" }`: persists the pair (this host as owner, `peer`). Only valid for a device that is pending under this host's offer, or that this host already authorized. Desktops from before servers send `"phone"` instead of `"peer"`. The relay accepts either one, but not both.
- `{ "t":"revoke", "peer":"<deviceId>" }` (or `"phone"`): deletes the pair with that device, whichever side owns it, and cancels a pending pair in either direction. If the other device is connected, the relay sends it `{ "t":"peer", "id":<revoker's id>, "state":"revoked" }` and stops routing between them.
- `push` (§7.2).

### 3.3 Client → relay
- `{ "t":"watch", "desktops":["<hostId>", ...] }`, from phones and desktops: subscribe to the presence of hosts. A phone watches desktops and servers, and a desktop watches servers. IDs the sender has no authorized pair with, and IDs that aren't its host (§3.8), are ignored. The relay replies with one `peer` message per ID it kept. The field is called `desktops` because it predates servers.
- `{ "t":"pair", "to":"<hostId>", "token":"<b64u relayToken>" }`, any role, after `ready`: the same as hello `pair`, for a device that is already connected. A desktop uses it to pair with a server's offer (§3.8, code flow). There is no reply on success. Failures are the hello `pair` errors (§3.7).

### 3.4 Both directions
- `{ "t":"frame", "to":"<id>", "data":"<b64u>" }` → the recipient gets `{ "t":"frame", "from":"<id>", "data":"<b64u>" }` (or a binary frame, §3.9). Frames are allowed only between two devices with an authorized pair (in either direction), or with a pending one: the peer presented a token matching the owner's live offer (§3.8). A pending peer that isn't authorized within the offer's lifetime is no longer routed (§3.7). The relay consumes the offer (deletes it) when the first peer attaches, so each offer works once.
- If the recipient is offline, the relay replies to the sender `{ "t":"error", "code":"offline", "to":"<id>" }` and drops the frame. **Nothing is queued.**
- Presence: `{ "t":"peer", "id":"<id>", "state":"online"|"offline"|"revoked", "lastSeen"?:<unix ms> }`. A host receives it for the devices it hosts (§3.8), authorized or pending, without asking: desktops for their phones, servers for their phones and desktops. Phones and desktops receive it for the hosts they `watch`.
- `{ "t":"ping" }` / `{ "t":"pong" }` keepalive. Clients ping every 25 s, and the relay closes sockets silent for 60 s.
- Errors: `{ "t":"error", "code":"auth"|"offline"|"forbidden"|"rate"|"bad-request"|"unsupported", "message"?:string, "to"?:string }`.
- Forward compatibility: clients treat an error `code` they don't know as a generic error (it is still routed by `to`), and ignore a `peer` message whose `state` they don't know. The relay sends only the values listed here.

### 3.5 Limits
| | phones (and any socket before its hello) | desktops and servers |
|---|---|---|
| Message size | 256 KiB, text or binary (close 1009) | same |
| Messages | 50/s, burst 200. Over it: `error rate`, then close 4429 on a repeat (§3.7) | 1000/s, burst 4000 |
| Payload bytes | no separate limit | 8 MiB/s, burst 32 MiB |
| Over budget | refused | throttled: the relay stops reading the socket until it is back in budget (§3.10). No `rate`, no 4429 |
| Send queue cap | 8 MiB, then disconnected | 32 MiB, then disconnected |
| Pushes (§7.2) | not allowed | 50/s, burst 200, then `pushed rate` |

- Backpressure (§3.10): senders to a receiver whose send queue is over 4 MiB are paused until it is back at 1 MiB. A receiver that doesn't get back to 1 MiB within 15 s is disconnected.
- Per IP: 20 new connections/min and 64 open connections at once (HTTP 429 at the upgrade beyond either). All connections from one IP, any role, share 16 MiB/s of payload bytes (burst 64 MiB), throttled like a host's.
- Per device: at most 16 pending pairs at once (`forbidden` "too many pending pairs") and 256 authorized pairs (`forbidden` "too many pairs" on `authorize`). Per IP, at most 60 new pairs an hour (`rate` on `authorize`). Repeating `authorize` for a stored pair costs nothing.
- A `watch` from a desktop costs one message token per ID it names.
- Relay-wide, the send queues together may hold 512 MiB. Past that the relay drops the connections with the largest queues first.
- A second connection with the same device ID replaces the first (the old one is closed with 4409).
- The numbers are constants in `protocol/ts/relay-messages.ts`: `RELAY_MAX_FRAME_BYTES`, `RELAY_RATE_PER_SECOND`/`_BURST` (phones), `RELAY_HOST_RATE_PER_SECOND`/`_BURST`, `RELAY_HOST_BYTES_PER_SECOND`/`_BURST`, `RELAY_IP_BYTES_PER_SECOND`/`_BURST`, `RELAY_PUSH_RATE_PER_SECOND`/`_BURST`, `RELAY_BUFFER_HIGH_WATER_BYTES`/`LOW_WATER_BYTES`, `RELAY_STALL_TIMEOUT_MS`, `RELAY_PHONE_BUFFER_CAP_BYTES`, `RELAY_HOST_BUFFER_CAP_BYTES`, `RELAY_MAX_CONNECTIONS_PER_IP`, `RELAY_MAX_PENDING_PER_DEVICE`, `RELAY_MAX_PAIRS_PER_DEVICE`, `RELAY_NEW_PAIRS_PER_IP_PER_HOUR`. These are defaults: an operator may change some of them (relay/README.md, Environment), so clients must not depend on exact values.

### 3.6 Persistence
`node:sqlite` at `$RELAY_DATA/relay.db`. The pairs table is `pairs(owner_id, owner_role, owner_pub, peer_id, kind, peer_pub, created_at, PRIMARY KEY(owner_id, peer_id))`, indexed on `peer_id`, with `PRAGMA user_version = 2`. The owner made the offer and sent `authorize`, and `kind` is the peer's role. Two devices have at most one row, in one direction. `lastSeen` is kept in memory. A push gateway also keeps `push_devices` (§7.1).

A database from before servers has `pairs(desktop_id, phone_id, phone_pub, desktop_pub, created_at)`. The relay migrates it when it opens the file, in one transaction: each row becomes owner = `desktop_id` (role `desktop`), peer = `phone_id`, kind `phone`. The migration is one way. A relay from before servers can't open the migrated file, so back up `relay.db` before upgrading if you may roll back.

### 3.7 Details settled by the relay implementation
The rules above left these open. `relay/` implements them, and clients may rely on them.
- **Pair token that doesn't match.** If the token is wrong, the offer is already consumed or expired, or the host has no offer, a hello `pair` still gets `ready`. Right after it comes `{ "t":"error", "code":"forbidden", "to":<hostId> }`, and the device isn't pending. The `pair` message gets the same error. So does pairing with oneself, or two roles that may not pair (§3.8), and in that last case the offer is not used up. A device already paired with `to` (in either direction) has its `pair` ignored.
- **Pending lifetime.** Pending status belongs to the (owner, peer) pair and lasts until the offer's `exp`. The relay clamps `exp` to at most 15 minutes ahead. An `exp` already in the past means there is no offer. Pending status survives a reconnect of either side within the window, and the peer doesn't send the token again. `authorize` works for a pending peer even while it is briefly disconnected.
- **Lapse.** When the window ends without `authorize`, a connected peer gets `{ "t":"error", "code":"forbidden", "to":<ownerId>, "message":"pairing window expired" }`. If the owner is connected too, the host of the two gets `peer offline` for the other. The relay then closes a phone with **4403**, unless it is authorized or pending with another host, in which case its socket stays open for those. Desktops and servers stay connected.
- **Offers** are dropped when the host's connection closes or is replaced.
- **`authorize`** returns `bad-request` if `pub` doesn't hash to `peer`. It returns `forbidden` if the peer is neither pending under this host's offer nor authorized by this host, or if `pub` differs from the key the peer authenticated with (or the stored one). Success has no reply, and repeating it is harmless. **`revoke`** is idempotent, and it also cancels a pending pair. The other device gets `peer revoked` only if something was actually removed.
- **`watch`** replaces the previous watch set and carries at most 256 IDs (`bad-request` otherwise). For an offline host the reply is `offline`, with `lastSeen` when the relay knows it.
- **Host roster.** Right after `ready`, a host gets `peer online` for each device it hosts (authorized or pending) that is connected, and `peer offline` with `lastSeen` for each one whose `lastSeen` the relay knows. A device that becomes pending through the `pair` message, while both sides are connected, is announced to the host with `peer online` at once.
- **Replacement.** A connection replaced by the same device ID (4409) doesn't announce `offline`. The new connection announces `online` again.
- **Close codes.** Idle timeout and relay shutdown close with **1001**. The others are 1009, 4401, 4403, 4408, 4409 and 4429. `RelayCloseCode` in `protocol/ts` (and `RelayProtocol.CloseCode` in Swift) lists all of them, 1001 as `GoingAway` and 4403 as `PairingExpired`. A receiver the relay drops for not reading (its send queue cap, the stall timeout, or the relay-wide ceiling, §3.10) gets no close frame, because it would sit behind the data the receiver isn't reading. The client sees the connection end (1006).
- **Rate.** Every client message costs a token, including `hello` and `ping`. For a phone, the first message over the limit is dropped and answered with `error rate`. Another over-limit message within 10 s of it gets `error rate` again and the relay closes with 4429. Desktops and servers are throttled instead (§3.10). The per-IP limit counts refused attempts too. It answers HTTP 429 during the upgrade. With `RELAY_TRUST_PROXY=1` the client IP is the **last** `X-Forwarded-For` entry.
- **Errors.** The relay checks `forbidden` before `offline`, so an unpaired device can't probe presence. A frame addressed to oneself is `forbidden`. Before auth, anything except a valid `hello` (including binary or malformed JSON) gets `error auth` and 4401, except a hello with an unknown role, which gets `error unsupported` and 4401. After auth, malformed messages get `bad-request`, a message type the relay doesn't know gets `unsupported`, and the socket stays open in both cases. A binary message is a frame (§3.9); one too short to be a frame gets `bad-request`. Role violations get `forbidden`: a phone sending `offer`, `authorize`, `revoke` or `push`, or a server sending `watch`.
- **HTTP.** `GET /healthz` returns 200 `ok`. A plain GET on `/v1` returns 426. `/v1/push/register` and `/v1/push/send` (§7) answer 503 `{"error":"unavailable"}` on a relay that isn't a gateway. On the gateway they take `POST` only (405 otherwise) with a JSON body of at most 16 KiB (413 beyond, 400 `bad-request` if it isn't JSON). `/v1/push/send` answers 200 `{"result":"bad-request"}` when `cap` or `data` isn't a string. Every other path returns 404 (including upgrades). Request headers, the upgrade's included, must arrive within 10 s.

### 3.8 Roles and pairs
- **Allowed pairs.** Phone↔desktop, phone↔server and desktop↔server. Two devices with the same role never pair. Phones never offer, so a phone is always the peer.
- **Owner and peer.** The host that made the offer is the owner. The device that presented the token is the peer, and is pending until the owner sends `authorize`. Both sides may `revoke`.
- **Who hosts whom.** Of the two roles, the higher one in `phone < desktop < server` is the host. The host gets the other side's presence by itself (roster and `peer` messages). The other side `watch`es the host. This doesn't depend on who owns the pair.
- **Desktop↔server, token flow.** The desktop sends `offer`. The server connects with `hello { role: "server", pair: { to: <desktopId>, token } }` and is pending. Right after `ready` it gets `peer online` for the desktop. The desktop sends `authorize { peer: <serverId>, pub }`.
- **Desktop↔server, code flow.** The server sends `offer`. A connected desktop sends `{ "t":"pair", "to":<serverId>, "token":... }` and is pending, and the server gets `peer online` for it. The server sends `authorize { peer: <desktopId>, pub }`.
- **Phone↔server.** It works exactly as phone↔desktop: the server offers and authorizes, and the phone pairs in its hello and watches the server.
- The relay only routes. Proof of the pairing secret and the end-to-end handshake between the two devices belong to the channel above it (§2, §4 for phones).

### 3.9 Binary frames
- After `ready`, any client may send a binary WebSocket message `[16 bytes][envelope]`. The 16 bytes are the destination's device ID as raw bytes (the ID is their lowercase hex). The envelope is what `frame.data` would carry (§4.1), at least 1 byte. Routing, checks and errors are those of `frame`. Errors stay JSON `error` messages, with `to` set to the destination.
- The relay delivers each frame in the format its receiver chose in hello. With `binary: true`, the receiver gets a binary message `[16 bytes of the source's ID][envelope]`. Without it (phones, older desktops), the receiver gets `{ "t":"frame", "from", "data" }` as before. The relay converts in both directions.
- The 256 KiB cap applies to what a client sends. A binary frame converted to JSON grows to about 4/3 of its size, plus the JSON around it, and receivers must accept that. Phones only ever get envelopes of at most 65536 bytes (§4.2).
- `encodeRelayBinaryFrame` and `decodeRelayBinaryFrame` in `protocol/ts` implement the format.

### 3.10 Flow control
- **Host budgets.** When a desktop's or server's message or byte budget (§3.5) runs out, the relay finishes the message in hand. It then stops reading that socket until both budgets are back. The client sees only TCP backpressure, and nothing is dropped or answered `rate`.
- **IP budget.** Every connection from one IP, phones included, spends from a shared byte budget (§3.5) and is throttled the same way when it runs out.
- **Backpressure.** After the relay queues a frame for a receiver, if the receiver's send queue (bytes the relay wrote that the OS hasn't taken) is over 4 MiB, the relay stops reading the sender's socket. When the queue is back at 1 MiB, every sender held back by that receiver is read again. Nothing is dropped. The queue can pass 4 MiB by at most one message per sender.
- **Stalls.** Once a connection's send queue is over 4 MiB, for whatever reason, the connection has 15 s to drain it to 1 MiB. If it doesn't, the relay drops it: a receiver that keeps writing (pings, say) but never reads can't hold memory or its senders for longer than that. Its senders are read again, and their next frames to it get `offline`. A receiver must therefore read at least 3 MiB in 15 s whenever it is that far behind.
- **Caps.** A receiver whose queue still passes 32 MiB (desktops, servers) or 8 MiB (phones) is disconnected at once. So are the largest queues when all queues together pass the relay-wide ceiling (§3.5). The held-back senders are read again.
- **Head-of-line blocking.** Pausing a sender stops everything it sends, including frames to other peers and its pings, so its pongs arrive late. This is accepted in v1. The stall timeout bounds it at 15 s per receiver. A link that keeps at most about 1 MiB in flight never reaches the high-water mark in normal operation, unless several senders write to one slow receiver at once.
- The relay doesn't apply its idle timeout to a socket it isn't reading. A client may get its pongs late while it is held back. It should only give up on the relay when nothing at all has arrived for the idle timeout.
- **Roles are claimed, not proven.** Any key may say `desktop` or `server` and get the host budgets. It can still only reach devices it is paired with, so the most it can do is move its own data through the relay, within its connection, IP and pair budgets. An operator who needs less can lower the host and IP byte budgets (relay/README.md).

### 3.11 Relays from before servers
A client from this version can tell an old relay apart:
- **Desktops** send `binary: true` in hello. An old relay ignores the field, so its `ready` has no `binary`. A desktop that gets `ready` without `binary: true` treats the relay as too old for servers ("This relay is too old for servers"). It sends no `pair`, `watch` or binary frames there, and keeps its phones working.
- **Servers.** An old relay can't parse role `server`. It answers `{ "t":"error", "code":"auth", "message":"malformed hello" }` and closes with 4401. A server's hello is always signed correctly, so a server that gets `auth` treats the relay as too old.
- On an old relay, `pair`, `authorize { peer }` and `revoke { peer }` get `bad-request`. A desktop's `watch` gets `forbidden`, and binary messages get `bad-request` ("text frames only").
- From this version on, an unknown message type gets `unsupported`, and so does a hello with an unknown role (then 4401). A newer client that gets `unsupported` knows the relay is older than it is.

## 4. Channel between phone and desktop

### 4.1 Frame envelope
`frame.data` bytes = `[kind:u8] || body`.
- `0x01` = Noise handshake message 1 (phone → desktop)
- `0x02` = Noise handshake message 2 (desktop → phone)
- `0x03` = Noise transport message (either direction)
- `0x04` = reset (either direction, empty body): "I have no session, handshake again"

### 4.2 Noise
`Noise_IK_25519_AESGCM_SHA256` exactly per the Noise spec rev 34. The phone is the initiator (it knows the desktop static key from the QR code).
- Prologue: `utf8("devtool-mobile-v1")`.
- The cipher is AES-256-GCM with a 16-byte tag. Its nonce is 4 zero bytes followed by the 64-bit **big-endian** counter (the Noise AESGCM rule, which differs from ChaChaPoly's little-endian one).
- Why not ChaChaPoly: Electron's main process uses BoringSSL, and its Node `crypto` (and WebCrypto) has no `chacha20-poly1305`. We checked on Electron 43 / Node 24.20. AES-256-GCM is available in Electron, Node and CryptoKit, so nothing is hand-rolled.
- After message 2, both sides `Split()`. The phone's send key is `k1`, and the desktop's send key is `k2`.
- A new handshake happens on every (re)connection of either side. If either side receives a transport frame it can't decrypt, or a frame with no session, it replies `0x04` and drops it. On receiving `0x04`, the phone starts a new handshake. Transport messages must not exceed 65535 bytes (the Noise limit). App messages larger than 60000 bytes are split into fragments (§6.1).

### 4.3 Handshake payloads (UTF-8 JSON)
Message 1 payload (phone):
```json
{ "v": 3, "min": 2, "app": "ios/0.2.0", "features": [],
  "kind": "pair" | "resume",
  "proof": "<b64u pairProof>",          // kind=pair only
  "deviceName": "Vladimir's iPhone",
  "ed": "<b64u phone ed25519 pub>" }
```
Message 2 payload (desktop):
```json
{ "v": 3, "min": 2, "app": "devtool/0.3.2", "features": [],
  "desktopName": "join3r-mbp",
  "result": "ok" | "pending" | "rejected" | "incompatible" | "unknown-device" }
```
Desktop rules:
- `resume`: the phone's Noise static key must match a stored pairing. If it doesn't, the desktop answers `unknown-device`.
- `pair`: the `proof` must equal (constant-time compare) the live offer's `pairProof`, and the offer must be unexpired. Then the desktop answers `pending` and asks the user to Accept.
  - On Accept, it stores the pairing, sends relay `authorize`, and sends the app message `pairing` with `status: "accepted"`.
  - On Reject, it sends `status: "rejected"`, and the relay disconnects the phone when the offer lapses.
- Version: `chosen = min(v_phone, v_desktop)`. If `chosen < max(min_phone, min_desktop)`, the answer is `incompatible`. N is 3, and both sides send `min: 2`: version 1 is refused, not translated (§9), and version 2 is still spoken (§11). The session speaks `chosen`: a desktop answers a version 2 phone the version 2 way where the two differ (§8.7). The side whose `v` is below the other's `min` is the one to update. The desktop says so in its Mobile settings ("Update DevTool on your iPhone" for a phone below its `min`), and the phone says "Update DevTool" (the desktop is older) or "Update the app".
  - The desktop reads only `{ v, min }` first and negotiates on that, so a phone whose payload has a future shape still gets a clean `incompatible`. Both sides must send `min <= v`, with `v >= 1`.
- The phone's `ed` must be the Ed25519 key the relay authenticated, i.e. `deviceId(ed) == frame.from`. If it isn't, the desktop answers `rejected`.
- `pair` with a wrong proof, or with no live unexpired offer, is answered `rejected`. A correct proof consumes the offer on the desktop too, so the next phone needs a new QR.
- A pending request outlives either side's socket until the consumed offer's `exp`, as the relay's pending status does (§3.7). While it lasts, the same phone (same Ed25519 and Noise static keys) handshaking `pair` again with the same proof is answered `pending` again. If the user accepted while the phone was away, that next `pair` handshake is answered `ok` once, and later ones use `resume`. When the window closes, the desktop drops the request.
- If message 1 can't be processed (decryption fails or it is truncated), the desktop drops it silently and doesn't reply `0x04`. A phone holding the wrong desktop key would otherwise loop.
- Only `ok` and `pending` establish a session. With any other result the desktop discards its handshake state after sending message 2.

### 4.4 App messages (inside transport, UTF-8 JSON, discriminator `t`)
- Phone → desktop `{ "t":"req", "id":<int>, "op":"inbox.get", "params"?: <op-specific JSON> }` (`params` is used by the §6.3 ops; `null` is absent) → desktop `{ "t":"res", "id":<int>, "ok":true, "result": Inbox }` or `{ "t":"res", "id", "ok":false, "error":{ "code", "message" } }`.
- Desktop → phone `{ "t":"evt", "e":"inbox", "seq":<int>, "inbox": Inbox }`: a full replacement, sent after any change and throttled to at most one per second. `seq` increases per session.
- Desktop → phone `{ "t":"evt", "e":"pairing", "status":"accepted"|"rejected"|"revoked" }`.
- Unknown `t`, `op` or `e` values are ignored (`req` gets `ok:false, code:"unsupported"`). Unknown fields are ignored everywhere.
- `error.code` values are `unsupported`, `bad-request`, `not-authorized` (a `req` from a phone whose pairing is still `pending`), `internal`, and from §6.3 `not-found` and `gone`. Receivers treat `code` as an open string and a missing `message` as `""`.
- A pending session (`result: "pending"` before Accept) gets no `inbox` events.
- A receiver treats an optional field set to `null` as absent. It keeps an unknown tab `type` as a string and shows an unknown `status` as `"idle"`, so a newer desktop doesn't break an older phone. Senders must still send only the values listed here.

`Inbox`:
```json
{
  "desktop": { "id": "…", "name": "join3r-mbp" },
  "generatedAt": 1790000000000,
  "projects": [{
    "id": "…", "name": "api-server", "emoji": "🚀", "remote": false,
    "streams": [
      { "id": "…", "name": "main", "main": true },
      { "id": "…", "name": "0.5.0", "branch": "0.5.0" }
    ],
    "lastStreamId": "…",
    "tasks": [{
      "id": "…", "name": "fix-auth",
      "streamId": "…", "streamName": "0.5.0",
      "status": "working" | "attention" | "exited" | "idle",
      "since": 1790000000000, "activity": "Running Bash",
      "lastInteractedAt": 1790000000000,
      "attentionAt": 1790000000000,
      "eventAt": 1790000000000, "unread": true,
      "settledAt": 1790000000000, "snoozedUntil": 1790000000000, "snoozeUntilAttention": true,
      "branch": "0.5.0--fix-auth",
      "landing": { "state": "landing" | "conflict" | "blocked" | "fixing",
                   "intent": "close" | "land" | "update",
                   "files": ["src/auth.ts"], "fileCount": 1, "message": "…" },
      "tabs": [{
        "id": "…", "type": "claude-chat", "title": "Claude",
        "status": "working" | "attention" | "exited" | "idle",
        "since": 1790000000000,
        "activity": "Running Bash", "topic": "Fix the login redirect"
      }]
    }]
  }],
  "pinned": [{ "projectId": "…" }, { "projectId": "…", "streamId": "…" }, { "projectId": "…", "streamId": "…", "taskId": "…" }]
}
```
- `streams` lists the project's open streams in sidebar order, `main` first (`main: true`, exactly one, the project folder), empty ones included. `branch` is present only on a worktree stream: the branch its worktree is on. `lastStreamId` is the stream the project was last used in, present only while that stream is open.
- `tasks` lists every open task, stream by stream. A task is one agent session or one terminal task (its main tab is a terminal). `streamId` and `streamName` name the stream holding it (the phone's `Project · Stream` line); `streamId` is always one of the project's `streams`.
- A task's `status` is its one status: the strongest of its **status tabs** (its main tab, plus any agent tab) in the order `attention`, `working`, `exited`, else `idle`. An extra terminal's bell or exit lights only its own tab, never the task. `since` is when the task entered `status` (the oldest change among the status tabs in it), and `activity` the label of the first such tab that has one. The desktop Inbox and sidebar read the same status.
- Only agent/terminal tab types are included in `tabs`: `claude-chat`, `claude`, `codex`, `pi`, `terminal`. A tab's `status` is `TabActivityRegistry`'s value, with `null` mapped to `"idle"`.
- `activity` (on a task or a tab) is an optional short label derived from `AgentActivity`.
- `topic` (on a tab) is an optional line saying what an agent tab's conversation is about: Claude's session title, else the first line of its last prompt. The phone heads the tab's row with it, above the tab type.
- The triage fields carry the desktop inbox's state for the task (§8.11). `eventAt` is the task's last event: a hook notification or stop, a terminal bell, a process exit. `unread: true` is present while the desktop counts the task unread. `settledAt` is present while the task is settled (an event after the settle un-settles it). `snoozedUntil` is present while a timed snooze hasn't passed at `generatedAt`, and `snoozeUntilAttention: true` while the task is snoozed until it needs the user. A desktop sends at most one of the two snooze fields, and drops `settledAt` from a snoozed task. A receiver treats `unread` and `snoozeUntilAttention` other than `true` as absent.
- `branch` and `landing` (version 3, §11) belong to a task with a worktree of its own, a new task in a worktree stream once its first tab needs a folder. `branch` is that worktree's branch (`<stream branch>--<task slug>`); it is absent for a task in `main`, in a stream without a worktree, or sharing its stream's worktree (tasks from before version 3). `landing` is present while the task lands into its stream or has stopped doing so:
  - `state` is `landing` (running), `conflict` (the rebase onto the stream stopped in the task's worktree), `blocked` (the stream's worktree refused the fast-forward: local changes in the files being landed) or `fixing` (the task's agent was asked to resolve the conflict, §8.15). A receiver keeps an unknown `state` as a string and offers no actions for it.
  - `intent` is what was asked for: `close` (absent means `close`; the task goes to Done once it lands), `land` (it lands and stays open) or `update` (rebase onto the stream only, from the desktop's Update from stream). A receiver drops an unknown `intent`.
  - `files` lists the conflicted files (`conflict`, `fixing`) or the stream's files in the way (`blocked`), at most the first 20, and `fileCount` is how many there are in all; both are present only when there are files. `message` is git's reason (`blocked`), at most 1000 characters.
  - A task whose landing is `conflict` or `blocked` is the user's turn on the desktop's Inbox, ahead of a working tab; `landing` and `fixing` are not.
- Archived streams and tasks are never sent, nor is anything inside an archived stream. Ephemeral-but-spent projects (no open task left) and projects with `hideFromMobile: true` are excluded. Filtering happens before encryption.
- `projects` follows the desktop's `projectOrder`.
- `pinned` is the desktop sidebar's Pinned list in its order: a project, a stream when `streamId` is set, or a task when `taskId` is set (its `streamId` is then the stream holding the task now). A pin whose project, stream or task isn't in `projects` (hidden, spent, archived, gone) is left out, and the field is absent when nothing is left. A phone ignores a pin it can't resolve. A pinned stream shows its tasks under it; its tasks are not pinned by themselves.

## 5. Test vectors (`protocol/vectors/`)
- `noise-ik.json`: fixed static and ephemeral keys for both sides, prologue, payloads, and the expected message 1 and message 2 bytes, then 3 transport messages each way with their expected ciphertexts. The TS implementation must *also* pass the official cacophony `Noise_IK_25519_AESGCM_SHA256` vectors, which ensures the generated vectors aren't just self-consistent.
- `derive.json`: secret → relayToken, pairProof, tokenHash. ed25519 pub → deviceId.
- `relay-auth.json`: ed25519 seed + nonce + role → sig (Ed25519 is deterministic).
- `pairing-uri.json`: object ↔ URI.
- `app-messages.json`: sample valid messages, including unknown extra fields that must be ignored.
- `fragments.json` and `chat-messages.json` (M2, §6.7).
- `project-tile.json`: project tiles and places (§10).
- The field layout of every file is in `protocol/vectors/README.md`. `protocol/vectors/official/noise-ik-25519-aesgcm-sha256.json` holds the IK entries from cacophony, snow and noise-c. The generated files are rewritten by `node protocol/ts/generate-vectors.ts`, and a test fails if they have drifted.

The Swift `DevToolKit` tests load these files directly from `../../protocol/vectors`.

## 6. Chat (M2)

On the phone, a Claude chat tab (`type: "claude-chat"`) opens as a live transcript: send a message, answer permission prompts, questions and plan approvals, stop a turn, and expand a tool row. `protocol/ts/fragments.ts` and `protocol/ts/chat-messages.ts` implement this section.

### 6.1 Fragmentation (transport plaintext)

M1 transport plaintext is always UTF-8 JSON, so its first byte is `{` (0x7B). M2 adds a fragment form:

```
0x7B …                                  complete JSON message (unchanged)
0x01 id:u32be i:u16be n:u16be chunk…    fragment i of n (0-based) of message `id`
```
- A sender splits any encoded JSON message over **60000** bytes into chunks of 60000 bytes (the last one shorter), in order. A message of exactly 60000 bytes goes whole. `n` ≥ 2, and `id` is a per-session counter in each direction, starting at 0 for the first split message and wrapping at 2³².
- Chunks are bytes: a chunk boundary may fall inside a UTF-8 character. The receiver concatenates the chunks in order `0…n-1`, then parses the result as JSON. Fragments of one message are sent consecutively, but a receiver must not depend on that beyond the limits below; it accepts chunks in any order and interleaved with other messages (complete or fragmented).
- Limits: a reassembled message is at most **4 MiB** (so `n` ≤ 70), a chunk is at most 60000 bytes, at most **4** messages can be partially received at once, and a message still missing chunks **30 s** after its first one arrived is dropped.
- Violations: `n` < 2 or > 70, `i` ≥ `n`, a chunk over 60000 bytes or a header with no chunk, `n` differing from the message's earlier fragments, a chunk index received twice, or a message growing past 4 MiB. Each drops that message's partial state (and the offending fragment) and is logged. A fragment that would start a fifth partial message is dropped; the four already partial are kept. The session survives all of these.
- A session reset (`0x04`) or a new handshake clears all partial messages.
- Plaintext with any other first byte is ignored.
- A sender never produces a message over 4 MiB; if it would, it sends something smaller instead (an `internal` error for a `res`).

### 6.2 Chat view model

The desktop maps its `ChatState` (`src/shared/claude-chat.ts`) to this schema. The phone renders only this schema.

```ts
ChatView = {
  tabId: string,
  title: string,                       // tab title
  busy: boolean, turnStartedAt?: number,
  process: 'idle' | 'starting' | 'running' | 'exited', processError?: string,
  permissionMode?: string, model?: string,
  settings?: ChatViewSettings,         // the composer's pickers (desktops that list chat.settings, §8.5)
  usage?: ChatViewUsage,               // the composer's meter
  items: ChatViewItem[],               // oldest → newest, WINDOWED (see 6.4)
  hasEarlier: boolean,                 // more items exist before items[0]
  prompts: ChatViewPrompt[]            // open prompts, oldest first
}
ChatViewSettings = {
  model?: string,                      // the picked models[].value; absent = Claude's settings default
  modelName?: string,                  // what the session runs, by name ("Opus 4.5"), once known
  models: [{ value, label, description? }],   // pickable models; no "Default" row (the phone adds it)
  effort?: string,                     // the picked effort; absent = the default
  defaultEffort?: string,              // what the default effort resolves to, once known
  efforts: string[]                    // the levels the current model takes
}
ChatViewUsage = {                      // each part once the desktop has read it
  contextTokens?: number, contextMax?: number,
  costCents?: number,                  // session cost at API list prices, US cents
  fiveHour?: { used: number, resetsAt?: number },   // claude.ai plan windows: integer percent used, unix ms
  sevenDay?: { used: number, resetsAt?: number }    // absent for API-key sessions
}
ChatViewItem =
  | { kind: 'user', id, text, images?: number, queued?: true, failed?: true }
  | { kind: 'text', id, markdown, streaming?: true }
  | { kind: 'thinking', id, preview, streaming?: true }          // preview ≤ 300 chars
  | { kind: 'tool', id, name, summary, status: 'pending'|'running'|'waiting'|'done'|'error'|'denied',
      hasDetail: boolean, childCount?: number, lastChild?: string, images?: number }   // images: §8.9
  | { kind: 'notice', id, text, tone: 'muted'|'warning'|'error' }
ChatViewPrompt =
  | { kind: 'permission', id, toolName, title, summary, detail?: string,  // detail ≤ 4000 chars (e.g. full command / diff excerpt)
      canAlwaysAllow: boolean, agent?: true }
  | { kind: 'question', id, questions: [{ question, header?, multiSelect: boolean,
      options: [{ label, description? }] }] }
  | { kind: 'plan', id, markdown }                              // ExitPlanMode
```
- `text.markdown` and `user.text` are capped at 16000 chars. Anything past that is cut, ends in "…", and is fetched through `chat.detail`.
- `tool.summary` is the same one-line label the desktop shows (`summarizeTool` / the item's `label`). `hasDetail` is true when `chat.detail` has something to show (the tool has input or a result).
- Flags (`queued`, `failed`, `streaming`, `agent`) are either `true` or absent. `images` is only sent when it is at least 1. A user item's images are only counted. A tool item's `images` (at most 4) counts the images its result carried, and each is fetched with `chat.image` (§8.9); image bytes never travel in the view.
- Item IDs are unique within a chat and stable across events. A tool item's ID is its `tool_use` ID; a user item's is its message UUID.
- `settings` and `usage` are labelled and rounded the way the desktop composer shows them, so the phone does no model matching of its own. Like the other status fields they are sent whole in every `evt chat` (§6.4), and a change to either flushes at once.
- Forward compatibility, extending §4.4: an item or prompt with an unknown `kind` keeps its place and renders as "Needs a newer app" (`protocol/ts` parses it to `{ kind: 'unknown', id, unknownKind }`). An unknown tool `status` reads as `pending`, an unknown notice `tone` as `muted`, and an unknown `process` as `idle`. A known kind missing a required field makes the whole message malformed.

### 6.3 Ops (phone → desktop `req`)

All ops take `params` in the `req` object: `{ t:'req', id, op, params }`.

| op | params | result |
|---|---|---|
| `chat.open` | `{ tabId }` | `{ seq, view: ChatView }`. Subscribes this phone to the chat's events until `chat.close`, a disconnect, or another `chat.open` (**one open chat per phone**; opening a second chat silently ends the first subscription). Attaches a runtime from the tab's stored config if the chat isn't live, the same way a window attaching does (which starts the process when it isn't running). |
| `chat.close` | `{ tabId }` | `{}` |
| `chat.earlier` | `{ tabId, before: itemId, limit?: ≤100 }` | `{ items: ChatViewItem[], hasEarlier }`: up to `limit` (default and maximum 100; larger values are clamped) items immediately before `before`, oldest first. Unknown `before` → `not-found`. |
| `chat.send` | `{ tabId, text }` (≤ 32000 chars, not blank) | `{}`. Same path as the composer's send (`ClaudeChatManager.send`), which restarts a dead process. |
| `chat.answer` | `{ tabId, promptId, answer }` | `{}`. `answer` is one of: `{ behavior:'allow', always?: true }`, `{ behavior:'deny', message?: string }`, `{ behavior:'answers', answers: { [question]: string } }` for a question (every question answered; multi-select joins labels with ", ", matching what the desktop sends), or `{ behavior:'approvePlan' }` / `{ behavior:'deny', message? }` for a plan. Unknown or already-answered `promptId` → error `gone`. An answer that doesn't fit the prompt's kind → `bad-request`. |
| `chat.interrupt` | `{ tabId }` | `{}` |
| `chat.detail` | `{ tabId, itemId }` | `{ kind:'tool', input: string, result?: string }` (pretty JSON input + result text, each ≤ 200000 chars) or `{ kind:'text', markdown }` for a text, user, thinking or notice item (the full text). |

- Ops other than `chat.open` don't need the chat to be open on this phone. When the chat has no runtime yet, the desktop attaches one first, as `chat.open` does.
- Malformed `params` → `bad-request`.
- New error codes: `not-found` (unknown tab or item, a hidden project, or a tab that isn't claude-chat), `gone` (prompt already answered). A tab in a `hideFromMobile` project always answers `not-found`.

### 6.4 Events (desktop → phone)

- `{ t:'evt', e:'chat', tabId, seq, upserts: ChatViewItem[], removes: string[], prompts: ChatViewPrompt[], busy, turnStartedAt?, process, processError?, permissionMode?, model? }`
  - The phone applies `removes` first, then `upserts`. `upserts` replace items by `id`, or add them. New IDs are appended after the current last item in the order given.
  - `prompts` is always the **full** open-prompt list. The status fields are always the full current values (an absent optional field means it is now unset).
  - `seq` increases per (session, tab) and the first event after `chat.open` carries the open's `seq` + 1. A gap makes the phone call `chat.open` again. Events for a tab other than the open one are ignored.
  - The desktop computes diffs per subscription by comparing the last-sent mapped items (a content key per id) and throttles to **at most 4 events per second** per subscription, trailing, with prompts and busy/process changes flushed immediately.
  - When the transcript is replaced rather than extended (`/clear`, a reset), the desktop removes every item it sent and upserts the new window.
- Window: `chat.open` returns the **last 60 items**. Items before the window are only reachable through `chat.earlier`, which extends the window. Upserts to items older than the phone's window are not sent (the desktop tracks the oldest id sent per subscription).
- The inbox (§4.4) is unchanged. A chat tab's inbox status still comes from `TabActivityRegistry`.

### 6.7 Vectors

(§6.5 and §6.6 of the M2 plan, `docs/superpowers/plans/2026-09-28-mobile-m2-chat.md`, cover the desktop and iOS implementations; they add no wire rules.)


`protocol/vectors/fragments.json`: a message of 150000 bytes, its fragments as hex, and step-by-step receiver scenarios for the rules in §6.1. `protocol/vectors/chat-messages.json`: sample `chat.*` reqs, params and results, and `evt chat` messages, including unknown kinds and fields. Layouts are in `protocol/vectors/README.md`.

## 7. Push (M3)

A phone gets a notification when a Claude chat asks for a permission, asks a question or presents a plan, and when a turn it started from the phone finishes. Allow and Deny work straight from the notification. `protocol/ts/push.ts` implements the wire formats of this section.

Three parties are involved, and none of them reads the notification's content except the phone:
- The **gateway** is an HTTP API that only our hosted relay runs (`relay.devtool.awantech.sk`), because only our APNs key can push to our app. It turns an APNs device token into a sealed **push capability** (`cap`) and later turns `{cap, data}` into an APNs request.
- The **relay** (ours or self-hosted) accepts `push` from desktops over the socket and hands it to the gateway: in-process when it is the gateway, otherwise by one HTTPS call to its upstream gateway. No relay ever sees an APNs token.
- The **desktop** decides what is worth a push and encrypts it with a key only the phone has.

### 7.1 Registration (phone → gateway, HTTPS)

`POST <gateway>/v1/push/register`, JSON body:
```json
{ "pub": "<b64u phone ed25519 pub>", "token": "<APNs device token, lowercase hex>",
  "env": "production" | "sandbox", "ts": <unix seconds>, "sig": "<b64u>" }
```
- `sig = Ed25519.sign(utf8("devtool-push-register-v1\n" + token + "\n" + env + "\n" + ts))` with the phone's relay key, so the gateway knows which `deviceId(pub)` it is sealing for. `ts` must be within **300 s** of the gateway's clock. `token` is 32 to 100 bytes (64 to 200 hex chars).
- `200 {"cap":"<string>"}`. Errors are a JSON body `{"error":"<code>"}` with status 400 `bad-request`, 401 `auth` (bad signature or `ts` out of range), 429 `rate` (per IP, 30 per hour), 503 `unavailable` (this server is not a gateway).
- Every registration bumps the device's **generation**, so it invalidates every older `cap` of that device. A phone registers at launch whenever it has a token and push is on, and hands the new `cap` to every paired desktop (§7.4).
- The gateway's only state is `push_devices(device_id PRIMARY KEY, generation, updated_at)` in the relay database. The token itself lives only inside the `cap`.

`cap` = b64u( `0x01` ‖ nonce (12) ‖ AES-256-GCM(sealKey, utf8(JSON `{"d":deviceId,"g":generation,"t":token,"e":env}`), aad = utf8("devtool-pushcap-v1")) ), with a random nonce. `sealKey` is the gateway's secret (32 bytes). A `cap` is at most 1024 characters. To everyone but the gateway it is opaque.

### 7.2 Relay socket messages (extends §3)

- Desktop or server → relay: `{ "t":"push", "id":<int ≥ 0>, "cap":"<string, 1–1024 chars>", "data":"<b64u, 1–3072 chars>" }`. From a phone it is `forbidden`.
- Relay → desktop: `{ "t":"pushed", "id":<int>, "result":"ok"|"gone"|"rate"|"unavailable"|"bad-request"|"error" }`, one per `push`, in any order.
  - `gone`: the `cap` is stale (a newer registration, or APNs said the token is dead). The desktop forgets that phone's registration.
  - `rate`: the device is over its budget. `unavailable`: this relay has no gateway. `error`: the gateway or APNs failed; nothing is retried.
- A relay that is not the gateway forwards as `POST <upstream>/v1/push/send` with body `{"cap","data"}`, and the gateway answers `200 {"result":…}` with the same values. A transport failure or timeout (10 s) is `error`. The upstream defaults to `https://relay.devtool.awantech.sk`, and an empty setting turns push off (`unavailable`).
- A connection may have at most 64 pushes awaiting a result, and may push at most 50 times a second (burst 200). Further pushes are answered `rate` right away.
- Clients from before M3 never send `push`. A client that gets a server message type it doesn't know ignores it.

### 7.3 Delivery (gateway → APNs)

- The gateway opens the `cap`. A `cap` that doesn't open or parse is `bad-request`. A generation other than the device's current one is `gone`.
- Budget: **60 pushes per device per hour** (a token bucket with a burst of 20). Over it is `rate`.
- The APNs request goes over HTTP/2 to `api.push.apple.com` (or `api.sandbox.push.apple.com` for `env: "sandbox"`), with a provider JWT (ES256, refreshed every 50 minutes), `apns-push-type: alert`, `apns-priority: 10`, `apns-expiration` one hour ahead and `apns-topic` set to the app's bundle ID. The body is:
  ```json
  { "aps": { "alert": { "title": "DevTool", "body": "An agent needs you" }, "sound": "default", "mutable-content": 1 }, "d": "<data>" }
  ```
  The alert text is the fallback the phone shows if it can't decrypt `d`.
- APNs `410`, or `400` with reason `BadDeviceToken` or `DeviceTokenNotForTopic`, is `gone`, and the gateway bumps the device's generation so that `cap` stays dead. Any other failure is `error`.

### 7.4 Push registration on a desktop (extends §4.4 ops)

| op | params | result |
|---|---|---|
| `push.register` | `{ cap, key: b64u(32), keyId: b64u(8), kinds: string[] }` | `{}`. Replaces this phone's registration. `kinds` is a subset of `"permission"`, `"question"`, `"done"`. Unknown kinds are dropped. `"question"` also covers plan approvals. |
| `push.unregister` | `{}` | `{}`. Forgets it. |

- The phone generates `key` and `keyId` per desktop pairing and keeps them for as long as the pairing lasts. It sends `push.register` after every established session while push is on, and whenever its toggles or `cap` change. With push off it sends `push.unregister`.
- The desktop stores the registration with the pairing, and deletes it on revoke or on a `gone` result.

### 7.5 Push payload (`data`)

`data` = b64u( keyId (8) ‖ nonce (12) ‖ AES-256-GCM(key, utf8(JSON), aad = keyId) ), with a random nonce. `keyId` tells the phone which desktop's key to use. The plaintext is:
```json
{ "v": 1, "kind": "permission" | "question" | "plan" | "done",
  "desktop": "<desktopId>", "tab": "<tabId>", "prompt": "<promptId>",
  "title": "api-server / fix-auth", "body": "Bash · npm test", "at": <unix ms> }
```
- `prompt` is present for `permission`, `question` and `plan`. `title` is at most 120 characters and `body` at most 400. Longer values are cut and end in "…". The encoded `data` must fit in 3072 characters, and a sender shortens `body` further until it does.
- A phone shows an unknown `kind` as plain text with no actions. An unknown `v` or a payload that doesn't decrypt leaves the fallback alert alone.

### 7.6 When a desktop pushes

Only Claude chat tabs (`claude-chat`) in projects visible on mobile (§4.4) push, and only to phones with a registration whose `kinds` include the push's kind:
- **permission / question / plan:** a prompt appears in the chat's open prompts. One push per (phone, prompt ID). `body` is the permission's `summary` (§6.2, e.g. "Bash · npm test"), the first question's text, or "Plan ready for review".
- **done:** the chat goes from busy to idle, and the turn that just ended was started by a `chat.send` from this phone. One push per such turn. `body` is the first line of the last assistant text, or "Finished".
- A phone that has this tab open (`chat.open`) in a live session gets no push for it. It is already looking.
- Pushes go out only while the desktop's relay socket is up. Nothing is queued or retried.

### 7.7 Phone behaviour

- A Notification Service Extension decrypts `d` with the key named by `keyId`, and replaces the alert with `title` and `body`. It sets the category to `kind` and keeps `desktop`, `tab` and `prompt` in the notification's `userInfo`.
- The `permission` category has two actions, **Allow** and **Deny** (destructive), and both require the device to be unlocked. Either one wakes the app in the background, which connects to that desktop and sends `chat.answer` (`{behavior:"allow"}` or `{behavior:"deny"}`). `gone` counts as done. Tapping any notification opens that chat.
- Settings has one toggle per kind (`permission`, `question`, `done`) and a master switch.

## 8. The rest (M4)

### 8.1 Features in the handshake

The `features` array of both hellos (§4.3) names optional ops a side supports, so a newer phone can hide what an older desktop can't do. A desktop that implements §8.4 sends `"task.new"`, and one that implements §8.5 adds `"chat.settings"`. §8.7 adds `"task.close"`, §8.8 `"tab.close"`, §8.9 `"chat.image"`, §8.10 `"pin"`, §8.11 `"task.triage"`, §8.12 `"stream.new"`, §8.13 `"branches.list"`, §8.14 `"chat.commands"` and §8.15 `"task.land"`. (Version 1's `"task.workspace"`, §8.6, is gone, and so is `"chat.new"`, §8.2: a current desktop doesn't list it.) A phone shows "New task" only for a desktop that lists `task.new`, "New stream" only for one that lists `stream.new`, and the close actions only for one that lists the matching op. A desktop answers an op it doesn't know `unsupported` anyway. Unknown feature strings are ignored.

### 8.2 `chat.new` (retired)

| op | params | result |
|---|---|---|
| `chat.new` | `{ taskId }` | `{ tabId }` |

**Retired.** A task has exactly one agent, so a second chat is a new task (`task.new`, §8.4). A current desktop doesn't list `"chat.new"` and answers the op `unsupported`, like any op it doesn't know (§4.4). A current phone never sends it. Older desktops that list the feature answer it as follows:

- The desktop adds a new `claude-chat` tab (title `Claude`, a fresh tab ID and session ID) at the end of the task's first pane and saves it as a main-side projects commit, so every open window picks it up the same way as any other change. It needs no open window, and it doesn't select the task or switch any window's visible tab.
- The chat's process isn't started. The phone opens the tab with `chat.open` (§6.3), which starts it, and the tab appears in the next `inbox` event.
- Errors: unknown or archived `taskId`, or a task in a project hidden from mobile (§4.4) → `not-found`. Claude turned off in the desktop's settings → `unsupported`. Missing or malformed `taskId` → `bad-request`.

### 8.3 Phone behaviour (no wire rules)

- **New stream:** a "New stream" action on each project (for desktops that list `stream.new`), disabled while the desktop is offline. It asks for a name (prefilled with the next version after the project's last stream when that one is a version) and where the stream works: a new worktree, with a branch (defaulting to the name) and a base branch picked from `branches.list` (§8.13), or the project folder. When `branches.list` answers `unsupported` the project has no worktrees and only the project folder is offered.
- **New task:** a "New task" action on each project (for desktops that list `task.new`), disabled while the desktop is offline. It asks for the first prompt, a permission mode and, when the project has more than one stream, a stream (defaulting to the project's `lastStreamId`, else `main`), then opens the new chat as soon as the op answers.
- **Streams:** a project's task list is grouped by stream in `streams` order, each group headed by the stream's name (and `branch`). An Inbox row shows `Project · Stream` under the task's name.
- **Close task:** a swipe action on a task row and a button in the task's screen (for desktops that list `task.close`), confirmed first ("moves it to Done"; for a task with a `branch`, "lands its branch into <stream>, then moves it to Done"). A `blocker` (§8.7) becomes a second confirmation that names it, and its answer resends the op with the matching flag. A `landing` answer leaves the task open and shows its landing banner instead of leaving the screen. The phone doesn't browse or reopen archived tasks, and doesn't close streams.
- **Landing:** a task row with a `landing` shows a badge (`landing…`, `fixing…`, `conflict`, `blocked`), and the task's screen a banner with the desktop's line ("Conflicts with 0.5.0 in 2 files", "0.5.0 has local changes in 1 file", the first files, git's message), and for a desktop that lists `task.land` its buttons (§8.15): **Ask agent to fix**, **Abort** and **Retry** for a conflict, **Abort** and **Retry** while the agent fixes it or for a blocked stream, none while it runs. "I'll fix it" (a terminal in the worktree) is the desktop's. The Inbox puts a `conflict` or `blocked` task under Your turn, as the desktop does.
- **Close tab:** a swipe action on a tab row (for desktops that list `tab.close`), confirmed first for an agent that is working or waiting.
- **Tool images:** a tool row with `images` (from a desktop that lists `chat.image`) shows a strip of thumbnails under it, fetched with a small `maxSide`. Tapping one opens it full screen, fetched again at the screen's size, with zoom and the share sheet. Against a desktop without the feature the row only says how many images there are. Fetched images are cached in memory for the session, not on disk.
- **Pinned:** a "Pinned" section above the projects lists the desktop's `pinned` entries in order: a project as a row that opens its tasks, a stream as a row (`Project › Stream`) that opens its tasks, and a task as a task row. For a desktop that lists `pin`, a project's header menu, a stream group's header menu and a task row's swipe and context menu offer Pin or Unpin, disabled while the desktop is offline. Against a desktop without the feature the section is still shown, read-only.
- **Inbox:** an Inbox entry above the desktops, and the screen the app opens to, lists every task of every paired desktop in the desktop inbox's groups: **Needs you** (the task's `status` is `attention`, longest wait first), **Your turn**, **Working**, **Quiet**, then **Snoozed** and **Done for now** (settled tasks), both collapsed. A live agent wins over snooze and settle: a snoozed or settled task whose `status` is `attention` or `working` is shown under Needs you or Working, and returns to its group once the agent is quiet. A timed snooze ends on the phone's clock at `snoozedUntil`. Unread tasks are marked. For a desktop that lists `task.triage`, a task row offers Done for now (`settle`, or Back to Inbox for `unsettle`), Snooze with the desktop's presets (until it needs you, 1 hour, this evening at 18:00, tomorrow at 9:00, Monday at 9:00, in the phone's time zone), Unsnooze, and Mark read or unread, disabled while the desktop is offline. Opening an unread task, or a task's screen staying open while it turns unread, sends `read`. Against a desktop without the feature the groups are still shown, read-only.
- **Commands:** for a desktop that lists `chat.commands`, typing `/` and a word in a chat's composer shows the matching commands above it, ranked as the desktop does (names starting with the word first, then, from two characters on, names containing it, each by name). Tapping one puts `/name ` in the composer. Terminal-only commands are shown disabled. `/btw <question>` opens the answer in a sheet instead of sending, and `/permissions` opens a rules editor (§8.14), read-only while the desktop is offline. Sending a terminal-only command is refused on the phone.
- **Require Face ID for approvals:** an app setting, off by default. When it is on, every answer to a permission, question or plan in the app asks for device-owner authentication first (Face ID, with the passcode as fallback), and the notification's Allow and Deny open the app, authenticate and then answer instead of answering in the background.
- **Offline:** the phone keeps the last transcript of each chat it has opened (the view items it holds, at most the §6.4 window) next to the cached inbox, and shows it read-only under the offline banner when the desktop is offline. Returning to the foreground reconnects at once rather than waiting out the relay backoff. Nothing is queued, as before.

### 8.4 `task.new` (phone → desktop `req`)

| op | params | result |
|---|---|---|
| `task.new` | `{ projectId, streamId?, prompt, mode? }` | `{ taskId, tabId }` |

- `prompt` is the first message (≤ 32000 chars, not blank, as `chat.send`). `mode` is one of `default`, `acceptEdits`, `plan`, `auto`, `bypassPermissions`. Absent, Claude starts in its own default mode.
- The desktop adds a task at the end of stream `streamId`, or, when it is absent, of the stream the project was last used in (`lastStreamId`, §4.4), else `main`. The task is named after the prompt's first non-empty line (whitespace collapsed, at most 50 characters with a trailing `…`), with one `claude-chat` tab (title `Claude`, a fresh tab ID and session ID) as its main tab in its only pane. That stream becomes the project's `lastStreamId`. The desktop saves this as a main-side projects commit, like §8.2. It doesn't select the task or switch any window's visible tab. It starts the chat in the stream's folder (its worktree, else the project's).
- The desktop then attaches the chat's runtime (which starts the process), applies `mode`, and sends `prompt` as a `chat.send` from this phone would, so a `done` push (§7.6) follows the turn. It answers once the prompt is sent. The phone opens the chat with `chat.open`, and the task appears in the next `inbox` event.
- Errors: unknown `projectId`, a project hidden from mobile (§4.4), or an unknown or archived `streamId` → `not-found`. A shell-command project or Claude turned off in the desktop's settings → `unsupported`. Missing or malformed params → `bad-request`. Version 1's `workspace` flag is ignored like any unknown field: worktrees belong to streams, which only the desktop creates.

### 8.5 `chat.settings` (phone → desktop `req`)

| op | params | result |
|---|---|---|
| `chat.settings` | `{ tabId, mode?, model?, effort? }` | `{}` |

- Changes the chat's permission mode, model or effort, as the desktop composer's pickers do. An absent field stays as it is; at least one must be present. `mode` is one of the §8.4 modes. `model` is a `settings.models[].value` and `effort` one of `settings.efforts`; `""` for either goes back to Claude's settings default.
- The desktop applies them in that order (mode, model, effort), so an effort is checked against the model just picked. It answers `{}` once they are applied; the new values arrive in the next `evt chat`. The chat need not be open on this phone. A chat without a live process keeps the values for its next start, as the desktop does.
- A desktop that implements this op lists `"chat.settings"` in its features (§8.1) and sends `settings` and `usage` in the chat view (§6.2). The phone shows the pickers read-only for a desktop that sends `settings` without listing the feature.
- Errors: unknown tab, as §6.3 → `not-found`. No field, an unknown `mode`, `model` or `effort` → `bad-request`.

### 8.6 Workspaces with `task.new` (version 1 only)

Removed in version 2. A worktree belongs to a stream (§4.4 `branch`), made on the desktop's New stream; a phone picks the stream in `task.new` (§8.4) instead.

### 8.7 `task.close` (phone → desktop `req`)

| op | params | result |
|---|---|---|
| `task.close` | `{ taskId, stopWorking?, discardUnsaved? }` | `{ closed: true }` or `{ closed: false, blocker }` |

- Archives the task, as the desktop sidebar's and Inbox's Close task does: its tabs' processes stop and their hook injections go, their scrollback is kept, and the task moves to its stream's Done row (out of `projects.json`, into the project's archive) in a main-side commit. Windows showing it move off it. The stream stays, even emptied, and so does its worktree. Archiving the last open task of an ephemeral project removes the project. Flags are `true` or absent.
- Before archiving, the desktop checks in this order and answers `closed: false` with the first `blocker` that applies, changing nothing (the same questions the sidebar asks):
  - `working`: an agent tab of the task is working, unless `stopWorking`.
  - `unsaved`: an editor tab in the task has unsaved changes in a desktop window, unless `discardUnsaved`.
- A desktop sends only these two blockers; a phone treats any other as a malformed answer.
- **A task with a worktree of its own** (version 3, a task with a `branch`, §4.4) lands instead, as the desktop's Close task does: its changes are committed, squashed into one commit named after the task and rebased onto its stream's branch, the stream's worktree is fast-forwarded to it, then its tabs stop, its worktree and branch are removed and it is archived. With nothing to land it just closes. Either way the answer is `closed: true`. The blockers come first, as above; `stopWorking` stops the task's tabs before it lands, since landing never runs under a working agent.
  - A landing that stops leaves the task open with its `landing` (§4.4) and answers `{ closed: false, landing }`: the rebase stopped on a conflict (`conflict`, the files listed), or the stream's worktree has local changes in the files being landed (`blocked`). Sending `task.close` again tries again; a stopped rebase answers `conflict` again until it is resolved, aborted or fixed through `task.land` (§8.15). A task already being landed (a desktop window or another phone) answers `internal`.
  - A version 2 session (§4.3) knows no `landing`: it gets an `internal` error instead, whose `message` says what stopped it ("Conflicts with 0.5.0 in 2 files. Open the task on the desktop to resolve them."), and the task stays open the same way.
  - The phone has no Keep branch or Discard: those are the desktop's close dialog.
- The archived task leaves the next `inbox`. A phone can't browse or reopen archived tasks; the desktop's Done row can.
- Errors: unknown or archived `taskId`, or a task in a project hidden from mobile → `not-found`. Missing `taskId` → `bad-request`.

### 8.8 `tab.close` (phone → desktop `req`)

| op | params | result |
|---|---|---|
| `tab.close` | `{ tabId }` | `{}` |

- Closes one tab the phone sees in its inbox (§4.4), as its close button on the desktop does: its process stops and its scrollback and hook injection go. The task stays, even without tabs. A chat open on a phone stops sending events, as for a tab closed on the desktop: the tab leaves the next `inbox`, and further `chat.*` ops on it answer `not-found`.
- A task's main tab (its agent, or a terminal task's first terminal) closes only with its task (§8.7).
- Errors: unknown tab, a tab type the inbox doesn't carry, a task's main tab, or a project hidden from mobile → `not-found`. Missing `tabId` → `bad-request`.

### 8.9 `chat.image` (phone → desktop `req`)

| op | params | result |
|---|---|---|
| `chat.image` | `{ tabId, itemId, index, maxSide? }` | `{ mediaType, data }` |

- Returns image `index` (0-based, below the tool item's `images`, §6.2) of tool item `itemId`, as base64 `data` with no `data:` prefix. `mediaType` is one of `image/png`, `image/jpeg`, `image/gif`, `image/webp`.
- `maxSide` is the longest side the phone wants, in pixels, clamped to 64…4096, default 2048. The desktop scales the image down to fit it (never up) and keeps its type when it can. It sends the original bytes when they already fit. `data` is at most 3000000 characters, so the result fits one message (§6.1). An image that is still too big is re-encoded as JPEG, then scaled down further.
- The images are the ones the desktop shows under the tool row: images a tool result carried (a Read of a PNG, a browser screenshot), at most 4 per result. A user's attached images are not available.
- The chat need not be open on this phone. When the chat has no runtime yet, the desktop attaches one first, as for `chat.detail`.
- A desktop that implements this op lists `"chat.image"` in its features (§8.1) and sends `images` on tool items.
- Errors: unknown tab, as §6.3, an unknown item, an item that isn't a tool, or an `index` it doesn't have → `not-found`. Missing or malformed params → `bad-request`. An image the desktop can't decode and that doesn't fit as it is → `internal`.

### 8.10 `pin.set` (phone → desktop `req`)

| op | params | result |
|---|---|---|
| `pin.set` | `{ projectId, streamId?, taskId?, pinned }` | `{}` |

- Pins (`pinned: true`) or unpins (`false`) the project, its stream `streamId`, or its task `taskId`, in the desktop sidebar's Pinned list, as the sidebar's Pin and Unpin do. With `taskId` the pin is the task's (its `streamId`, if sent, is ignored: a task pin follows the task's current stream). A stream pin and the pins of its tasks are separate entries. A new pin goes to the end of the list. Pinning what is already pinned, or unpinning what isn't, changes nothing and still answers `{}`. The desktop saves the change as a main-side projects commit, and the new list arrives in the next `inbox` event.
- A desktop that implements this op lists `"pin"` in its features (§8.1).
- Errors: unknown `projectId`, a project hidden from mobile (§4.4), or an unknown or archived `streamId` or `taskId` → `not-found`. Missing `projectId`, a `pinned` that isn't a boolean, or a malformed `streamId` or `taskId` → `bad-request`.

### 8.11 `task.triage` (phone → desktop `req`)

| op | params | result |
|---|---|---|
| `task.triage` | `{ taskId, action, until?, untilAttention? }` | `{}` |

- Applies one of the desktop inbox's actions to the task, as its row actions and context menu do. `action` is one of:
  - `read`: marks the task visited, as switching to it on the desktop does, and clears a manual unread.
  - `unread`: marks it unread until the next visit.
  - `settle`: settles it ("done for now"). This also marks it read and ends a snooze. An event after the settle un-settles it.
  - `unsettle`: undoes a settle.
  - `snooze`: hides it until `until` (Unix ms), or, with `untilAttention: true`, until the task next needs the user. Either kind ends early when the task next needs the user. Exactly one of the two must be present. This also marks it read and replaces a settle.
  - `unsnooze`: ends a snooze.
- An action that wouldn't change what the inbox shows (`read` on a read task, `unsettle` on a task that isn't settled, and so on) changes nothing and still answers `{}`. Otherwise the desktop saves the change as a main-side projects commit and answers once it is made. The new state arrives in the next `inbox` event (§4.4).
- `until` and `untilAttention` are ignored on actions other than `snooze`.
- A desktop that implements this op lists `"task.triage"` in its features (§8.1) and sends the triage fields (§4.4).
- Errors: unknown or archived `taskId`, or a task in a project hidden from mobile → `not-found`. Missing `taskId`, an unknown `action`, or a `snooze` without exactly one of `until` (a non-negative integer) and `untilAttention: true` → `bad-request`.

### 8.12 `stream.new` (phone → desktop `req`)

| op | params | result |
|---|---|---|
| `stream.new` | `{ projectId, name, worktree, branch?, baseBranch? }` | `{ streamId }` |

- Makes a stream, as the desktop's New stream dialog does on Create. `name` is any non-blank text (trimmed). `worktree` is a boolean:
  - `true`: the desktop creates a git worktree on a new branch `branch` (trimmed; absent: the name made into a branch name, as the dialog prefills it), forked from `baseBranch` (absent: `defaultBase` from §8.13), the same way the dialog does, over SSH for a remote project. The stream's `branch` (§4.4) is that branch.
  - `false`: the stream works in the project folder, like `main`. `branch` and `baseBranch` are ignored.
- The stream goes at the end of the project's `streams`, empty, and is saved as a main-side projects commit; it appears in the next `inbox` event. It doesn't become the project's `lastStreamId`, and no window switches to it. The desktop answers once the stream is saved, which can take a while with a worktree (git, SSH).
- A desktop that implements this op lists `"stream.new"` in its features (§8.1).
- Errors: unknown `projectId` or a project hidden from mobile (§4.4) → `not-found`. `worktree: true` on a shell-command project, which has no folder to make a worktree in → `unsupported`. Missing `projectId`, a blank `name`, a missing or non-boolean `worktree`, or (with a worktree) a blank `branch` or `baseBranch`, or a `name` that leaves no branch name when `branch` is absent → `bad-request`. A repository with no branch to fork from, or git failing (an invalid or existing branch, an unknown base, not a git repository, SSH down) → `internal`, with git's reason as the `message`; nothing is saved then.

### 8.13 `branches.list` (phone → desktop `req`)

| op | params | result |
|---|---|---|
| `branches.list` | `{ projectId }` | `{ branches, defaultBase }` |

- The project's local branches, as the New stream dialog's From picker lists them (over SSH for a remote project), in git's order. `defaultBase` is the one the dialog picks first: `main`, else `master`, else the first branch, else `""` when there is none.
- A shell-command project has no worktrees, so the op answers `unsupported` for it, and the phone offers only the project folder (§8.3). This is the only way the phone learns it: the inbox carries no flag for it.
- A desktop that implements this op lists `"branches.list"` in its features (§8.1).
- Errors: unknown `projectId` or a project hidden from mobile → `not-found`. A shell-command project → `unsupported`. Missing `projectId` → `bad-request`. Not a git repository, or SSH down → `internal`, with the reason as the `message`.

### 8.14 `chat.commands`, `chat.btw`, `chat.permissions` (phone → desktop `req`)

| op | params | result |
|---|---|---|
| `chat.commands` | `{ tabId }` | `{ commands: [{ name, description?, argumentHint?, terminalOnly? }] }` |
| `chat.btw` | `{ tabId, question }` | `{ response: string \| null, synthetic? }` |
| `chat.permissions` | `{ tabId }` | `{ sources }` |
| `chat.permissions.update` | `{ tabId, kind, behavior, rule, action }` | `{ sources }` |

The desktop chat composer's `/` menu, for the phone's.

- `chat.commands` lists what the composer's menu lists, in its order: `btw` and `permissions` first when Claude doesn't report them itself (the CLI doesn't list either to SDK clients), then Claude Code's commands and skills as the CLI reported them, with their `description` and `argumentHint`. `name` has no leading `/`. `terminalOnly: true` marks a command that only works in Claude's terminal UI (the desktop's `TERMINAL_ONLY_COMMANDS`), except `permissions`, which the phone runs itself. The list can be empty before Claude has reported its commands; the phone asks again later. Flags are `true` or absent.
- `chat.btw` asks a side question, as `/btw <question>` in the composer does: Claude answers from the conversation, and neither the question nor the answer joins it. `question` is not blank and at most 20000 characters. `response` is `null` when Claude had nothing to say (the question was cancelled), and `synthetic: true` when the CLI made the answer up itself (an error or refusal) rather than the model. The desktop starts the chat's process when it isn't running, as a send does, and answers once the answer is in, which can take a minute or more.
- `chat.permissions` reads the allow, ask and deny rules from the settings files Claude reads in the chat's folder (the same one the desktop's `/permissions` dialog edits, a stream's worktree when it has one). `sources` is one entry per file, most specific first: `{ kind, path, exists, allow, ask, deny, error? }`, where `kind` is `localSettings` (`.claude/settings.local.json`, not committed), `projectSettings` (`.claude/settings.json`) or `userSettings` (`~/.claude/settings.json`), `path` the file's absolute path on the desktop, and `error` set when the file exists but couldn't be read (it isn't edited then). A phone skips a source of a kind it doesn't know.
- `chat.permissions.update` adds or removes (`action`: `add` | `remove`) one `rule` (not blank, at most 2000 characters, trimmed by the desktop) in list `behavior` (`allow` | `ask` | `deny`) of source `kind`, as the dialog does, and answers with the sources read again. Adding a rule that is there, or removing one that isn't, changes nothing. A running session picks up the change on its own.
- The chat need not be open on this phone. For `chat.commands` and `chat.btw`, when it has no runtime yet, the desktop attaches one first, as for `chat.detail`.
- A desktop that implements these ops lists `"chat.commands"` in its features (§8.1). A phone against a desktop without it treats `/` like any other text.
- Errors: unknown tab, as §6.3 → `not-found`. A remote (SSH) project, whose settings live on the remote host, or a project with no local folder → `unsupported` for `chat.permissions` and `chat.permissions.update`, with a message to show. Missing or malformed params, a blank or too-long `question` or `rule`, or an unknown `kind`, `behavior` or `action` → `bad-request`. Claude failing to answer, or a settings file that can't be read or written → `internal`, with the reason as the `message`.

### 8.15 `task.land` (phone → desktop `req`)

| op | params | result |
|---|---|---|
| `task.land` | `{ taskId, action }` | `{ status, closed?, landing? }` |

The landing banner's buttons for a task with a worktree of its own (§4.4 `branch`, `landing`), as the desktop's banner has them. `action` is one of:
- `fix-with-agent`: sends the task's agent (its main tab when that is an agent, else its first agent tab) a prompt to resolve the conflict and continue the rebase; the landing becomes `fixing`. When the agent's turn ends with the rebase finished, the landing goes on by itself, ending the way it was asked for (`intent`): a `close` archives the task. With the rebase still stopped it is a `conflict` again. A chat tab is started if it isn't running; a terminal agent must be running (`internal` otherwise, with a message to show). An agent mid-turn answers `working`, and a landing whose conflict was resolved meanwhile goes on at once.
- `abort`: undoes a stopped rebase and clears the landing (also a `blocked` one). The task stays open, its branch back on its old base.
- `retry`: picks a stopped landing up again. A conflict resolved on the desktop (all files staged, or the rebase continued) goes on; one still unresolved answers `conflict` again. A `blocked` one tries the fast-forward again. A `close` that lands archives the task.

The result's `status` is what came of it: `landed` (the stream took the task's commit), `updated` (an `update` finished its rebase), `nothing` (nothing was left to land), `aborted`, `fixing`, `conflict` or `blocked` (stopped again), or `working` (the task's agent is mid-turn; nothing happened). `closed: true` is present when a landing finished a close and the task went to Done. `landing` is the task's landing afterwards, present with `fixing`, `conflict` and `blocked`. A desktop sends only these statuses; a phone treats any other as a malformed answer. The task's new state also arrives in the next `inbox` event.

- A desktop that implements this op lists `"task.land"` in its features (§8.1), and sends `branch` and `landing` on tasks (§4.4).
- Errors: unknown or archived `taskId`, or a task in a project hidden from mobile → `not-found`. A task without a worktree of its own → `unsupported`. Missing `taskId` or an unknown `action` → `bad-request`. Nothing to retry or fix, the task already landing, an agent that can't be reached, or git failing → `internal`, with the reason as the `message`.

## 9. Version 2: streams

The desktop moved from Project › Task › Tab to **Project › Stream › Task**: a stream is a line of work (`main`, `0.5.0`, `bugfixes`) that owns the worktree, and a task is one agent session or one terminal task with its own tabs. The phone keeps the word "task"; its meaning moved down one level. Version 2 carries that model, with no translation for version 1 peers (§4.3 refuses them):

- §4.4: projects list their `streams` and `lastStreamId`; tasks carry `streamId`, `streamName` and one `status` (with `since` and `activity`); `branch` moved from the task to its stream; pins may name a stream; archived streams and tasks are never sent.
- §8.4: `task.new` takes an optional `streamId`, defaulting to the stream last used. §8.6 (`workspace`, `"task.workspace"`) is gone.
- §8.7: `task.close` archives, with the desktop's blockers (`working`, `unsaved`) instead of the worktree ones; a stream and its worktree outlive their tasks.
- §8.10: `pin.set` takes an optional `streamId`.
- The relay (§3), the pairing URI (§2, still `v: 1`), Noise (§4.2), chat (§6) and push (§7, payload `v: 1`) are unchanged. A push `title` names the stream when it isn't `main` (`project › stream / task`, §10).

## 10. Project tile (no wire format)

Both apps show a project the same way wherever one of its tasks or streams appears outside the project's own screen: a tile, then `project › stream`. Nothing here goes on the wire; the inbox already carries the project's `id`, `name` and `emoji` (§4.4). `protocol/ts/project-tile.ts` implements it, and `protocol/vectors/project-tile.json` checks both apps.

- **Tile content:** the project's `emoji` (trimmed) when it has one, else its initials. The initials are always derived, as a fallback.
- **Initials:** split the name into words: runs of Unicode letters and numbers (general categories L* and N*); anything else separates words, and a run also breaks where a lowercase letter (Ll) is followed by an uppercase one (Lu), so `devTool` is two words. Two or more words give the first code point of the first two; one word its first two code points; no word the first code point of the whitespace-trimmed name; an empty name `?`. The result is uppercased with full case mapping (`ß` becomes `SS`, so it can be longer than two characters).
- **Colour:** FNV-1a 32-bit (offset basis `0x811c9dc5`, prime `0x01000193`) over the UTF-8 bytes of the project `id`, modulo the palette length, indexes the palette in `project-tile.json` (8 swatches, each a light and a dark `bg`/`fg`). The palette's order is part of this spec. The desktop's dashboard `icon`, which the phone never sees, still wins over the tile on the desktop.
- **Place:** `project › stream` (U+203A between single spaces), or just `project` when the stream is `main` or unknown. Push titles (§7.5) use it before ` / task`.

## 11. Version 3: task worktrees

A new task in a worktree stream gets a worktree and branch of its own (`<stream branch>--<task slug>`), made when its first tab needs a folder, and closing it lands it back into the stream: one squashed commit, rebased onto the stream and fast-forwarded into it. Version 3 carries that, and only adds:

- §4.4: tasks carry `branch` and `landing`.
- §8.7: `task.close` lands a task with a worktree of its own, and answers `{ closed: false, landing }` when the landing stops.
- §8.15: `task.land` (feature `"task.land"`) offers the stopped landing's Ask agent to fix, Abort and Retry.

Both sides send `min: 2`, so a version 2 peer still connects and speaks version 2 (§4.3): an older phone ignores the new fields as unknown, and a stopped landing comes back to it as an `internal` error with a message to show (§8.7). A version 3 phone against a version 2 desktop sees no `branch`, `landing` or `"task.land"`, and closes as before.
