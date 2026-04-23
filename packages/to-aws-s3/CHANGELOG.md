# @noy-db/s3

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

AWS S3 adapter for `@noy-db/core` — encrypted object storage with zero-knowledge cloud sync. Intended for long-term archival, cheapest-possible storage, and workloads where an S3 bucket is the natural destination.

One S3 object per record, organized as `{compartment}/{collection}/{id}.json` under an optional prefix. ETag-based optimistic concurrency implements the `expectedVersion` check: `put` uses `If-Match` against the last known ETag and translates S3's `PreconditionFailed` into noy-db's `ConflictError`. Implements every mandatory method on `NoydbAdapter` (`get`, `put`, `delete`, `list`, `loadAll`, `saveAll`) plus the optional `listPage` pagination capability (cursor is the S3 `ContinuationToken`).

Zero-knowledge property: S3 bucket owners, IAM role holders, and anyone with `s3:GetObject` on the bucket see only encrypted envelopes. The DEKs required to decrypt any record live exclusively in the user's in-memory keyring.

Peer dependencies: `@aws-sdk/client-s3 ^3.0.0`.
