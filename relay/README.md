# DevTool relay

The relay connects DevTool desktops, DevTool servers and the iOS app across the internet. Each device keeps a WebSocket open to it, authenticates with its Ed25519 key, and the relay forwards opaque frames between paired devices. Traffic is end-to-end encrypted between the two ends (Noise IK between phone and desktop), so the relay can't read any of it.

It also carries push notifications (§7 of the spec): desktops and servers send `push` over the socket, and the relay hands it to the **push gateway**, which only our hosted relay runs because only our APNs key can reach our app. A self-hosted relay forwards pushes to the hosted gateway over HTTPS.

The normative protocol is §3 of [`../protocol/SPEC.md`](../protocol/SPEC.md), summarized in [`../protocol/PROTOCOL.md`](../protocol/PROTOCOL.md). The relay reuses the message parsers, auth check and limits in `../protocol/ts`.

- **No runtime dependencies.** The WebSocket server is a small RFC 6455 implementation in `src/ws/`, on top of `node:http`. Persistence is `node:sqlite`.
- **No build step.** Node ≥ 24 runs the TypeScript sources directly (type stripping). The code sticks to erasable syntax: no `enum`, no `namespace`, no parameter properties.

## Roles

| role | is | may |
|---|---|---|
| `phone` | the iOS app | pair with a desktop or server (hello `pair`), `watch` desktops and servers |
| `desktop` | DevTool | `offer`, `authorize`, `revoke`, `push`; pair with a server (`pair` message, code flow); `watch` servers |
| `server` | a headless DevTool host | everything a desktop may do toward phones; pair with a desktop (hello `pair`, token flow) |

Any two different roles may pair; two of a kind may not. The device that made the offer owns the pair and sends `authorize`, and either side may `revoke`. Of the two, the higher role in `phone < desktop < server` hosts the other: it gets the other's presence without asking, and the other `watch`es it. Frames flow between any authorized or pending pair, in either direction. SPEC.md §3.8 has the details.

A client that sends `binary: true` in hello gets frames as binary WebSocket messages, `[16 raw bytes of the peer's device ID][envelope]`, and its `ready` says `binary: true`. Any client may send frames that way. The relay converts between binary and JSON for receivers that didn't ask (phones, older desktops). See SPEC.md §3.9.

## Limits

| | phones (and any socket before hello) | desktops and servers |
|---|---|---|
| Message size | 256 KiB (close 1009) | 256 KiB (close 1009) |
| Messages | 50/s, burst 200; `error rate`, then 4429 on a repeat within 10 s | 1000/s, burst 4000 |
| Payload bytes | no separate budget | 8 MiB/s, burst 32 MiB |
| Over budget | refused | throttled: the relay stops reading the socket until the budget refills |
| Send queue | 8 MiB, then dropped | 32 MiB, then dropped |
| Pushes | not allowed | 50/s, burst 200, then `pushed rate` |
| Pending pairs per device | 16 | 16 |
| Pairs per device | 256 | 256 |

Per IP, whatever the role:

| limit | default | env |
|---|---|---|
| New connections | 20/min; request headers (the upgrade's too) within 10 s | |
| Open connections | 64 | `RELAY_MAX_CONNECTIONS_PER_IP` |
| Payload bytes, all connections together | 16 MiB/s, burst 64 MiB, throttled | `RELAY_IP_BYTES_PER_SECOND`, `RELAY_IP_BYTES_BURST` |
| New pairs | 60/hour, then `rate` on `authorize` | `RELAY_NEW_PAIRS_PER_IP_PER_HOUR` |

Backpressure: once a receiver's send queue passes 4 MiB, the relay stops reading each socket that sends it another frame, and reads them again when the queue is back at 1 MiB. A paused sender is paused for all its peers (head-of-line blocking, accepted for now), and its pongs come late. A connection whose queue went over 4 MiB has 15 s (`RELAY_STALL_TIMEOUT_MS`) to drain it to 1 MiB, or the relay drops it, so a receiver that pings but never reads can't pin memory or its senders. All send queues together may hold 512 MiB (`RELAY_MAX_QUEUED_BYTES`); past that the relay drops the largest first. Dropped receivers get no close frame (it would wait behind what they aren't reading). The relay doesn't idle-time-out a socket it isn't reading, which the stall timeout keeps bounded.

The numbers are constants in `protocol/ts/relay-messages.ts` (`RELAY_HOST_*`, `RELAY_IP_*`, `RELAY_BUFFER_*`, `RELAY_STALL_TIMEOUT_MS`, `RELAY_MAX_*`), and tests override them through `limits`.

Known limit: roles are claimed, not proven. Any key can say `desktop` or `server` and get the host budgets. It can only reach devices it is paired with, so the worst it can do is push its own data through the relay, within the connection, IP and pair limits above. Lower `RELAY_HOST_BYTES_PER_SECOND` and `RELAY_IP_BYTES_PER_SECOND` if that is too much for your machine. Many IPs together can still use more; the relay has no account system to tell them apart.

## Layout

| path | what |
|---|---|
| `src/main.ts` | Entry point: reads the environment, opens the database, starts the server, shuts down on SIGTERM/SIGINT |
| `src/server.ts` | `startRelayServer()`: `node:http` + `/healthz` + the `/v1` upgrade + per-IP admission + the push HTTP API |
| `src/relay.ts` | `createRelay({ store, clock, limits, logger })`: the protocol core, independent of sockets |
| `src/store.ts` | `RelayStore` and `PushStore`, with `SqliteStore` (production) and `MemoryStore` (tests) |
| `src/push/gateway.ts` | `createPushGateway()`: registration, cap sealing, per-device budget, APNs result mapping. Also the in-process and upstream `PushForwarder`s |
| `src/push/apns.ts` | `ApnsSender`: the HTTP/2 APNs client with its ES256 provider token, the `simctl` sender and the `log` sender |
| `src/rate.ts` | Token bucket (per connection) and sliding-window IP limiter |
| `src/ws/` | RFC 6455 server side: opening handshake, frame parser/encoder, fragmentation, ping/pong, close handshake, payload cap |
| `src/log.ts`, `src/config.ts` | JSON logs, environment parsing |
| `test/` | vitest suites over real sockets on ephemeral ports |
| `Dockerfile`, `docker-compose.yml`, `deploy/Caddyfile.example` | Container and deployment |

## Run locally

```bash
cd relay
npm start                      # ws://localhost:8787/v1, database in ./data/relay.db
npm run dev                    # same, restarts on file changes, LOG_LEVEL=debug
curl localhost:8787/healthz    # → ok
```

Then point a desktop at it: DevTool Settings → Mobile → relay URL `ws://localhost:8787`, or the stand-in desktop from the repo root:

```bash
node protocol/tools/fake-desktop.ts ws://localhost:8787
```

## Environment

| variable | default | meaning |
|---|---|---|
| `PORT` | `8787` | Listen port |
| `HOST` | `0.0.0.0` | Listen address. Use `127.0.0.1` behind a reverse proxy on the same host |
| `RELAY_DATA` | `./data` | Directory for `relay.db` (created if missing) |
| `RELAY_TRUST_PROXY` | unset | `1` makes the per-IP limit use the **last** `X-Forwarded-For` entry, which is what your own proxy appended. Only set it behind a proxy you control, or clients can pick their own IP |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn` or `error` |
| `RELAY_PUSH_UPSTREAM` | `https://relay.devtool.awantech.sk` | Gateway that a non-gateway relay forwards `push` to. Set it to an empty string to turn push off (desktops get `unavailable`). A gateway ignores it |
| `RELAY_PUSH_SEAL_KEY` | unset | Setting it makes this relay the push gateway. 32 random bytes, base64url without padding. Every cap is sealed with it, so changing it invalidates every phone's registration until the phone registers again |
| `RELAY_APNS_MODE` | `apns` if `RELAY_APNS_KEY_FILE` is set | Gateway only. `apns` talks to Apple, `simctl` pushes to a local iOS simulator with `xcrun simctl push`, `log` accepts every push and only logs it |
| `RELAY_APNS_KEY_FILE` | unset | `apns` mode: path to the `.p8` auth key from Apple |
| `RELAY_APNS_KEY_ID` | unset | `apns` mode: the key's 10-character ID |
| `RELAY_APNS_TEAM_ID` | unset | `apns` mode: the 10-character team ID |
| `RELAY_APNS_TOPIC` | `sk.awantech.devtool` | `apns` and `simctl` modes: the app's bundle ID |
| `RELAY_SIMCTL_DEVICE` | `booted` | `simctl` mode: the simulator's UDID |
| `RELAY_HOST_BYTES_PER_SECOND` | `8M` | Payload bytes per second for each desktop or server connection. Sizes take a `K`, `M` or `G` suffix (×1024) |
| `RELAY_HOST_BYTES_BURST` | `32M` | Burst for the above |
| `RELAY_IP_BYTES_PER_SECOND` | `16M` | Payload bytes per second for all connections from one IP together |
| `RELAY_IP_BYTES_BURST` | `64M` | Burst for the above |
| `RELAY_MAX_CONNECTIONS_PER_IP` | `64` | Open connections per IP. Behind a proxy without `RELAY_TRUST_PROXY`, every client shares the proxy's IP |
| `RELAY_NEW_PAIRS_PER_IP_PER_HOUR` | `60` | New pairs the devices on one IP may authorize per hour |
| `RELAY_MAX_QUEUED_BYTES` | `512M` | All send queues together; past it the largest are dropped |
| `RELAY_STALL_TIMEOUT_MS` | `15000` | How long a receiver may take to drain its queue from 4 MiB to 1 MiB |

Logs are one JSON object per line on stdout (`ts`, `level`, `event`, plus fields such as `id`, `role`, `ip`, `code`). Frame data, tokens and signatures are never logged, and neither are APNs tokens, caps, push payloads or keys. Events a client can repeat as fast as its budget allows (refused pairing attempts, pending pairs, refused connections) log at `debug` only, so they can't fill the disk at `info`. A connection dropped for not reading logs `dropped` with `reason` `stalled` or `queue-ceiling`. Startup logs which push role is active (`push-gateway` with its mode, `push-forward` with the upstream, or `push-off`), and a bad push setting stops the relay with a message on stderr.

## Push gateway

The gateway serves `POST /v1/push/register` (phone → gateway: a signed APNs token in, a sealed `cap` out) and `POST /v1/push/send` (`{cap, data}` from another relay → `{result}`), and handles `push` from its own desktops in-process. Its only state is the `push_devices` table in `relay.db`: a generation counter per device, which every registration bumps. The APNs token lives only inside the cap. On a relay that isn't a gateway both paths answer 503.

For a gateway that talks to Apple:

```bash
RELAY_PUSH_SEAL_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))") \
RELAY_APNS_KEY_FILE=/secrets/AuthKey_ABCDEF1234.p8 RELAY_APNS_KEY_ID=ABCDEF1234 RELAY_APNS_TEAM_ID=TEAM123456 \
npm start
```

Keep the seal key stable across restarts (store it with the other secrets), or every cap dies with it. The HTTP/2 client keeps one session per APNs host and reconnects after it closes. Each request times out after 10 s.

To try push against a local iOS simulator, run a gateway in `simctl` mode and point the app's gateway and the desktop's relay at it. The simulator can't receive real APNs pushes, so `xcrun simctl push` stands in for Apple, with the same JSON body. The token and `env` in the cap are ignored.

```bash
PORT=8791 HOST=127.0.0.1 RELAY_DATA=/tmp/devtool-gw \
RELAY_PUSH_SEAL_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))") \
RELAY_APNS_MODE=simctl RELAY_SIMCTL_DEVICE=booted \
node --disable-warning=ExperimentalWarning relay/src/main.ts
```


## Test and typecheck

```bash
cd relay
npm install          # on a machine with registry access
npm test             # vitest run
npm run typecheck    # tsc --noEmit (includes ../protocol/ts)
```

In this monorepo you can skip `npm install`. The dev dependencies (vitest, typescript, @types/node) are the same ones the root package installs, and both `vitest` and `tsc` resolve from `../node_modules`. `npm test` and `npm run typecheck` find them because npm puts every ancestor `node_modules/.bin` on `PATH`. You can also call them directly: `../node_modules/.bin/vitest run` and `../node_modules/.bin/tsc -p tsconfig.json`.

The suites:

- `test/relay.test.ts` covers HTTP routing, auth (success, bad signature, wrong role, non-hello, 10 s timeout), offers (one use, expired, replaced, wrong token), pending phones (routing both ways, reconnect, lapse), authorize (persisted, and still there after a restart on the same SQLite file), revoke, `forbidden` and `offline` routing errors, presence and `lastSeen`, watch filtering, max frame size, the phone rate limit, per-IP limits with and without `X-Forwarded-For`, replacing a duplicate connection, idle timeout and shutdown.
- `test/server-role.test.ts` covers the `server` role and the hardening limits (a receiver that pings but never reads, the relay-wide queue ceiling, open connections per IP, the shared IP byte budget, push rate, pending, pair and new-pair caps, free repeated `authorize`, watch cost, the `lastSeen` cap, refusals kept out of the info log). It also covers: `ready` with and without `binary`, `unsupported` for unknown roles and messages, desktop↔server pairing by token and by code, a lapsed pending desktop, authorize and revoke from either side, the routing matrix over every role combination, phone↔server, binary frames and JSON↔binary conversion, per-role budgets, backpressure against a receiver that stops reading (sender paused, relay queue bounded, everything delivered in order once it reads again), the hard cap, and a relay started on a database from before servers.
- `test/integration.test.ts` runs `protocol/tools/fake-desktop-core.ts` and a phone built from `protocol/ts` through the relay: a real Noise IK pair handshake, accept, `authorize`, the inbox, a resume handshake after reconnecting, a stale QR code refused, and revoke.
- `test/ws.test.ts` covers the WebSocket layer: Node's own `WebSocket` client end to end, fragmentation, ping during a fragmented message, and the payload cap enforced from the frame header alone. It also checks unmasked frames, invalid UTF-8, stray continuations, the close handshake both ways, and bad upgrade requests.
- `test/store.test.ts` covers both stores (pairs and push generations), the migration of a `relay.db` from before servers, the token bucket (refusing and spending into debt), the IP limiter and config parsing.
- `test/push.test.ts` covers the gateway (registration, skew, bad signatures, the per-IP limit, generations, every `send` result and the APNs response mapping), the HTTP/2 APNs client against a local cleartext fake (headers, body, the ES256 token and its 50-minute refresh, reconnects, timeouts), the `simctl` and `log` senders, `push` over the socket (forbidden for phones, `unavailable`, in-process, relay A forwarding to gateway B, upstream failures, the in-flight cap), the push HTTP endpoints, and push config.

## Docker

The image copies `relay/` and `protocol/ts`, so the build context is the **repo root**:

```bash
docker build -f relay/Dockerfile -t devtool-relay .
docker run --rm -p 8787:8787 -v devtool-relay-data:/data devtool-relay
```

Prebuilt images for `linux/amd64` and `linux/arm64` are published to `ghcr.io/join3r/devtool-relay` by `.github/workflows/mobile.yml` on every push to master that touches the relay or protocol (`latest` and `sha-<commit>` tags). Pull requests build the image without pushing it.

Or, for local development, `docker compose -f relay/docker-compose.yml up --build`. That serves port 8787 with a named volume `relay-data`.

The image is `node:24-alpine` running as the unprivileged `node` user. It declares `VOLUME /data` with `RELAY_DATA=/data`, has a `HEALTHCHECK` on `/healthz`, and runs no `npm install`, because there is nothing to install. The root `.dockerignore` keeps the rest of the repo out of the build context.

## Deploy on a small VPS with Caddy

1. Install Docker and Caddy, and point a DNS `A`/`AAAA` record (for example `relay.devtool.awantech.sk`) at the machine. Open ports 80 and 443.
2. Build or pull the image, then run it on loopback only, trusting Caddy's `X-Forwarded-For`:
   ```bash
   docker run -d --name devtool-relay --restart unless-stopped \
     -p 127.0.0.1:8787:8787 -e RELAY_TRUST_PROXY=1 \
     -v devtool-relay-data:/data devtool-relay
   ```
3. Copy `deploy/Caddyfile.example` to `/etc/caddy/Caddyfile` (change the host name if needed) and `systemctl reload caddy`. Caddy obtains the TLS certificate itself and proxies the WebSocket upgrade.
4. Check it: `curl https://relay.devtool.awantech.sk/healthz` → `ok`. Desktops and phones use `wss://relay.devtool.awantech.sk`.

For the hosted gateway, add the push settings to step 2 and mount the key read-only, for example `-e RELAY_PUSH_SEAL_KEY=... -e RELAY_APNS_KEY_FILE=/secrets/AuthKey.p8 -e RELAY_APNS_KEY_ID=... -e RELAY_APNS_TEAM_ID=... -v /etc/devtool/AuthKey.p8:/secrets/AuthKey.p8:ro`. The `node` user in the container must be able to read the file. A self-hosted relay needs nothing: it forwards pushes to `https://relay.devtool.awantech.sk` by default.

The relay sends 1001 to every socket on `SIGTERM` (`docker stop`), and clients reconnect with backoff. Back up the `/data` volume if you want pairings to survive losing the machine. If it's lost, users pair their phones again.

The first start of a relay with servers migrates `relay.db` from the old `pairs(desktop_id, phone_id, …)` table to `pairs(owner_id, owner_role, owner_pub, peer_id, kind, peer_pub, created_at)`, in one transaction, keeping every pair. Older relay images can't read the migrated file, so copy `relay.db` first if you may roll back.

## What the relay can and can't see

**Sees:** device IDs, roles and Ed25519 public keys, which devices are paired with which (and when), client IPs, connection and disconnection times, and the size and timing of every frame. During pairing it holds `SHA-256(relayToken)` in memory. Only the pairs table is written to disk.

**Can't see:** anything inside a frame's data. That covers project, task and tab names, statuses, prompts and code, which are all encrypted end to end between the two devices. It also never gets the pairing secret or the `pairProof`, so it can't forge a pairing. Even a malicious relay that let a stranger's phone through would fail the desktop's proof check inside the handshake. A relay can drop, delay or refuse to route frames, but it can't read or alter them undetected.

## Behaviour beyond the wire spec

These are decisions the original rules left open. They are recorded in SPEC.md §3.7:

- A device whose `pair` token doesn't match a live offer still gets `ready`, followed by `error forbidden` with `to` set to the host. It isn't pending. The same goes for two roles that may not pair, and that offer stays live.
- Pending status belongs to the (owner, peer) pair until the offer's `exp` (clamped to 15 min). It survives a reconnect without the token. When it lapses, the peer gets `error forbidden "pairing window expired"` and the host of the two gets `peer offline`. A phone is then closed with **4403**, unless it's authorized or pending with another host. Desktops and servers stay connected.
- A host's offer is dropped when it disconnects or is replaced.
- `authorize` checks that `pub` hashes to `peer` (or `phone`) (`bad-request`) and equals the key that device authenticated with (`forbidden`). Only the owner may send it. It has no success reply. `revoke` works from either side, is idempotent and also cancels a pending pair.
- `watch` replaces the previous set, carries at most 256 IDs, and reports `offline` with `lastSeen` when known.
- On `ready` a host gets `peer` for each device it hosts (authorized or pending) that is online, or offline with a known `lastSeen`.
- A replaced connection (4409) doesn't announce `offline`. The new one announces `online`.
- Idle timeout and shutdown close with **1001**. Every message, including `hello` and `ping`, costs a rate token. The first message over the limit is dropped with `error rate`, and another within 10 s closes with 4429. Refused connection attempts count toward the per-IP limit, which answers HTTP 429 at the upgrade.
- `forbidden` is checked before `offline`, so unpaired devices can't probe presence. Malformed JSON after auth gets `bad-request`, an unknown message type gets `unsupported`, and the socket stays open. Role violations (a phone sending `offer`, a server sending `watch`) get `forbidden`.
- Relays from before servers answer role `server` with `auth` and 4401, ignore `binary` (their `ready` has no `binary`), and answer `pair` with `bad-request`. Clients use that to say "This relay is too old for servers" (SPEC.md §3.11).
