# Cross-tab write propagation (#228 sub-slice b) — design

**Status:** design approved · **Date:** 2026-06-01 · **Issue:** #228 · **Epic:** hub coordination · **Builds on:** [#228(a) tab presence + roles](2026-06-01-228-tab-coordination-design.md), #230 write hooks

Sub-slice **(b)** of multi-client write coordination. When a write commits in one same-origin tab, every *other* tab refreshes its in-memory view of that document — so a write in tab A appears in tab B's UI without a reload. Browser-only (same-origin `BroadcastChannel`), opt-in via the same `db.enableTabCoordination()` surface as (a), graceful no-op elsewhere.

## Decisions (locked)

| Decision | Choice | Why |
|---|---|---|
| **What crosses the channel** | **Signal + re-read** — broadcast `{vault, collection, docId, action}` only; receivers re-read the encrypted envelope from the shared IDB and decrypt locally | Keeps the channel ciphertext-blind (no decrypted data ever leaves a tab's memory); the receiver gets the authoritative record + `_v` for free; matches the issue's stated "broadcast changed document IDs" intent |
| **Propagation model** | **Role-agnostic** — *any* tab that commits a write broadcasts; *every other* tab applies | Delivers the user-visible win (cross-tab live updates) now; needs no write-routing/RPC. Write serialization + conflict handling stay in later slices |
| **Enable surface** | Folded into `db.enableTabCoordination({ propagateWrites? })` (default `true`) | One opt-in for "make this tab coordinate"; opt-out with `propagateWrites: false` |

## Prerequisite: `vault` on `WriteEvent`

`WriteEvent` (#230, `packages/hub/src/write-hooks.ts`) currently carries `collection` and `docId` but **not `vault`**. A receiving tab needs the vault to resolve which loaded collection to refresh. This slice adds a `readonly vault: string` field to `WriteEvent`, populated at the emit site (the Collection already knows `this.vault`). Backward-compatible: existing #230 consumers simply gain a field.

## Architecture

A self-contained **`CrossTabWriteRelay`** (`packages/hub/src/tab-write-relay.ts`), independent of `TabCoordinator` — role-agnostic propagation needs no election. It owns its **own** channel (`defaultChannel('noydb:tab-writes')`, distinct from the presence channel so each channel has a single listener, which keeps the deterministic in-memory test bus simple) and a `writerId` (the tab's id; defaults to the same id (a) uses).

- **Broadcast side.** Subscribes to the instance's `onAfterWrite` (#230). On each committed write, sends:

  ```ts
  interface TabWriteMsg {
    readonly kind: 'tab-write'
    readonly writerId: string
    readonly vault: string
    readonly collection: string
    readonly docId: string
    readonly action: 'put' | 'delete'   // create|update → 'put'; delete → 'delete'
  }
  ```

- **Apply side.** On a `tab-write` message from a **different** `writerId`, calls an injected `applyRemoteWrite(vault, collection, docId, action): Promise<void>`. Self-`writerId` messages are ignored (belt-and-suspenders — applies never re-broadcast anyway, see below).

### Wiring (`Noydb.enableTabCoordination`)

When `propagateWrites !== false` and a channel is available, `enableTabCoordination` constructs the relay alongside the `TabCoordinator` and supplies the apply callback:

```
applyRemoteWrite(vault, collection, docId, action):
  resolve the *loaded* vault (skip if not open in this tab)
  resolve the *loaded* collection (skip if not registered/loaded)
  await coll._applyRemoteChange(docId, action)
```

The relay is torn down in the same `#disableTabCoordination()` / `close()` path as (a).

### The apply primitive — `Collection._applyRemoteChange(id, action)`

A thin new internal method:

```
await this._invalidateCacheEntry(id)   // re-read shared-IDB envelope, decrypt, update cache + indexes
                                        // (already handles delete: missing envelope → cache delete)
this.emitter.emit('change', { vault: this.vault, collection: this.name, id, action })
```

`_invalidateCacheEntry` (collection.ts) already does the re-read/decrypt/cache/index work but deliberately does **not** emit a change event; `_applyRemoteChange` adds exactly that emit so reactive consumers (in-vue) re-render. This is the single new piece of apply logic; everything else reuses existing machinery.

### No re-broadcast loop

Apply goes through `_invalidateCacheEntry`, **not** `put`/`delete` — so it never persists to the store and never fires `onAfterWrite`. Therefore an applied remote write cannot trigger another broadcast. The `writerId` self-filter is a redundant second guard.

## Data flow

```
tab A: coll.put(id, rec) ─► persists to shared IDB ─► onAfterWrite{ vault, collection, docId, op }
                                                          │
                          relay.broadcast TabWriteMsg{ writerId:A, vault, collection, docId, action }
                                                          │   BroadcastChannel 'noydb:tab-writes'
                                                          ▼
tab B: relay.onMessage ─► writerId ≠ B ─► applyRemoteWrite(vault, collection, docId, action)
        └─► Noydb resolves loaded vault + collection (skip if absent)
              └─► coll._applyRemoteChange(docId, action)
                    ├─ _invalidateCacheEntry(docId)   // re-read + decrypt + cache/index update
                    └─ emit 'change' { vault, collection, id, action }   // in-vue re-renders
```

The signal is sent **after** the primary's `put` persists (`onAfterWrite` is post-persist), and IndexedDB is read-committed across same-origin tabs, so the envelope a `put` signal refers to is visible to the receiver by the time it re-reads.

## Error handling / edges

- **Vault or collection not loaded in the receiving tab** → skip silently; the fresh state is read on next open.
- **Re-read finds nothing** (e.g. a delete, or a not-yet-visible write) → `_invalidateCacheEntry` deletes the cache entry; benign.
- **No channel** (Node/SSR, or `defaultChannel()` returns `undefined`) → relay inert, mirroring (a)'s no-op path. `propagateWrites` defaulting `true` is therefore still a safe no-op server-side.
- **Apply errors** are caught and `console.warn`'d inside the message callback (mirrors `onAfterWrite`'s swallow-and-warn); never thrown into the channel handler.
- **Lazy collections** → `_invalidateCacheEntry` evicts the LRU entry; the emitted `change` prompts a fresh read on next access.

## Testing (deterministic, no real browser)

- **Unit — `packages/hub/__tests__/tab-write-relay.test.ts`.** In-memory broadcast bus (same helper shape as (a)) + a fake `onAfterWrite` source + a spy `applyRemoteWrite`. Assert:
  1. a committed write broadcasts a `TabWriteMsg` with the correct `vault/collection/docId/action`;
  2. a foreign `tab-write` invokes `applyRemoteWrite` with the right args;
  3. a self-`writerId` message is ignored;
  4. with no channel, the relay is inert (no broadcast, no throw).
- **Integration — `packages/hub/__tests__/tab-write-propagation.test.ts`.** Two `createNoydb` instances sharing **one `memory()` store instance**, **same `user` + `secret`** (a faithful same-origin/same-user multi-tab analog), each `enableTabCoordination` wired to a shared in-memory write-bus. Write in db1 → flush → assert db2's collection reflects it (`get`/`query` returns the new record; a `change` listener fired). Cover **put and delete** propagation, and that a write to a vault **not** open in db2 is harmlessly ignored.

## Scope

**In (b):** the relay (broadcast + apply), the `vault` field on `WriteEvent`, `Collection._applyRemoteChange`, the `enableTabCoordination({ propagateWrites })` wiring + teardown, the no-op path, unit + integration tests, `features.yaml` registration.

**Out (later slices):** `_v` + `base`-ancestor in the signal and `WriteConflict` detection → (c) (the re-read already yields authoritative state, so `_v` is redundant for (b)'s refresh purpose); primary-routed/serialized writes (secondaries relaying intents to the primary) → a separate slice; cross-device propagation → the sync engine, explicitly out of #228's scope.

## Success criteria

1. A `put` committed in one tab refreshes the same document in every other tab that has the collection loaded — cache + a `change` event — without a reload, and without that tab re-persisting or re-firing write hooks.
2. A `delete` committed in one tab removes the document from other tabs' loaded views the same way.
3. Nothing decrypted crosses the channel — only `{vault, collection, docId, action}`.
4. Opt-in via `enableTabCoordination` (`propagateWrites` default `true`); a graceful no-op outside browsers; `propagateWrites: false` disables it. Hubs that don't enable coordination start no relay.
5. No broadcast loop: an applied remote write never triggers a re-broadcast.
