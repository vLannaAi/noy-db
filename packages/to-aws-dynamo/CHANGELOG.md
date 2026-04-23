# @noy-db/dynamo

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

AWS DynamoDB adapter for `@noy-db/core` — single-table design, zero-knowledge cloud sync. Intended for multi-device workloads where the cloud provides the sync substrate and `noy-db`'s encryption ensures DynamoDB only ever sees ciphertext.

Single-table schema: one DynamoDB table per `Noydb` instance, with a composite primary key `(compartment#collection, id)` so every compartment's data lives in the same table with natural partition boundaries. Implements every mandatory method on `NoydbAdapter` (`get`, `put`, `delete`, `list`, `loadAll`, `saveAll`) plus the optional `listPage` pagination capability (cursor is a base64-encoded `LastEvaluatedKey` JSON) and `ping` for connectivity checks.

Zero-knowledge property: DynamoDB admins, IAM role holders, and anyone with `dynamodb:GetItem` on the table see only encrypted envelopes. The DEKs required to decrypt any record live exclusively in the user's in-memory keyring, wrapped by their KEK which is derived from their passphrase via PBKDF2.

Peer dependencies: `@aws-sdk/client-dynamodb ^3.0.0`, `@aws-sdk/lib-dynamodb ^3.0.0`.
