# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

NOYDB ("None Of Your Damn Business") is a zero-knowledge, offline-first, encrypted document store with pluggable backends and multi-user access control. It is a TypeScript monorepo targeting Node.js 18+ and modern browsers.

The primary spec is `NOYDB_SPEC.md` — read it before any non-trivial work. It is the source of truth for all design decisions.

**Status:** All 5 phases implemented. Core, all adapters (memory, file, dynamo, s3, browser), sync engine, Vue composables, biometric auth, session management. Ready for testing and npm publish.

## Architecture

**Memory-first design:** All data is loaded into memory on open. Queries use `Array.filter()`/`Array.find()`. Target scale: 1K-50K records per compartment.

**Key hierarchy:** Passphrase → PBKDF2 (600K iterations) → KEK (in-memory only) → unwraps DEKs (one per collection) → AES-256-GCM encrypt/decrypt records.

**Data flow:** Application → Permission check → Crypto layer (encrypt with DEK + random IV) → Adapter (sees only ciphertext). Adapters never see plaintext.

**Core abstractions:**
- **Noydb** — top-level instance from `createNoydb()`, holds auth context and adapter refs
- **Compartment** — tenant/company namespace, has its own keyrings
- **Collection\<T\>** — typed record set within a compartment, has its own DEK
- **Keyring** — per-user, per-compartment file with role, permissions, and wrapped DEKs
- **Adapter** — 6-method interface: `get`, `put`, `delete`, `list`, `loadAll`, `saveAll`

## Monorepo Structure

```
packages/
  core/     # @noy-db/core — createNoydb, Compartment, Collection, crypto, keyring, sync
  file/     # @noy-db/file — JSON file adapter (USB, local disk)
  dynamo/   # @noy-db/dynamo — DynamoDB single-table adapter
  s3/       # @noy-db/s3 — S3 adapter
  memory/   # @noy-db/memory — in-memory adapter (testing)
  browser/  # @noy-db/browser — localStorage/IndexedDB adapter
  vue/      # @noy-db/vue — Vue/Nuxt composables (useNoydb, useCollection, useSync)
```

Build tooling: Turbo for orchestration, Vitest for tests, ESM primary + CJS secondary output, full `.d.ts` generation.

## Build & Test Commands

```bash
pnpm install                         # install all workspace deps
pnpm turbo build                     # build all packages
pnpm turbo test                      # run all tests
pnpm turbo lint                      # lint all packages
pnpm turbo typecheck                 # typecheck all packages
pnpm vitest run                      # run tests (alternative)
pnpm vitest run packages/core        # run tests for a single package
pnpm vitest run -t "encrypt"         # run tests matching a pattern
```

## Implementation Order

Build in this sequence (each phase produces a usable library):

1. **Phase 1 (MVP):** `@noydb/core` (createNoydb, Compartment, Collection, crypto) + `@noydb/memory` + `@noydb/file`. Single-user owner mode only. No sync. Include dump/load.
2. **Phase 2 (Multi-User):** Keyring management, grant/revoke/rotate, role-based permission checks.
3. **Phase 3 (Sync):** Dirty tracking, push/pull, conflict detection, `@noydb/dynamo`.
4. **Phase 4 (Browser):** `@noydb/browser`, WebAuthn biometric, `@noydb/vue`, auto-sync.
5. **Phase 5 (Polish):** `@noydb/s3`, passphrase strength validation, session timeout, CLI.

## Critical Invariants

- **Zero crypto dependencies.** All cryptography uses Web Crypto API (`crypto.subtle`). Never add npm crypto packages.
- **AES-256-GCM** with fresh random 12-byte IV per encrypt operation. Never reuse IVs.
- **PBKDF2-SHA256** with 600,000 iterations for key derivation. Do not lower this.
- **AES-KW (RFC 3394)** for wrapping DEKs with KEK.
- **KEK never persisted.** It exists only in memory during an active session.
- **Adapters only see ciphertext.** Encryption happens in core before data reaches any adapter.
- **Envelope format:** `{ _noydb: 1, _v, _ts, _iv, _data }` — `_v` and `_ts` are unencrypted (sync engine needs them without keys).
- **Optimistic concurrency** via `_v` (version number). Adapters must support `expectedVersion` checks.

## Encrypted Record Envelope

```json
{ "_noydb": 1, "_v": 3, "_ts": "2026-04-04T10:00:00.000Z", "_iv": "<base64>", "_data": "<base64 ciphertext>" }
```

## Adapter Interface

All adapters implement exactly 6 async methods:
`get(compartment, collection, id)`, `put(compartment, collection, id, envelope, expectedVersion?)`, `delete(compartment, collection, id)`, `list(compartment, collection)`, `loadAll(compartment)`, `saveAll(compartment, data)`

## Roles & Permissions

| Role | Permissions | Can Grant/Revoke | Can Export |
|------|------------|:----------------:|:---------:|
| owner | `*: rw` | Yes (all) | Yes |
| admin | `*: rw` | Yes (admin, operator, viewer, client — v0.5 #62; cascade on revoke) | Yes |
| operator | Explicit collections: rw | No | ACL-scoped (v0.5 #72) |
| viewer | `*: ro` | No | Yes |
| client | Explicit collections: ro | No | ACL-scoped (v0.5 #72) |

## Testing Strategy

- Unit tests with `@noydb/memory` adapter (crypto, keyring, permissions)
- Integration tests with `@noydb/file` on temp directories
- DynamoDB tests with DynamoDB Local (Docker) in CI
- Security tests: wrong key rejection, tamper detection, revoked user lockout after rotation
- Edge cases: empty compartments, concurrent writes, 1MB+ records, Unicode/Thai text, corrupt files

## First Consumer

An established regional accounting firm platform. Compartments = companies, collections = invoices/payments/disbursements/clients. USB stick workflow via file adapter, cloud via DynamoDB. Vue/Nuxt frontend with Pinia stores.
