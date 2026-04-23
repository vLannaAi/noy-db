# @noy-db/p2p

WebRTC peer-to-peer transport for [noy-db](https://github.com/vLannaAi/noy-db) — no server in the middle.

## Install

```sh
pnpm add @noy-db/p2p @noy-db/hub
```

## Why

Classic cloud sync routes every envelope through a central store. `@noy-db/p2p` lets two browsers (or two Node processes) shake hands over any signaling channel you pick and then sync directly over a WebRTC DataChannel. Any TURN relay in the path only ever sees noy-db's AES-256-GCM ciphertext — the transport is independent of the encryption.

## Use as a SyncTarget

```ts
import { createNoydb } from '@noy-db/hub'
import { to } from '@noy-db/to-browser-idb'
import { peerStore, createOffer, acceptOffer } from '@noy-db/p2p'

// Peer A — initiator
const initiator = await createOffer()
shareWithPeerB(initiator.offer)             // QR code, Matrix, pastebin, …
await initiator.accept(await receiveAnswer())
const channel = await initiator.channel

const db = await createNoydb({
  store: to(),
  sync: { store: peerStore({ channel }), role: 'sync-peer' },
})
```

Peer B mirrors the handshake with `acceptOffer` and runs `servePeerStore({ channel, store })` so its local store answers the incoming RPC calls.

## Read-only peers

```ts
servePeerStore({
  channel,
  store: local,
  allow: new Set(['get', 'list', 'loadAll', 'listPage', 'ping']),
})
```

Denied methods surface as a remote `Error` at the client.

## Transport abstraction

`PeerChannel` is the only primitive — any reliable in-order string channel works:

| Transport | Factory |
|---|---|
| WebRTC DataChannel | `fromDataChannel(dc)` |
| In-memory pair (tests) | `pairInMemory()` |
| BroadcastChannel, MessagePort, WebSocket | trivial custom wrapper |

## Status

`v0.20.0-alpha.0` — prototype. LAN-first. Multi-peer mesh is a follow-up.
