# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

NOYDB ("None Of Your Damn Business") is a zero-knowledge, offline-first, encrypted document store with pluggable backends and multi-user access control. It is a TypeScript monorepo targeting Node.js 18+ and modern browsers.

The primary spec is `SPEC.md` — read it before any non-trivial work. It is the source of truth for all design decisions. Complementary docs:
- `ROADMAP.md` — version timeline, current milestone, deferred work
- `HANDOVER.md` — session-to-session handover notes (recent state, what's in flight)
- `docs/architecture.md` — reader-facing data flow and threat model
- `docs/v0.6/` — v0.6 release notes draft, merge runbook, retrospective

**Status:** v0.6.0 on npm (2026-04-09). All 10 `@noy-db/*` packages on the 0.6.0 version line. Full v0.5 surface (core, all adapters, sync, Vue/Nuxt/Pinia, scaffolder + CLI) **plus** the v0.6 query DSL completion (joins, aggregations, streaming scan) and the `.noydb` container format. 558/558 core tests passing.

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
| admin | `*: rw` | Yes (admin, operator, viewer, client; cascade on revoke) | Yes |
| operator | Explicit collections: rw | No | ACL-scoped |
| viewer | `*: ro` | No | Yes |
| client | Explicit collections: ro | No | ACL-scoped |

## Query DSL (v0.3 core + v0.6 completion)

The chainable builder is the preferred surface — terminals are `.toArray()`, `.first()`, `.count()`, `.subscribe(cb)`, `.live()`, `.aggregate(spec)`, `.groupBy(field)`.

```ts
// Eager join (#73) — indexed nested-loop or hash strategy
invoices.query().join<'client', Client>('clientId', { as: 'client' }).toArray()

// Multi-FK chaining (#75)
.join('clientId', { as: 'client' }).join('categoryId', { as: 'category' })

// Reactive (#74) — merged change-streams across every join target
const live = invoices.query().join(...).live()
live.subscribe(() => render(live.value)); live.stop()

// Aggregations (#97, #98)
import { count, sum, avg, min, max } from '@noy-db/core'
invoices.query().where(...).aggregate({ total: sum('amount'), n: count() }).run()
invoices.query().groupBy('clientId').aggregate({ total: sum('amount') }).run()

// Streaming (#76, #99) — Collection.scan() returns ScanBuilder<T>
for await (const r of invoices.scan()) { ... }  // backward-compat
await invoices.scan().join('clientId', { as: 'client' }).aggregate({ n: count() })
```

**Row ceilings:** joins throw `JoinTooLargeError` at 50k per side (override via `{ maxRows }`); groupBy warns at 10k groups and throws `GroupCardinalityError` at 100k. `scan().aggregate()` has O(reducers) memory, no ceiling.

**Ref-mode dispatch** on dangling refs (`strict` throws, `warn` attaches null + one-shot warn, `cascade` attaches null silently) is identical for eager and streaming joins.

**#87 partition-awareness seams** are plumbed but dormant: every `JoinLeg` carries `partitionScope: 'all'` and every reducer factory accepts a `{ seed }` parameter. Do not remove either — they're load-bearing for v0.10 partition-aware execution and will silently break the future work if dropped. Tests in `query-aggregate.test.ts` and `query-join.test.ts` pin the no-op behavior.

## `.noydb` Container Format (v0.6 #100)

Binary wrapper around `compartment.dump()` for safe cloud storage drops. `writeNoydbBundle(compartment)` / `readNoydbBundle(bytes)` / `readNoydbBundleHeader(bytes)` primitives in core; `saveBundle(path, compartment)` / `loadBundle(path)` helpers in `@noy-db/file`. 10-byte fixed prefix (`NDB1` magic + flags + compression + header length uint32 BE) then JSON header (minimum disclosure: `formatVersion`, `handle`, `bodyBytes`, `bodySha256` — every other key rejected at parse time), then compressed body (brotli with gzip fallback via `CompressionStream` feature detection). ULID handles via `compartment.getBundleHandle()` persist in a reserved `_meta/handle` envelope that bypasses AES-GCM the same way `_keyring` does.

## Peer-dep convention (v0.6+)

All adapter packages use `"@noy-db/core": "workspace:*"` in `peerDependencies` (NOT `"workspace:^"`). This prevents the changeset-cli pre-1.0 dep-propagation heuristic from computing major bumps on dependent packages when `@noy-db/core` bumps minor. The looser constraint is safe because the monorepo ships all packages in lockstep — consumers always install matching versions. Do not revert to `workspace:^` or the next minor release will trip the same changeset bug. See `docs/v0.6/retrospective.md` for the full diagnosis.

## Testing Strategy

- Unit tests with `@noydb/memory` adapter (crypto, keyring, permissions)
- Integration tests with `@noydb/file` on temp directories
- DynamoDB tests with DynamoDB Local (Docker) in CI
- Security tests: wrong key rejection, tamper detection, revoked user lockout after rotation
- Edge cases: empty compartments, concurrent writes, 1MB+ records, Unicode/Thai text, corrupt files

## First Consumer

An established regional accounting firm platform. Compartments = companies, collections = invoices/payments/disbursements/clients. USB stick workflow via file adapter, cloud via DynamoDB. Vue/Nuxt frontend with Pinia stores.
