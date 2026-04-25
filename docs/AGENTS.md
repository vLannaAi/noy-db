# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## Project Overview

NOYDB ("None Of Your Damn Business") is a zero-knowledge, offline-first, encrypted document store with pluggable backends and multi-user access control. It is a TypeScript monorepo targeting Node.js 18+ and modern browsers.

The primary spec is `SPEC.md` — read it before any non-trivial work. It is the source of truth for all design decisions. Complementary docs:
- `ROADMAP.md` — version timeline and open work
- `docs/reference/architecture.md` — reader-facing data flow and threat model
- `docs/packages/{to-stores,in-integrations,on-auth,as-exports}.md` — catalog pages for the four prefix families

**Status:** foundation epoch complete. 56 packages shipped across 4 prefixed families (`hub`, `to-*`, `in-*`, `on-*`, `as-*`). npm paused — publishing will be coordinated. Fork milestones remain open for ongoing satellite work.

## Architecture

**Memory-first design:** All data is loaded into memory on open. Queries use `Array.filter()`/`Array.find()`. Target scale: 1K–50K records per vault.

**Key hierarchy:** Passphrase → PBKDF2 (600K iterations) → KEK (in-memory only) → unwraps DEKs (one per collection) → AES-256-GCM encrypt/decrypt records.

**Data flow:** Application → Permission check → Crypto layer (encrypt with DEK + random IV) → Store (sees only ciphertext). Stores never see plaintext.

**Core abstractions:**
- **Noydb** — top-level instance from `createNoydb()`, holds auth context and store refs
- **Vault** — tenant/company namespace, has its own keyrings
- **Collection\<T\>** — typed record set within a vault, has its own DEK
- **Keyring** — per-user, per-vault file with role, permissions, and wrapped DEKs
- **Store** — 6-method interface: `get`, `put`, `delete`, `list`, `loadAll`, `saveAll`

## Monorepo Structure

```
packages/
  hub/                   # @noy-db/hub — core (+ i18n/store/team/session/history/query subpath exports)
    src/
      i18n/              # dictKey + i18nText + resolveI18nText (multi-locale)
      store/             # routeStore + wrapStore + middleware + bundle-store + blob-set + mime-magic + sync-policy
      team/              # sync engine + keyring + grant/revoke/rotate + sync-credentials + presence
      session/           # session tokens + policy enforcement + dev-unlock
      history/           # record-version history + diff + hash-chained ledger + JSON Patch
      query/             # query builder + joins + aggregates + groupBy + live + scan
      bundle/            # .noydb bundle format (encrypted backup/restore)
      cache/             # LRU primitive
      (root .ts files: createNoydb, Vault, Collection, crypto, errors, types, refs, schema, …)

  # STORES (20 packages) — storage destinations, NoydbStore / NoydbBundleStore contract
  to-memory/             # in-memory (testing)
  to-file/               # JSON file (USB, local disk)
  to-browser-local/      # localStorage
  to-browser-idb/        # IndexedDB (atomic CAS)
  to-aws-dynamo/         # DynamoDB single-table
  to-aws-s3/             # S3 object store
  to-cloudflare-r2/      # R2 (S3-compatible, zero egress)
  to-cloudflare-d1/      # D1 (edge SQLite via Workers)
  to-supabase/           # Supabase Postgres
  to-postgres/           # node-postgres + jsonb column
  to-mysql/              # mysql2 + JSON column
  to-sqlite/             # better-sqlite3 / node:sqlite / bun:sqlite
  to-turso/              # hosted libSQL (replicated SQLite)
  to-webdav/             # pure fetch(); Nextcloud/ownCloud
  to-ssh/                # SFTP, public-key auth only
  to-smb/                # SMB/CIFS, NTLM or Kerberos
  to-nfs/                # NFS mount with diagnostic pre-flight
  to-icloud/             # iCloud Drive (.icloud stub handling)
  to-drive/              # Google Drive (bundle + appDataFolder)
  to-probe/              # diagnostic companion, not a backend
  to-meter/              # pass-through metrics wrapper

  # INTEGRATIONS (10 packages) — framework bindings, NOT storage
  in-vue/                # Vue 3 composables
  in-pinia/              # Pinia store
  in-nuxt/               # Nuxt 4 module
  in-yjs/                # Yjs Y.Doc interop
  in-react/              # React hooks
  in-nextjs/             # Next.js App Router helpers
  in-svelte/             # zero-dep Svelte stores
  in-zustand/            # Zustand StateCreator factory
  in-tanstack-query/     # framework-free query options
  in-tanstack-table/     # TanStack Table ↔ Query DSL bridge
  in-ai/                 # LLM function-calling adapter

  # ON (9 packages) — authentication / unlock paths, "on-" as in "log-on"
  on-webauthn/           # passkeys + WebAuthn PRF
  on-oidc/               # OAuth / OIDC split-key
  on-magic-link/         # one-shot viewer session
  on-recovery/           # printable recovery codes
  on-shamir/             # k-of-n secret sharing
  on-totp/               # TOTP (RFC 6238)
  on-email-otp/          # email OTP with transport abstraction
  on-pin/                # session-resume PIN
  on-threat/             # lockout + duress + honeypot triad

  # AS (9 packages) — portable-artefact exports, two-tier authorization
  as-csv/                # plaintext, canExportPlaintext['csv']
  as-xlsx/               # Excel with dict-label expansion
  as-json/               # structured JSON grouped by collection
  as-ndjson/             # newline-delimited streaming JSON
  as-xml/                # legacy / enterprise software
  as-sql/                # postgres / mysql / sqlite dumps
  as-blob/               # single-attachment plaintext
  as-zip/                # composite record+blob archive
  as-noydb/              # encrypted .noydb bundle (canExportBundle)

  # P2P / tooling / scaffolder
  p2p/                   # WebRTC peer-to-peer sync
  cli/                   # command-line operations
  create-noy-db/         # npm create noy-db (unscoped)
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
pnpm vitest run packages/hub         # run tests for a single package
pnpm vitest run -t "encrypt"         # run tests matching a pattern
```

## Critical Invariants

- **Zero crypto dependencies.** All cryptography uses Web Crypto API (`crypto.subtle`). Never add npm crypto packages.
- **AES-256-GCM** with fresh random 12-byte IV per encrypt operation. Never reuse IVs.
- **PBKDF2-SHA256** with 600,000 iterations for key derivation. Do not lower this.
- **AES-KW (RFC 3394)** for wrapping DEKs with KEK.
- **KEK never persisted.** It exists only in memory during an active session.
- **Stores only see ciphertext.** Encryption happens in core before data reaches any store.
- **Envelope format:** `{ _noydb: 1, _v, _ts, _iv, _data }` — `_v` and `_ts` are unencrypted (sync engine needs them without keys).
- **Optimistic concurrency** via `_v` (version number). Stores must support `expectedVersion` checks.

## Encrypted Record Envelope

```json
{ "_noydb": 1, "_v": 3, "_ts": "2026-04-04T10:00:00.000Z", "_iv": "<base64>", "_data": "<base64 ciphertext>" }
```

## Store Interface

All stores implement `NoydbStore` — exactly 6 async methods:
`get(vault, collection, id)`, `put(vault, collection, id, envelope, expectedVersion?)`, `delete(vault, collection, id)`, `list(vault, collection)`, `loadAll(vault)`, `saveAll(vault, data)`

Use `createStore()` to define custom stores:

```ts
import { createStore } from '@noy-db/hub'
export const myStore = createStore((options: MyOptions) => ({ name: 'my-backend', ...methods }))
```

`StoreCapabilities` includes:

```ts
interface StoreCapabilities {
  casAtomic: boolean  // true = atomic CAS at the storage layer
  auth: StoreAuth     // authentication kind/flow metadata
}
```

`casAtomic` per built-in store: `to-memory` true, `to-file` false, `to-browser-local` true, `to-browser-idb` true (single readwrite IDB transaction), `to-aws-dynamo` true (ConditionExpression), `to-aws-s3` false.

`StoreCapabilityError` (code `'STORE_CAPABILITY'`) surfaces missing optional store methods.

## Roles & Permissions

| Role | Permissions | Can Grant/Revoke | Can Export |
|------|------------|:----------------:|:---------:|
| owner | `*: rw` | Yes (all) | Yes |
| admin | `*: rw` | Yes (admin, operator, viewer, client; cascade on revoke) | Yes |
| operator | Explicit collections: rw | No | ACL-scoped |
| viewer | `*: ro` | No | Yes |
| client | Explicit collections: ro | No | ACL-scoped |

## Query DSL

The chainable builder is the preferred surface — terminals are `.toArray()`, `.first()`, `.count()`, `.subscribe(cb)`, `.live()`, `.aggregate(spec)`, `.groupBy(field)`.

```ts
// Eager join — indexed nested-loop or hash strategy
invoices.query().join<'client', Client>('clientId', { as: 'client' }).toArray()

// Multi-FK chaining
.join('clientId', { as: 'client' }).join('categoryId', { as: 'category' })

// Reactive — merged change-streams across every join target
const live = invoices.query().join(...).live()
live.subscribe(() => render(live.value)); live.stop()

// Aggregations
import { count, sum, avg, min, max } from '@noy-db/hub'
invoices.query().where(...).aggregate({ total: sum('amount'), n: count() }).run()
invoices.query().groupBy('clientId').aggregate({ total: sum('amount') }).run()

// Streaming — Collection.scan() returns ScanBuilder<T>
for await (const r of invoices.scan()) { ... }
await invoices.scan().join('clientId', { as: 'client' }).aggregate({ n: count() })
```

**Row ceilings:** joins throw `JoinTooLargeError` at 50k per side (override via `{ maxRows }`); groupBy warns at 10k groups and throws `GroupCardinalityError` at 100k. `scan().aggregate()` has O(reducers) memory, no ceiling.

**Ref-mode dispatch** on dangling refs (`strict` throws, `warn` attaches null + one-shot warn, `cascade` attaches null silently) is identical for eager and streaming joins.

**Partition-awareness seams** are plumbed but dormant: every `JoinLeg` carries `partitionScope: 'all'` and every reducer factory accepts a `{ seed }` parameter. Do not remove either — they're load-bearing for future partition-aware execution and will silently break that work if dropped. Tests in `query-aggregate.test.ts` and `query-join.test.ts` pin the no-op behavior.

## `.noydb` Container Format

Binary wrapper around `vault.dump()` for safe cloud storage drops. `writeNoydbBundle(vault)` / `readNoydbBundle(bytes)` / `readNoydbBundleHeader(bytes)` primitives in core; `saveBundle(path, vault)` / `loadBundle(path)` helpers in `@noy-db/to-file`. 10-byte fixed prefix (`NDB1` magic + flags + compression + header length uint32 BE), then JSON header (minimum disclosure: `formatVersion`, `handle`, `bodyBytes`, `bodySha256` — every other key rejected at parse time), then compressed body (brotli with gzip fallback via `CompressionStream` feature detection). ULID handles via `vault.getBundleHandle()` persist in a reserved `_meta/handle` envelope that bypasses AES-GCM the same way `_keyring` does.

## Peer-dep convention

All store and auth packages (every `@noy-db/to-*`, `@noy-db/on-*`, `@noy-db/in-*`, `@noy-db/as-*`) use `"@noy-db/hub": "workspace:*"` in `peerDependencies` (NOT `"workspace:^"`). This prevents the changeset-cli pre-1.0 dep-propagation heuristic from computing major bumps on dependent packages when `@noy-db/hub` bumps minor. The looser constraint is safe because the monorepo ships all packages in lockstep — consumers always install matching versions. Do not revert to `workspace:^` or the next minor release will trip the same changeset bug.

## Testing Strategy

- Unit tests with `@noy-db/to-memory` store (crypto, keyring, permissions)
- Integration tests with `@noy-db/to-file` on temp directories
- DynamoDB tests with DynamoDB Local (Docker) in CI
- Security tests: wrong key rejection, tamper detection, revoked user lockout after rotation
- Edge cases: empty vaults, concurrent writes, 1MB+ records, Unicode text, corrupt files

## First Consumer

An established enterprise pilot platform. Vaults = companies, collections = invoices/payments/disbursements/clients. USB stick workflow via `to-file`, cloud via `to-aws-dynamo`. Vue/Nuxt frontend with Pinia stores.
