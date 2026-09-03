# @noy-db/by-peer

<!-- prose-preamble
// Bindings the illustrative blocks below elide. Typed on purpose (#1310).
import { servePeerStore, peerStore, type PeerChannel } from '@noy-db/by-peer'
import type { NoydbStore } from '@noy-db/hub'
declare const channel: PeerChannel
declare const local: NoydbStore
declare const inviteToken: string
declare const aliceChannel: PeerChannel
declare const bobChannel: PeerChannel
declare const aliceInvite: string
declare const bobInvite: string
-->

WebRTC peer-to-peer transport for [noy-db](https://github.com/vLannaAi/noy-db) — no server in the middle.

> First member of the `by-*` family of session-share transports. See [`docs/packages/by-transports.md`](https://github.com/vLannaAi/noy-db-docs/blob/main/content/docs/packages/by-transports.md) for the family contract and roster.
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
import { toBrowserIdb } from '@noy-db/to-browser-idb'
import { peerStore, createOffer, acceptOffer } from '@noy-db/by-peer'

// Peer A — initiator
const initiator = await createOffer()
shareWithPeerB(initiator.offer)             // QR code, Matrix, pastebin, …
await initiator.accept(await receiveAnswer())
const channel = await initiator.channel

const db = await createNoydb({
  store: toBrowserIdb(),
  user: 'alice',
  secret: userSecret,
  syncStrategy: withSync(),                 // required — sync is opt-in
  sync: { store: peerStore({ channel, token: inviteToken }), role: 'sync-peer' },
})

const vault = await db.openVault('my-vault')
await db.pull('my-vault')                   // the vault name is required
```

`withSync` comes from `@noy-db/hub/sync`. Two things the snippet used to omit and
that both fail confusingly without:

- **`syncStrategy: withSync()`** — sync is an opt-in service, so `sync:` alone
  wires the target but builds no engine.
- **the vault name** on `pull` / `push` / `sync`. An engine is built per vault as
  it is opened, so `db.pull()` with no argument looks up an engine for
  `undefined` and finds none.

Peer B mirrors the handshake with `acceptOffer` and runs
`servePeerStore({ channel, store, token: inviteToken })` so its local store
answers the incoming RPC calls.

## Authentication — fail-closed

**`servePeerStore` requires the bearer token from the invite, and refuses every
request without it.** A server configured with no `token` serves nobody. That
mirrors `@noy-db/in-rest`, where no `authorize` hook means `401` on everything.

```ts
servePeerStore({ channel, store: local, token: inviteToken })   // server
peerStore({ channel, token: inviteToken })                      // client
```

This reversed an earlier default. `servePeerStore` used to serve the whole store
to anyone who reached the channel — holding the channel *was* the credential,
which is defensible for a 1:1 invite-based session share and stops being
defensible the moment a channel stops meaning "I invited this person".

Two properties worth knowing:

- **Refusal happens before the store is touched**, so a rejected write does not land.
- **Auth is checked before method validity**, so an unauthorized caller cannot
  learn which methods this peer serves. `Unauthorized` and "unknown method"
  are the same answer, by construction.

`allow` is **not** authentication and never was — it says which of the six
methods may be called, not by whom. It composes with `token`.

## Read-only peers

```ts
servePeerStore({
  channel,
  store: local,
  token: inviteToken,
  allow: new Set(['get', 'list', 'loadAll', 'listPage', 'ping']),
})
```

Denied methods surface as a remote `Error` at the client.

## Multiple invites — a star of peers

`serveMultiPeerStore` is one peer accepting **N invites instead of 1**: star
topology, every invited peer talking to this one, never to each other. Each
accepted invite is one `servePeerStore` underneath — its own channel, its own
token, its own `allow` — so everything above holds per peer. **The one thing
that is not assembly is a token per peer:**

```ts
import { serveMultiPeerStore } from '@noy-db/by-peer'

const star = serveMultiPeerStore({ store: local })

// One invite → one token → one channel. Returns a revoke for exactly that peer.
const revokeAlice = star.accept({ channel: aliceChannel, token: aliceInvite })
star.accept({ channel: bobChannel, token: bobInvite, allow: new Set(['get', 'list', 'loadAll', 'ping']) })

revokeAlice()      // Alice is gone; Bob is untouched
star.size          // 1
star.dispose()     // everyone
```

- **Fail-closed survives the widening.** `accept()` refuses an empty or missing
  token at runtime as well as by type, so "no token" can never mean "any peer".
- **A token is bound to the channel it was accepted on.** Alice's token on
  Bob's channel is refused; a token that is already live is refused at
  `accept()` — one token, one peer, or revocation stops meaning anything.
- **A closed channel is a departed peer**: it is dropped and its token may be
  issued again.
- **Attribution is a decision, not a default.** With a token per peer "who
  wrote this" becomes answerable, so this package records nothing — it holds
  `(channel, token)` pairs and no history. Pass a per-peer decorated `store` in
  `accept()` if you want attribution, and own what you log.
- **What the hub peer sees.** Every invited peer's records pass through it as
  ciphertext; it can open them only with a keyring for that vault (as the
  vault's owner it normally has one — this is a session share, not an escrow).
  It can always observe metadata: which channel called which method on which
  vault/collection/id, and when. It is also the single point of failure: if
  its tab closes, the invites close with it.

No catalog, no locator, no discovery — those belong to the daemon. And no
`leaderElection`: an invite is one channel to one remote peer, the opposite
shape from the many-tabs-one-bus case Web Locks solves below.

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
  token: inviteToken,
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
