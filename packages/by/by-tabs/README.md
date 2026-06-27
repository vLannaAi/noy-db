# @noy-db/by-tabs

BroadcastChannel multi-tab transport for [noy-db](https://github.com/vLannaAi/noy-db) — sub-millisecond fan-out between tabs of the same origin.

> Second member of the `by-*` family of session-share transports. See [`docs/packages/by-transports.md`](../../docs/packages/by-transports.md) for the family contract and roster.

## Install

```sh
pnpm add @noy-db/by-tabs @noy-db/by-peer @noy-db/hub
```

## Why

Three browser tabs of the same dashboard, all subscribed to the same vault. A `put` in tab A should surface in B and C without going round-trip through IndexedDB and back. `BroadcastChannel` is the native browser primitive for that fan-out — `@noy-db/by-tabs` wraps it as a `PeerChannel`, the same shape every other `by-*` transport implements.

## Use

```ts
import { tabsChannel, isTabsChannelAvailable } from '@noy-db/by-tabs'
import { peerStore, servePeerStore } from '@noy-db/by-peer'

if (!isTabsChannelAvailable()) {
  // Node, SSR, or an older browser — fall back to direct store access.
  return
}

// Tab A — proxy operations to Tab B's store.
const channel = tabsChannel({ name: 'noy-db:vault-acme' })
const remote = peerStore({ channel })

// Tab B — answer the RPC calls against its local store.
servePeerStore({ channel: tabsChannel({ name: 'noy-db:vault-acme' }), store: localStore })
```

## Threat model

- `BroadcastChannel` is **same-origin** by browser policy. Only documents on the same scheme + host + port can subscribe.
- noy-db already encrypts at rest — every tab on the channel sees AES-256-GCM ciphertext envelopes. The transport never decrypts.
- Treat the channel as **origin-scoped, not session-scoped** — untrusted iframes that share the origin can subscribe.

## API

| Export | Shape |
|---|---|
| `tabsChannel({ name })` | Returns a `PeerChannel` wrapping a fresh `BroadcastChannel`. |
| `isTabsChannelAvailable()` | Pre-flight: `true` when `BroadcastChannel` is defined. |

When `BroadcastChannel` is undefined the package returns a **no-op channel** so consumer code can import it on the server without crashing — `send()` will throw, `isOpen` stays `false`, and `on()` is a no-op subscribe.

## Status

`0.1.0-pre.1` — debut. Companion to `@noy-db/by-peer`.
