# Package catalogs

> NOYDB ships as one core (`@noy-db/hub`) plus five prefixed package families. Each prefix reads as a preposition — the mental model stays the same as you scale from one-file vaults to multi-tenant cloud deployments.

| Prefix | Reads as | Catalog | Count |
|---|---|---|---:|
| `to-` | *"data goes **to** a backend"* | [to-stores.md](./to-stores.md) | 20 |
| `in-` | *"runs **in** a framework"* | [in-integrations.md](./in-integrations.md) | 10 |
| `on-` | *"you get **on** via this method"* | [on-auth.md](./on-auth.md) | 9 |
| `as-` | *"export **as** XLSX / JSON / …"* | [as-exports.md](./as-exports.md) | 9 |
| `by-` | *"sync **by** way of …"* | [by-transports.md](./by-transports.md) | 2 today, 4 planned |

## Quick reference

### `to-*` — Storage destinations

The only piece that touches ciphertext on the wire. File, browser, SQL, cloud, remote FS, iCloud, Drive, metrics, diagnostics.

→ **[to-stores.md](./to-stores.md)**

### `in-*` — Framework integrations

Thin reactive bindings. React, Next.js, Vue, Nuxt, Pinia, Svelte, Zustand, TanStack Query/Table, Yjs CRDT, LLM tool-calling.

→ **[in-integrations.md](./in-integrations.md)**

### `on-*` — Unlock / auth

Composable primitives. Passkeys (WebAuthn), OIDC split-key, magic links, TOTP, email OTP, recovery codes, Shamir k-of-n, duress + honeypot.

→ **[on-auth.md](./on-auth.md)**

### `as-*` — Portable artefacts

Two-tier authorisation with audit ledger. CSV, Excel, XML, JSON, NDJSON, SQL dump, PDF blobs, ZIP, encrypted `.noydb` bundle.

→ **[as-exports.md](./as-exports.md)**

### `by-*` — Session-share transports

Live-state bridges between realms (peers, tabs, rooms, relay servers). Today `@noy-db/by-peer` (WebRTC peer-to-peer, renamed from `@noy-db/p2p`) and `@noy-db/by-tabs` (BroadcastChannel multi-tab sync); reserved `by-server`, `by-room`.

→ **[by-transports.md](./by-transports.md)**

## Vs. subsystems

The five families above are **separate npm packages** — `npm install` what you want, omit what you don't. They keep your *dependency graph* small.

The 17 [subsystems](../subsystems/) are **internal opt-ins** within `@noy-db/hub` — gated by `with*()` strategy seams. They keep the *core package's bundle* small.

Both layers compose:

```ts
import { createNoydb } from '@noy-db/hub'        // core
import { withHistory } from '@noy-db/hub/history' // subsystem (internal)
import { postgres } from '@noy-db/to-postgres'    // separate package
import { useCollection } from '@noy-db/in-vue'    // separate package
import { withWebAuthn } from '@noy-db/on-webauthn'// separate package
import { csv } from '@noy-db/as-csv'              // separate package
import { peerStore } from '@noy-db/by-peer'       // by-* family (WebRTC)
import { tabsChannel } from '@noy-db/by-tabs'     // by-* family (BroadcastChannel)
```

## Related

- [docs/core/](../core/) — the always-on hub minimum
- [docs/subsystems/](../subsystems/) — the 17 opt-in capabilities inside the hub
- [SUBSYSTEMS.md](../../SUBSYSTEMS.md) — the catalog
- [CLAUDE.md](../../CLAUDE.md) — agent / contributor guide
