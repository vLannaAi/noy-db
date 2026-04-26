# sync

> **Subpath:** `@noy-db/hub/sync`
> **Factory:** `withSync()`
> **Cluster:** F — Collaboration & Auth
> **LOC cost:** ~856 (off-bundle when not opted in)

## What it does

Replication engine: dirty tracking, push to a remote store, pull from a remote store, conflict resolution, scheduling. Plus presence (live "who is here" awareness) over an encrypted channel keyed by the collection DEK. Multiple sync targets supported (sync-peer, backup, archive).

## When you need it

- Multi-device single-user (laptop + phone)
- Multi-user collaboration where each device has a local cache + a shared cloud target
- Active backup / archive replication
- Live presence in the UI

## Opt-in

```ts
import { createNoydb } from '@noy-db/hub'
import { withSync } from '@noy-db/hub/sync'

const db = await createNoydb({
  store: localStore,            // local cache
  sync: remoteStore,            // primary sync target
  user: ...,
  syncStrategy: withSync(),
})
```

Multiple targets:

```ts
const db = await createNoydb({
  store: localStore,
  sync: [
    { store: peer, role: 'sync-peer' },
    { store: archive, role: 'archive' },
  ],
  syncStrategy: withSync(),
})
```

## API

- `db.push(vault, opts?)` / `db.pull(vault, opts?)`
- `db.syncStatus(vault)` — dirty count + last push/pull timestamps
- `db.startAutoSync(vault, intervalMs)` / `stopAutoSync(vault)`
- `collection.presence<P>(opts?)` — `PresenceHandle` with `publish` / `subscribe`

## Behavior when NOT opted in

- Setting `sync: ...` in `createNoydb` throws on first `openVault` with a pointer to `@noy-db/hub/sync`
- `db.push` / `db.pull` / `collection.presence()` throw same

## Pairs well with

- **crdt** — sync engine respects CRDT merge semantics; conflicts resolve inside the CRDT
- **team** — grants flow over sync; rotated DEKs propagate to peers
- **session** — long-lived sessions for always-on devices

## Edge cases & limits

- Conflict policy defaults to `'version'` (higher `_v` wins). Override per-collection via `conflictPolicy: 'remote-wins' | 'local-wins' | customResolver`
- Presence keys derive from collection DEK via HKDF — revoked users lose presence access on the next DEK rotation
- Adapter pub/sub is preferred for real-time presence; falls back to storage poll (default 5s interval)

## See also

- [SUBSYSTEMS.md](../../SUBSYSTEMS.md)
- `docs/recipes/realtime-crdt-app.md`
- `__tests__/sync.test.ts`, `__tests__/presence.test.ts`, `showcases/src/04-sync-two-offices.showcase.test.ts`
