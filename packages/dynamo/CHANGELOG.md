# @noy-db/dynamo

## 0.3.0

### Minor Changes

- Implement the optional `listPage` adapter capability (closes #14). Cursor format: base64-encoded `LastEvaluatedKey` (Buffer-free for browser/edge runtimes).

## 0.2.0

### Minor Changes

- Versioned in lockstep with `@noy-db/core@0.2.0` (privacy cleanup + release-pipeline hardening, no API changes in this package).

Previous `0.1.x` versions have been deprecated on npm. Please install `>=0.2.0`.

### Patch Changes

- Updated dependencies
  - @noy-db/core@0.2.0

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

- Updated dependencies
  - @noy-db/core@0.1.1

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

### Patch Changes

- Updated dependencies
  - @noy-db/core@0.1.0
