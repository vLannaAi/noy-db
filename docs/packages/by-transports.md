# `@noy-db/by-*` — Session-share transports

> **How live state bridges between realms.** Each `by-*` package is a thin
> transport that lets two or more noy-db instances — peers across the network,
> tabs in the same browser, members of a relay room — observe each other's
> changes without exposing plaintext to the wire.
> Zero mandatory dependencies on noy-db's side; transports are peer-deps.

The `by-` prefix reads as *"sync **by** way of …"*. Unlike the `to-*` family
(storage destinations) or the `on-*` family (unlock methods), `by-*` packages
do **not** persist data — they are short-lived channels that fan a vault's
change stream out to other realms holding their own keys.

> **Single-tenant model holds.** Every realm on a `by-*` channel still
> derives its own KEK from the user's passphrase / passkey / etc. The
> transport carries encrypted envelopes, never plaintext, never DEKs.

---

## Today

| Package | Transport | What it does |
|---|---|---|
| [`@noy-db/by-peer`](../../packages/by-peer) | WebRTC | Peer-to-peer connection between two browsers / Node processes; carries encrypted envelopes through a data channel. Pairs with `withSync()` and `withCrdt()` for collaborative editing without a relay server. Previously published as `@noy-db/p2p`. |
| [`@noy-db/by-tabs`](../../packages/by-tabs) | `BroadcastChannel` | Multi-tab sync inside one browser. When a user has the same vault open in three tabs, every put in tab A surfaces in tabs B and C without round-tripping the storage backend. Reuses the `PeerChannel` contract so it composes with `peerStore()` from `@noy-db/by-peer`. |

## Reserved

| Package | Transport | Use case |
|---|---|---|
| `@noy-db/by-server` | WebSocket / SSE relay | Single-server fan-out for teams that don't want every client to know every other client's IP — a thin relay that never decrypts. |
| `@noy-db/by-room` | Liveblocks / Yjs y-websocket / similar | Drop into an existing presence/room provider. The provider sees ciphertext only. |

---

## When to reach for a `by-*` package

Pick a `by-*` package when you need **live propagation** without **durable storage**:

- Two laptops on the same Wi-Fi editing a shared note → `by-peer`
- Same user with three browser tabs of the same dashboard → `by-tabs`
- A small team behind a single relay server → `by-server` *(reserved)*
- An app already wired to Liveblocks/Yjs for cursors → `by-room` *(reserved)*

If you want **durable** state at the destination, you want a `to-*` store. The two compose: a `to-aws-dynamo` store for the source of truth, plus `by-peer` between active editors for sub-second update propagation while the durable write is still in flight.

---

## Contract

Every `by-*` package implements the small `PeerChannel` interface defined in
`@noy-db/by-peer`. Any reliable, in-order, string-delivering channel qualifies:

```ts
interface PeerChannel {
  readonly isOpen: boolean
  send(payload: string): void
  on(event: 'message', listener: (payload: string) => void): () => void
  on(event: 'close', listener: () => void): () => void
  close(): void
}
```

This is the same primitive `peerStore()` and `servePeerStore()` use. Composing
the two families is one line:

```ts
import { peerStore, servePeerStore } from '@noy-db/by-peer'
import { tabsChannel } from '@noy-db/by-tabs'

// Tab A — proxy operations to Tab B's store
const remote = peerStore({ channel: tabsChannel('vault-acme') })

// Tab B — answer the RPC calls against its local store
servePeerStore({ channel: tabsChannel('vault-acme'), store: localStore })
```

Channels carry encrypted envelopes only — no plaintext, no DEKs.

---

## Why a fifth family

The four other families have always been separate concerns:

- `to-*` — *where data rests*
- `in-*` — *where the runtime lives*
- `on-*` — *how the user logs on*
- `as-*` — *how data leaves as a portable artefact*

Session-sharing didn't fit any of those. It isn't storage (no `loadAll` / `saveAll`); it isn't a framework binding; it isn't auth; it isn't an export. Folding it under one of the existing prefixes would have muddied the mental model. `by-*` keeps each prefix a single, clean preposition.

---

## Related

- [`SUBSYSTEMS.md`](../../SUBSYSTEMS.md) — the `sync` and `crdt` subsystems are the hub-side strategies that produce the change stream a `by-*` transport carries.
- [`docs/recipes/realtime-crdt-app.md`](../recipes/realtime-crdt-app.md) — the canonical real-time recipe; pairs naturally with `by-peer` and `by-tabs`.
- [`docs/packages/README.md`](./README.md) — overview of all five package families.
