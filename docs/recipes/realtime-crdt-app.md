# Recipe 3 — Real-time collaborative app

> **Audience:** apps where two or more users edit the same documents simultaneously and need automatic merge — collaborative editors, live cursors, shared whiteboards, multi-device personal apps.
> **Bundle:** core + `withCrdt` + `withSync` + `withLive` (n/a yet — see SUBSYSTEMS catalog) + `withTeam` + `withSession` (~10,400 LOC).
> **Verified by:** [showcases/src/recipe-realtime-crdt.recipe.test.ts](../../showcases/src/recipe-realtime-crdt.recipe.test.ts)

## What this gets you

| Subsystem | What it adds |
|---|---|
| `withCrdt()` | Conflict-free merge for `lww-map`, `rga`, and `yjs` collection modes |
| `withSync()` | `db.push()` / `db.pull()` replication, sync engine with conflict resolution, `collection.presence()` |
| `withTeam()` | Multi-user grant / revoke / rotate, magic-link viewer sessions, hierarchical tiers |
| `withSession()` | Token-based sessions, idle timeouts, dev-unlock for development |
| `withHistory()` | (Optional) keep an audit trail of merged changes |

## Setup

```ts
import { createNoydb } from '@noy-db/hub'
import { withCrdt } from '@noy-db/hub/crdt'
import { withSync } from '@noy-db/hub/sync'
import { withTeam } from '@noy-db/hub/team'
import { withSession } from '@noy-db/hub/session'
import { idbStore } from '@noy-db/to-browser-idb'
import { r2 } from '@noy-db/to-cloudflare-r2'

const db = await createNoydb({
  store: idbStore(),                 // local cache
  sync: r2({ /* … */ }),             // replication target
  user: currentUser.id,
  secret: currentUser.passphrase,

  crdtStrategy: withCrdt(),
  syncStrategy: withSync(),
  teamStrategy: withTeam(),
  sessionStrategy: withSession(),

  sessionPolicy: {
    idleTimeoutMs: 15 * 60_000,
    absoluteTimeoutMs: 8 * 60 * 60_000,
    lockOnBackground: true,
  },
})
```

## Define a CRDT-backed collection

```ts
import * as Y from 'yjs'

interface Document {
  id: string
  title: string
  content: Y.Doc
}

const docs = (await db.openVault('shared'))
  .collection<Document>('docs', { crdt: 'yjs' })
```

## Two devices edit independently — merge converges

```ts
// Device A
const docA = await docs.get('doc-1')
docA.content.getText('body').insert(0, 'Hello from device A. ')
await docs.put('doc-1', docA)
await db.push('shared')

// Device B (concurrently)
const docB = await docs.get('doc-1')
docB.content.getText('body').insert(0, 'Hello from device B. ')
await docs.put('doc-1', docB)
await db.push('shared')

// Both pull
await db.pull('shared')

// Both see the merged result — Yjs's CRDT semantics handle the
// concurrent inserts. The order depends on logical clocks, not
// wall-clock time.
const merged = await docs.get('doc-1')
console.log(merged.content.getText('body').toString())
// → "Hello from device A. Hello from device B. " (or B then A)
```

## Live presence — see who else is here

```ts
const presence = docs.presence<{ cursor: { x: number; y: number } }>()

// Broadcast my cursor
presence.publish({ cursor: { x: 120, y: 340 } })

// Subscribe to peers
presence.subscribe((peers) => {
  for (const peer of peers) {
    console.log(`${peer.userId}: cursor at`, peer.payload.cursor)
  }
})
```

Presence keys are derived from the collection DEK, so:
- The remote store never sees user identities tied to presence payloads
- Revoked users automatically lose presence access on the next DEK rotation

## Granting access to a collaborator

```ts
import { GrantOptions } from '@noy-db/hub'

await db.grant('shared', {
  grantee: 'collaborator@example.com',
  role: 'operator',
  permissions: { docs: 'rw' },
})
```

The grantee unlocks via their own passphrase or via a magic link, OIDC, WebAuthn, etc. (see the `@noy-db/on-*` packages).

## Conflict policy — what wins on `pull`?

`withSync()` defaults to `'version'` strategy: the higher `_v` wins. Override per-collection:

```ts
const docs = vault.collection<Document>('docs', {
  crdt: 'yjs',
  conflictPolicy: 'remote-wins', // or 'local-wins', or a custom resolver
})
```

CRDT collections (`crdt: 'yjs'` / `'lww-map'` / `'rga'`) bypass envelope-level conflict resolution — the merge happens inside the CRDT itself.

## See also

- [SUBSYSTEMS.md](../../SUBSYSTEMS.md) — full catalog
- [docs/subsystems/crdt.md](../subsystems/crdt.md) (TODO)
- [docs/subsystems/sync.md](../subsystems/sync.md) (TODO)
- [showcases/src/04-sync-two-offices.showcase.test.ts](../../showcases/src/04-sync-two-offices.showcase.test.ts)
- [showcases/src/09-encrypted-crdt.showcase.test.ts](../../showcases/src/09-encrypted-crdt.showcase.test.ts)
