# @noy-db/pinia

## 1.0.0

### Patch Changes

- Updated dependencies
  - @noy-db/hub@0.11.0

## 1.0.0

### Patch Changes

- feat(v0.9): sync v2 — conflict policies, partial sync, transactions, CRDT, presence, @noy-db/yjs

  ### @noy-db/core

  - **#131 `conflictPolicy`** — per-collection conflict resolution: `'last-writer-wins'`, `'first-writer-wins'`, `'manual'`, or a custom merge function. Overrides the db-level `conflict` option.
  - **#132 CRDT mode** — `crdt: 'lww-map' | 'rga' | 'yjs'` on any collection. `collection.getRaw(id)` returns the full `CrdtState`. CRDT conflict resolver auto-merges at the envelope level without the app seeing it.
  - **#133 Partial sync** — `push(comp, { collections })`, `pull(comp, { collections, modifiedSince })`, `sync(comp, { push, pull })`. Adapter may add optional `listSince()` for server-side filtering.
  - **#134 Presence** — `collection.presence<P>()` returns a `PresenceHandle`. `update(payload)` encrypts with an HKDF-derived key (from the collection DEK) and publishes. `subscribe(cb)` delivers decrypted peer snapshots. Real-time via adapter pub/sub; storage-poll fallback for all other adapters.
  - **#135 Sync transactions** — `db.transaction(comp).put(col, id, rec).delete(col, id).commit()`. Two-phase: local writes then `pushFiltered()` for only the transaction records. Returns `{ status, pushed, conflicts }`.

  ### @noy-db/yjs (new package)

  - `yjsCollection(comp, name, { yFields })` — wraps a `crdt: 'yjs'` collection with Y.Doc-aware API
  - `getYDoc(id)` — decode stored base64 update into a Y.Doc with declared fields initialised
  - `putYDoc(id, doc)` — encode Y.Doc state and persist as encrypted envelope
  - `applyUpdate(id, bytes)` — merge a Yjs update into an existing record
  - `yText()`, `yMap()`, `yArray()` field descriptors

- Updated dependencies
  - @noy-db/core@0.9.0

## 1.0.0

### Patch Changes

- Updated dependencies [29c54c4]
- Updated dependencies [29c54c4]
  - @noy-db/core@0.8.0

## 1.0.0

### Patch Changes

- Updated dependencies [2d38d62]
- Updated dependencies [2d38d62]
- Updated dependencies [2d38d62]
- Updated dependencies [2d38d62]
- Updated dependencies [2d38d62]
  - @noy-db/core@0.7.0

## 0.6.0

### Patch Changes

- Updated dependencies [755f151]
- Updated dependencies [92f2000]
- Updated dependencies [36dbdbc]
- Updated dependencies [f968f83]
- Updated dependencies [bd21ad7]
- Updated dependencies [d90098a]
- Updated dependencies [958082b]
- Updated dependencies [f65908a]
  - @noy-db/core@0.6.0

## 0.5.0

### Initial release

Pinia integration for `@noy-db/core` — `defineNoydbStore()` and the augmentation plugin for existing Pinia stores. Intended for Vue 3 and Nuxt 4 applications that use Pinia as their state-management layer and want `noy-db` to transparently persist that state with encryption.

**`defineNoydbStore<T>(name, options)`** creates a Pinia store whose state is automatically synced with a `@noy-db/core` collection. Accepts the same Standard Schema v1 validator as the underlying `Collection` so every read/write is typed and validated end-to-end. Supports eager and lazy hydration modes, index declarations, and reactive `useCollection`-like subscriptions.

**`createNoydbPiniaPlugin()`** is an augmentation plugin for existing Pinia stores that weren't originally declared with `defineNoydbStore`. The plugin wraps their state with the same `noy-db` persistence without requiring a rewrite — useful for adopting `noy-db` incrementally in an existing Vue app.

Peer dependencies: `@noy-db/core ^0.5.0`, `pinia ^2.1.0 || ^3.0.0`, `vue ^3.4.0`.
