# @noy-db/core

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
