# @noy-db/by-peer

WebRTC peer-to-peer transport for [noy-db](https://github.com/vLannaAi/noy-db) — no server in the middle.

> First member of the `by-*` family of session-share transports. See [`docs/packages/by-transports.md`](../../docs/packages/by-transports.md) for the family contract and roster.
>
> Previously published as `@noy-db/p2p` — same code, renamed to fit the prefix family.

## Install

```sh
pnpm add @noy-db/by-peer @noy-db/hub
```

## Why

Classic cloud sync routes every envelope through a central store. `@noy-db/by-peer` lets two browsers (or two Node processes) shake hands over any signaling channel you pick and then sync directly over a WebRTC DataChannel. Any TURN relay in the path only ever sees noy-db's AES-256-GCM ciphertext — the transport is independent of the encryption.

## Use as a SyncTarget

```ts
import { createNoydb } from '@noy-db/hub'
import { to } from '@noy-db/to-browser-idb'
import { peerStore, createOffer, acceptOffer } from '@noy-db/by-peer'

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

## Leader election (cross-tab coordination)

When 3+ tabs share a `BroadcastChannel`-backed `PeerChannel` (typically via `@noy-db/by-tabs`) and each runs `servePeerStore`, every non-sending tab responds to every RPC — producing duplicate responses for the same request id and `O(N²)` channel traffic at scale (issue [#3](https://github.com/vLannaAi/noy-db/issues/3)).

Opt in to leader-election semantics via the Web Locks API. Only the lock-holding tab registers an RPC handler; others queue silently and take over when the holder's tab closes (the lock auto-releases).

```ts
import { tabsChannel } from '@noy-db/by-tabs'
import { servePeerStore } from '@noy-db/by-peer'

const channel = tabsChannel({ name: 'my-app:vault' })

servePeerStore({
  channel,
  store: localStore,
  leaderElection: { lockName: 'noy-db:peer-server:my-app:vault' },
})
```

The same `lockName` MUST be used by every tab participating in the role. Browser support: Chrome 69+, Firefox 96+, Safari 15.4+. For tests or non-browser hosts, pass a stub `MinimalLockManager` via `leaderElection.locks`.

The 2-tab case works correctly without `leaderElection` (BroadcastChannel doesn't echo to sender). Enable for any consumer expecting 3+ tabs.

## Transport abstraction

`PeerChannel` is the only primitive — any reliable in-order string channel works. The same wrapper is reused by every other `by-*` package:

| Transport | Factory | Package |
|---|---|---|
| WebRTC DataChannel | `fromDataChannel(dc)` | `@noy-db/by-peer` |
| In-memory pair (tests) | `pairInMemory()` | `@noy-db/by-peer` |
| BroadcastChannel | `tabsChannel(name)` | `@noy-db/by-tabs` |
| WebSocket / SSE relay | (planned) | `@noy-db/by-server` |
| Liveblocks / Yjs room | (planned) | `@noy-db/by-room` |

## Status

`0.1.0-pre.1` — prototype. LAN-first. Multi-peer mesh is a follow-up.
