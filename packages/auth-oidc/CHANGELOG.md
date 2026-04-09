# @noy-db/auth-oidc

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

### Minor Changes

- bbf13ff: **New package: `@noy-db/auth-oidc` (#112)** — OAuth/OIDC bridge with
  Bitwarden-style split-key connector. The KEK is XOR-split into a `serverHalf`
  (held by the key-connector endpoint) and a `deviceHalf` (in the browser); the
  server never sees the full KEK.

  Key features:

  - `enrollOidc` / `unlockOidc` round-trip using PKCE + id_token.
  - Built-in `knownProviders.line()`, `knownProviders.google()`,
    `knownProviders.apple()` factory helpers.
  - `parseIdTokenClaims` / `isIdTokenExpired` utilities.
  - Errors: `OidcTokenError`, `KeyConnectorError`,
    `OidcDeviceSecretNotFoundError`.

  Exports: `enrollOidc`, `unlockOidc`, `knownProviders`, `parseIdTokenClaims`,
  `isIdTokenExpired` and types `OidcProviderConfig`, `OidcEnrollment`,
  `OidcEnrollOptions`, `OidcUnlockOptions`.

### Patch Changes

- Updated dependencies [2d38d62]
- Updated dependencies [2d38d62]
- Updated dependencies [2d38d62]
- Updated dependencies [2d38d62]
- Updated dependencies [2d38d62]
  - @noy-db/core@0.7.0
