# @noy-db/core

## 0.4.1

### Patch Changes

- **Peer dep fix**: changed `peerDependencies` spec from `workspace:*` to `workspace:^` so published packages accept any semver-compatible `@noy-db/*` version rather than pinning to the exact version the workspace was built against. Without this fix, installing `@noy-db/core@0.4.0` alongside `@noy-db/memory@0.3.0` produced an `ERESOLVE` error because memory's peer dep was published as the literal `"0.3.0"` string.

- **Version line unified**: every `@noy-db/*` package is now on the **0.4.1** line. Previously the line was mixed (core/pinia on 0.4.0, adapters on 0.3.0, vue on 0.2.0, create on 0.3.2). No functional code changes — this is a manifest-only release to make v0.4 actually installable.

## 0.4.0

### Minor Changes — Integrity & trust

The v0.4 release adds the **integrity** layer on top of v0.3's adoption surface. Five new features land together; every record can now be schema-validated, every mutation is recorded in a tamper-evident hash-chained ledger, history is delta-encoded for storage efficiency, soft FK references are enforceable per-collection, and backups verify end-to-end on load.

- **Schema validation via Standard Schema v1** (#42). Attach any [Standard Schema v1](https://standardschema.dev) validator (Zod, Valibot, ArkType, Effect Schema) to a `Collection` or `defineNoydbStore`. Validation runs **before encryption on `put()`** (rejecting bad input with the validator's full issue list) and **after decryption on every read** (catching stored data that has drifted from the current schema). New exports: `StandardSchemaV1`, `StandardSchemaV1Issue`, `InferOutput`, `validateSchemaInput`, `validateSchemaOutput`, `SchemaValidationError`. History reads (`getVersion`, `history`) intentionally skip validation.

- **Hash-chained audit log (the ledger)** (#43). Every `Collection.put` and `Collection.delete` appends an encrypted entry to the compartment's `_ledger/` internal collection. Entries are linked by `prevHash = sha256(canonicalJson(previousEntry))` so any tampering breaks the chain. `payloadHash` is over the **encrypted** envelope, not plaintext, preserving zero-knowledge. `Compartment.ledger()` returns a `LedgerStore` with `head()`, `entries({ from, to })`, `verify()`, `loadAllEntries()`. New exports: `LedgerStore`, `LedgerEntry`, `VerifyResult`, `AppendInput`, `LEDGER_COLLECTION`, `canonicalJson`, `sha256Hex`, `hashEntry`, `paddedIndex`, `parseIndex`, `envelopePayloadHash`. Side fix: `grant()` now propagates ALL system-prefixed collection DEKs (`_ledger`, `_history`, `_sync`) to every grant target so operators with write access on a single collection can append to the shared ledger.

- **Delta history via RFC 6902 JSON Patch** (#44). Every put after the genesis computes a **reverse** JSON Patch from the new record to the previous version and stores it in `_ledger_deltas/`. New `LedgerStore.reconstruct(collection, id, current, atVersion)` walks the chain backward from the current state, applying reverse patches to rebuild any historical version. Storage scales with edit size, not record size — a 1 KB record edited 100 times costs ~1 KB of deltas, not 100 KB of snapshots. Hand-rolled JSON Patch implementation (subset: add/remove/replace; arrays atomic; RFC 6902 path escaping); zero deps. New exports: `JsonPatch`, `JsonPatchOp`, `computePatch`, `applyPatch`, `LEDGER_DELTAS_COLLECTION`. Known limitation: ambiguous across delete+recreate cycles because version counters reset.

- **Foreign-key references via `ref()`** (#45). Soft FK enforcement at the collection level. Three modes: **`strict`** (default — put rejects missing target, delete of target rejects with referencing records), **`warn`** (both succeed, `checkIntegrity()` surfaces orphans), **`cascade`** (delete of target propagates with cycle-safe termination). New exports: `ref(target, mode?)`, `RefRegistry`, `RefIntegrityError`, `RefScopeError`, `RefMode`, `RefDescriptor`, `RefViolation`. New method: `Compartment.checkIntegrity()`. Cross-compartment refs rejected at construction with `RefScopeError`.

- **Verifiable backups** (#46). `dump()` embeds the current ledger head + the full `_ledger` and `_ledger_deltas` internal collections so the receiver can replay the chain. `load()` re-runs verification after restoring and rejects any backup whose chain or data has been tampered with. New `Compartment.verifyBackupIntegrity()` method runs both `ledger.verify()` AND a data envelope cross-check (recomputes `payloadHash` for every current record and compares to the latest matching ledger entry) — catches three independent attack surfaces: chain tampering, ciphertext substitution, and out-of-band writes that bypassed `Collection.put`. New exports: `BackupLedgerError`, `BackupCorruptedError`. Backwards compat: pre-v0.4 backups load with a console warning and skip the integrity check.

  **Side fix**: encrypted dump→load round-trips work for the first time. The old `load()` restored a different keyring file but the in-memory `Compartment.keyring` still held the pre-load session's DEKs. New `reloadKeyring` callback wired through Noydb → Compartment refreshes the in-memory keyring from the freshly-loaded keyring file using the active user's passphrase.

### Stats

- 376 tests in `@noy-db/core` (was 269 at v0.3 ship); +107 across the v0.4 epic
- 654 tests across the monorepo
- Zero new runtime dependencies — Standard Schema and JSON Patch are both vendored as types-only / hand-rolled

## 0.3.0

### Minor Changes

- **Reactive query DSL** (closes #12). New `collection.query()` returns a chainable `Query<T>` builder with operators `==`, `!=`, `<`, `<=`, `>`, `>=`, `in`, `contains`, `startsWith`, `between`, plus a `.filter(fn)` escape hatch and `.and()`/`.or()` composition. Terminal methods: `.toArray()`, `.first()`, `.count()`, `.subscribe()`, `.toPlan()`. Plans are JSON-serializable for devtools and Web Worker offloading. All filtering runs client-side after decryption — preserves zero-knowledge. The legacy predicate form `collection.query(fn)` is still supported as an overload for backward compatibility.

- **Secondary indexes** (closes #13). Declare indexes per-collection via `indexes: ['status', 'clientId']`. Built client-side from decrypted records, kept in memory only. The query planner uses them to turn equality and `in` clauses into O(1) hash lookups, then filters the candidate set for the remaining clauses. Benchmark: 4–6× speedup vs linear scan on a 10K-record collection. No plaintext indexes ever touch the adapter.

- **Pagination via `listPage` + streaming `scan()`** (closes #14). New optional `listPage` adapter capability for cursor-based pagination. `Collection.scan()` returns an `AsyncIterableIterator<T>` for memory-bounded iteration over very large collections — bypasses the LRU entirely, peak memory under 200 MB on a 100K-record collection.

- **Lazy hydration + LRU eviction** (closes #15). New `cache: { maxRecords, maxBytes }` collection option enables lazy mode: `get(id)` hits the adapter on miss and populates an LRU; `list()` and `query()` throw (use `scan()` or `loadMore()`); declaring `indexes` is rejected at construction. `prefetch: true` restores the v0.2 eager behavior. Eviction is O(1) via `Map` + delete/set promotion. Cache budgets accept `'50MB'`, `'2GB'`, or a number of bytes.

- Docs sweep — getting-started, end-user-features, architecture, adapters, deployment-profiles, and the README all updated with v0.3 examples. Bug fix: 80+ stale `@noydb/*` references corrected to `@noy-db/*`.

## 0.2.0

### Minor Changes

- Add brand logo SVG to main README
- Remove all references to the private client firm name from docs, playgrounds, and examples (replaced with generic accounting-firm terminology)
- Add privacy-guard script and wire it into CI and the release workflow
- Fix all pre-existing CI lint and typecheck failures
- Relax ESLint rules that produced false positives on web-API boundary code

Previous `0.1.x` versions have been deprecated on npm. Please install `>=0.2.0`.

## 0.1.1

### Patch Changes

- Align folder names with npm package names and bring metadata to state-of-the-art quality.

  **Folder rename (no code changes):**

  - `packages/adapter-browser` → `packages/browser`
  - `packages/adapter-dynamo` → `packages/dynamo`
  - `packages/adapter-file` → `packages/file`
  - `packages/adapter-memory` → `packages/memory`
  - `packages/adapter-s3` → `packages/s3`

  **package.json metadata improvements:**

  - Added `author`, `homepage`, `bugs` fields to every package
  - Added `sideEffects: false` for proper tree-shaking
  - Added comprehensive `keywords` to every package (previously only `@noy-db/core` had any)
  - Fixed descriptions — replaced "NOYDB" with "noy-db"
  - Fixed all `repository.directory` paths after folder rename
  - Fixed `homepage` URLs — previously pointed to the old `noydb` repo

  **New per-package READMEs:**
  Every published package now ships with its own `README.md` and `LICENSE`, so npmjs.com displays proper documentation instead of a blank page.

  **GitHub Actions:**

  - Release workflow now supports two paths: changesets-driven (push to main) and release-event-driven (manual GitHub Release)
  - Publishes now include npm provenance attestations for supply-chain verification
  - `createGithubReleases: true` enabled on the changesets action

  No API or runtime behavior changes.

## 0.1.0

### Minor Changes

- Initial public release of NOYDB — zero-knowledge encrypted document store.

  Features:

  - AES-256-GCM encryption with PBKDF2 key derivation (600K iterations)
  - 5 storage adapters: memory, file, DynamoDB, S3, browser (localStorage/IndexedDB)
  - Multi-user access control with 5 roles (owner, admin, operator, viewer, client)
  - Offline-first sync engine with 4 conflict strategies
  - Audit history with version tracking, diff, revert, and pruning
  - Vue/Nuxt composables (useNoydb, useCollection, useSync)
  - WebAuthn biometric authentication
  - Session timeout and passphrase validation
  - Browser key obfuscation (no plaintext in localStorage)
  - Zero runtime dependencies across all packages
