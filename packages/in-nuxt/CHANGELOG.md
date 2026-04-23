# @noy-db/nuxt

## 1.0.0

### Patch Changes

- Updated dependencies
  - @noy-db/hub@0.11.0
  - @noy-db/in-pinia@1.0.0
  - @noy-db/in-vue@1.0.0

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
  - @noy-db/vue@1.0.0
  - @noy-db/pinia@1.0.0

## 1.0.0

### Patch Changes

- Updated dependencies [29c54c4]
- Updated dependencies [29c54c4]
  - @noy-db/core@0.8.0
  - @noy-db/pinia@1.0.0
  - @noy-db/vue@1.0.0

## 1.0.0

### Patch Changes

- Updated dependencies [2d38d62]
- Updated dependencies [2d38d62]
- Updated dependencies [2d38d62]
- Updated dependencies [2d38d62]
- Updated dependencies [2d38d62]
  - @noy-db/core@0.7.0
  - @noy-db/pinia@1.0.0
  - @noy-db/vue@1.0.0

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
  - @noy-db/pinia@1.0.0
  - @noy-db/vue@1.0.0

## 0.5.0

### Initial release

Nuxt 4 module for `@noy-db/core` — auto-imports, SSR-safe runtime plugin, and the `@noy-db/pinia` bridge. Intended for Nuxt 4 applications that want `noy-db` as a zero-config drop-in encrypted data layer.

Add `@noy-db/nuxt` to the `modules` array in `nuxt.config.ts` and the module wires up:

- **Auto-imports** for `useNoydb`, `useCollection`, `useSync`, `defineNoydbStore` — available in any `app/` file without an import statement.
- **SSR-safe runtime plugin** that creates a shared `Noydb` instance in the Nuxt app context. Encrypted state stays client-side only by default; server-side rendering uses an empty plaintext stub.
- **DevTools integration** — a `noy-db` devtools tab shows compartment state, keyring user list, collection contents, and ledger head info during development.
- **Pinia bridge** — when `@pinia/nuxt` is also installed, the module registers the `createNoydbPiniaPlugin` automatically so every `defineStore` can transparently opt in to `noy-db` persistence.

Config options: `adapter: 'browser' | 'file' | 'memory'`, `pinia: boolean`, `devtools: boolean`.

Peer dependencies: `@noy-db/core ^0.5.0`, `@noy-db/pinia ^0.5.0`, `@noy-db/vue ^0.5.0`, `nuxt ^4.0.0`.
