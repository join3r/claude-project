# DevTool mobile protocol

This is a short map of the protocol. The normative wire spec is [SPEC.md](SPEC.md), §1–§9. If this file and SPEC.md disagree, SPEC.md wins. Fix whichever one is wrong in the same change.

## Layers

1. **Identities (§1).** Each device has an X25519 key (for Noise) and an Ed25519 key (for relay auth). Keys are raw 32 bytes. The device ID is the hex of the first 16 bytes of SHA-256(ed25519 pub). Binary values in JSON are base64url without padding.
2. **Pairing (§2).** The desktop shows `devtool://pair?d=<b64u JSON>`. The JSON holds its keys, the relay URL, and a single-use 32-byte secret `s` that expires after 5 minutes. HKDF(s) gives two values. `relayToken` goes to the relay, which only ever holds SHA-256(relayToken). `pairProof` travels only inside the Noise handshake.
3. **Relay (§3).** A WebSocket at `<relay>/v1` that carries JSON text frames. Each client answers an Ed25519 challenge as a `phone`, `desktop` or `server`, and then the relay routes opaque `frame.data` between authorized (or pending) pairs. Nothing is queued. A server is a headless DevTool host. Phones pair with it as with a desktop, and desktops pair with it by token (the desktop offers) or by code (the server offers, the desktop sends `pair`). Whoever made the offer sends `authorize`, and either side may `revoke` (§3.8). A client that sends `binary: true` in hello gets frames as binary messages, `[16-byte peer ID][envelope]`, and anyone may send them that way (§3.9). Desktops and servers get 1000 msg/s and 8 MiB/s and are throttled, not refused. The relay pauses a sender while its receiver's queue is over 4 MiB, and drops a receiver that doesn't drain to 1 MiB within 15 s (§3.10). Per IP there are caps on open connections, shared bytes and new pairs (§3.5).
4. **Channel (§4).** `frame.data` is `[kind] || body`, where the kind is 1 (Noise message 1), 2 (Noise message 2), 3 (transport) or 4 (reset). The protocol is `Noise_IK_25519_AESGCM_SHA256` with prologue `devtool-mobile-v1`, and the phone is the initiator. The cipher is AES-256-GCM, not ChaChaPoly, because Electron's BoringSSL-based Node `crypto` has no chacha20-poly1305. AESGCM nonces use a big-endian counter. The handshake payloads carry versions and the pair/resume decision. Transport messages carry JSON app messages (`req`/`res`/`evt`), M1 has `inbox.get`, the `inbox` event and the `pairing` event.
5. **Chat (§6, M2).** Transport plaintext over 60000 bytes is split into fragments (`0x01 id i n chunk`, reassembled up to 4 MiB). The phone opens one Claude chat tab at a time (`chat.open`) and gets a windowed `ChatView`, then `evt chat` diffs (upserts, removes, the full prompt list), throttled to 4/s. `chat.send`, `chat.answer`, `chat.interrupt`, `chat.earlier` and `chat.detail` act on it.
6. **Version 2: streams (§9).** The inbox carries the desktop's Project › Stream › Task model: projects list `streams`, tasks name their stream and carry one `status`, pins may be streams, `task.new` takes a `streamId`, and `task.close` archives. Version 1 peers get `incompatible`.
7. **Version 3: task worktrees (§11).** A task with a worktree of its own carries its `branch` and its `landing` (running, `conflict`, `blocked`, `fixing`). `task.close` lands such a task into its stream and answers `{ closed: false, landing }` when the landing stops; `task.land` (`fix-with-agent`, `abort`, `retry`) answers the banner's buttons. Version 2 peers still connect (`min: 2`) and get a stopped landing as an `internal` error.

## Files

| path | what |
|---|---|
| `SPEC.md` | The normative wire spec (§1–§9) |
| `ts/` | Dependency-free TypeScript (`node:crypto` and `node:buffer` only). Import everything from `ts/index.ts`. |
| `ts/noise.ts` | Noise IK: `CipherState`, `SymmetricState`, `HandshakeState`, `createInitiator`/`createResponder`, and `NoiseTransport` after `split()` |
| `ts/keys.ts`, `ts/derive.ts`, `ts/encoding.ts` | Keys from raw bytes, X25519/Ed25519, device IDs, HKDF derivations, b64u/hex |
| `ts/relay-messages.ts` | Relay message types, `parseClientMessage`/`parseServerMessage`/`parseRelayMessage`, `relayAuthPayload`, `buildHello`/`verifyHello`, `pairTarget`, `encodeRelayBinaryFrame`/`decodeRelayBinaryFrame`, per-role budgets and flow-control limits, close codes |
| `ts/envelope.ts` | Frame kinds and `encodeEnvelope`/`decodeEnvelope` |
| `ts/app-messages.ts` | Handshake payloads, app messages, `Inbox`, tolerant parsers, `negotiateVersion` |
| `ts/pairing-uri.ts` | Pairing URI encode/decode/validate, `isPairingExpired` |
| `ts/fragments.ts` | §6.1: `fragmentMessage`, `Reassembler`, and `FramedTransport` (a `NoiseTransport` with fragmentation; every app message goes through its `seal`/`open`) |
| `ts/chat-messages.ts` | §6.2–§6.4: `ChatView`, items, prompts, `ChatOp`, `ChatLimits`, `parseChatParams`/`parseChatResult`/`parseChatViewEvent`, `capText` |
| `schema/` | JSON Schema (draft 2020-12) for handshake payloads, app messages, `Inbox` and the chat view (`chat.schema.json`). It describes what a sender must produce, and `ts/schema.test.ts` checks it against the samples. |
| `vectors/` | Test vectors shared with Swift. The layout is in [vectors/README.md](vectors/README.md). |
| `tools/fake-desktop.ts` | A stand-in desktop for iOS work without Electron (see below) |

All parsers throw `ProtocolError` on malformed input and drop unknown fields. `parseClientMessage` throws its subclass `UnsupportedMessageError` for an unknown `t` or hello role, which the relay answers with `unsupported`. The app-message parser returns `null` for an unknown `t` or `e`. `parseServerMessage` returns `null` for a `peer` with an unknown `state` and keeps an unknown error `code` as a string (SPEC.md §3.4, forward compatibility).

## Import convention

Relative imports inside `protocol/` use **explicit `.ts` extensions** (`import { b64uEncode } from './encoding.ts'`). Type-only imports use `import type`. This is what lets the same files run in three places:

- **Plain Node** (type stripping, the default on Node ≥ 23.6). This covers `relay/`, `tools/fake-desktop.ts` and `ts/generate-vectors.ts`. Node won't guess extensions, and it can't tell a type-only import unless it is marked `import type`. `protocol/package.json` sets `"type": "module"` so Node treats these files as ESM.
- **electron-vite / Vite / vitest.** These resolve `./x.ts` literally.
- **tsc.** `tsconfig.typecheck.json` sets `allowImportingTsExtensions` (allowed because it never emits). A tsconfig that does emit should use `rewriteRelativeImportExtensions` instead.

Consumers import the barrel by relative path, `../protocol/ts/index.ts` from `relay/src`, or `../../../protocol/ts/index.ts` from `src/main/mobile`.

Keep `protocol/ts` within what type stripping supports: no `enum`, no `namespace`, no constructor parameter properties, and no decorators. Use `as const` objects instead of enums (see `FrameKind`, `RelayCloseCode`).

## Commands

```bash
npx vitest run protocol                 # tests, including official Noise vectors and a vector-drift check
node protocol/ts/generate-vectors.ts    # rewrite protocol/vectors/*.json (then commit them)
node protocol/tools/fake-desktop.ts [ws://localhost:8787] [--manual] [--name NAME] [--state DIR]
```

`fake-desktop` keeps `identity.json` and `pairings.json` in `~/.devtool-fake-desktop` (or `--state`). It connects to `<relay>/v1`, authenticates, sends an offer and prints the pairing link. It also draws a QR code in the terminal if `qrencode` is installed. After that it acts as the Noise responder: it accepts pairings automatically (`--manual` asks y/n), sends `authorize`, answers `inbox.get` with a canned inbox, and sends an `inbox` event every 5 s in which the first tab's status rotates. Its `Claude` tab (`tab-chat`) is a canned chat (§6): open it and send anything, and it streams a reply, then asks for a Bash permission, a question and a plan approval in turn; each answer shows up in the transcript. Send `reset` to start the script over, or `long` for a >60 KB reply that exercises fragmentation. It lists `task.close` and `task.land` for its task with a worktree of its own (*login-redirect* in `0.5.0`): closing it stops on a conflict, Abort clears that, Retry finds it still there, and `fix-with-agent` has the "agent" land it 3 s later, which closes it. It sends a new offer when the old one is used or expires. It needs Node ≥ 23.6 (or `npx tsx protocol/tools/fake-desktop.ts`), which provides the global `WebSocket` and type stripping.
