# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

NOYDB ("None Of Your Damn Business") is a zero-knowledge, offline-first, encrypted document store with pluggable backends and multi-user access control. It is a TypeScript monorepo targeting Node.js 18+ and modern browsers.

The primary spec is `SPEC.md` — read it before any non-trivial work. It is the source of truth for all design decisions. Complementary docs:
- `ROADMAP.md` — version timeline, current milestone, deferred work
- `HANDOVER.md` — session-to-session handover notes (recent state, what's in flight)
- `docs/architecture.md` — reader-facing data flow and threat model
- `docs/spec/INDEX.md` — **in-repo archive of every GitHub issue, milestone, discussion, and PR body.** The *why* behind each feature (spec rationale, trade-offs, rejected alternatives, merge history) is preserved here as markdown so GitHub can be pruned without losing institutional knowledge. For any package or feature, `grep -l "<package-name>" docs/spec/archive` finds the original issue(s) and `grep -l "<package-name>" docs/spec/prs` finds the merge PRs.
- `docs/packages/{stores,integrations,auth,exports}.md` — catalog pages for the four prefix families.

**Status:** foundation epoch complete (2026-04-23). 56 packages across 4 prefixed families (`hub`, `to-*`, `in-*`, `on-*`, `as-*`). npm paused — publishing will be coordinated. Trunk releases v0.3–v0.20 all shipped; advanced core includes hierarchical tiers (v0.18), deterministic encryption (v0.19), p2p sync (v0.20). Fork milestones remain open for ongoing satellite work: 7 issues open across Stores (4 niche), Integrations (2 priority: low), On (1 architectural follow-up). All previously closed issues pruned from GitHub but fully archived in `docs/spec/archive/` — grep it for rationale, acceptance criteria, and rejected alternatives.

## Architecture

**Memory-first design:** All data is loaded into memory on open. Queries use `Array.filter()`/`Array.find()`. Target scale: 1K-50K records per vault. Lazy mode (`cache: { maxRecords, maxBytes }`) fetches on demand via LRU; `list()`/`query()` throw in lazy mode — use `scan()`. Declaring `indexes` in lazy mode is **accepted as of v0.22** — side-car records in the `_idx/<field>/<recordId>` id namespace maintain the index. In v0.22 PR 1 (#265) this is scaffold only; PR 2 (#266) adds write-path maintenance, PR 3 (#267) + PR 4 (#268) wire up equality and orderBy dispatch.

**Key hierarchy:** Passphrase → PBKDF2 (600K iterations) → KEK (in-memory only) → unwraps DEKs (one per collection) → AES-256-GCM encrypt/decrypt records.

**Data flow:** Application → Permission check → Crypto layer (encrypt with DEK + random IV) → Store (sees only ciphertext). Stores never see plaintext.

**Core abstractions:**
- **Noydb** — top-level instance from `createNoydb()`, holds auth context and store refs
- **Vault** — tenant/company namespace, has its own keyrings (formerly `Compartment`)
- **Collection\<T\>** — typed record set within a vault, has its own DEK
- **Keyring** — per-user, per-vault file with role, permissions, and wrapped DEKs
- **Store** — 6-method interface: `get`, `put`, `delete`, `list`, `loadAll`, `saveAll` (formerly `Adapter`)

## Monorepo Structure

```
packages/
  hub/                   # @noy-db/hub (+ @noy-db/hub/{i18n,store,team,session,history,query} subpath exports, v0.15.1)
    src/
      i18n/              # dictKey + i18nText + resolveI18nText (multi-locale)
      store/             # routeStore + wrapStore + middleware + bundle-store + blob-set + mime-magic + sync-policy
      team/              # sync engine + keyring + grant/revoke/rotate + sync-credentials + presence
      session/           # session tokens + policy enforcement + dev-unlock (magic-link extracted to @noy-db/on-magic-link)
      history/           # record-version history + diff + hash-chained ledger + JSON Patch (ledger is nested)
      query/             # query builder + joins + aggregates + groupBy + live + scan
      bundle/            # .noydb bundle format (encrypted backup/restore)
      cache/             # LRU primitive
      (root .ts files: createNoydb, Vault, Collection, crypto, errors, types, refs, schema, …)
  # STORES (20 packages) — storage destinations, NoydbStore / NoydbBundleStore contract
  to-memory/             # @noy-db/to-memory           — in-memory (testing)
  to-file/               # @noy-db/to-file             — JSON file (USB, local disk)
  to-browser-local/      # @noy-db/to-browser-local    — localStorage
  to-browser-idb/        # @noy-db/to-browser-idb      — IndexedDB (atomic CAS)
  to-aws-dynamo/         # @noy-db/to-aws-dynamo       — DynamoDB single-table
  to-aws-s3/             # @noy-db/to-aws-s3           — S3 object store
  to-cloudflare-r2/      # @noy-db/to-cloudflare-r2    — R2 (S3-compatible, zero egress)
  to-cloudflare-d1/      # @noy-db/to-cloudflare-d1    — D1 (edge SQLite via Workers)
  to-supabase/           # @noy-db/to-supabase         — Supabase Postgres
  to-postgres/           # @noy-db/to-postgres         — node-postgres + jsonb column
  to-mysql/              # @noy-db/to-mysql            — mysql2 + JSON column
  to-sqlite/             # @noy-db/to-sqlite           — better-sqlite3 / node:sqlite / bun:sqlite
  to-turso/              # @noy-db/to-turso            — hosted libSQL (replicated SQLite)
  to-webdav/             # @noy-db/to-webdav           — pure fetch(); Nextcloud/ownCloud
  to-ssh/                # @noy-db/to-ssh              — SFTP, public-key auth only
  to-smb/                # @noy-db/to-smb              — SMB/CIFS, NTLM or Kerberos
  to-nfs/                # @noy-db/to-nfs              — NFS mount with diagnostic pre-flight
  to-icloud/             # @noy-db/to-icloud           — iCloud Drive (.icloud stub handling)
  to-drive/              # @noy-db/to-drive            — Google Drive (bundle + appDataFolder)
  to-probe/              # @noy-db/to-probe            — diagnostic companion, not a backend
  to-meter/              # @noy-db/to-meter            — pass-through metrics wrapper

  # INTEGRATIONS (10 packages) — framework bindings, NOT storage
  in-vue/                # @noy-db/in-vue              — Vue 3 composables
  in-pinia/              # @noy-db/in-pinia            — Pinia store
  in-nuxt/               # @noy-db/in-nuxt             — Nuxt 4 module
  in-yjs/                # @noy-db/in-yjs              — Yjs Y.Doc interop
  in-react/              # @noy-db/in-react            — React hooks
  in-nextjs/             # @noy-db/in-nextjs           — Next.js App Router helpers
  in-svelte/             # @noy-db/in-svelte           — zero-dep Svelte stores
  in-zustand/            # @noy-db/in-zustand          — Zustand StateCreator factory
  in-tanstack-query/     # @noy-db/in-tanstack-query   — framework-free query options
  in-tanstack-table/     # @noy-db/in-tanstack-table   — TanStack Table ↔ Query DSL bridge
  in-ai/                 # @noy-db/in-ai               — LLM function-calling adapter

  # ON (9 packages) — authentication / unlock paths, "on-" as in "log-on"
  on-webauthn/           # @noy-db/on-webauthn         — passkeys + WebAuthn PRF
  on-oidc/               # @noy-db/on-oidc             — OAuth / OIDC split-key
  on-magic-link/         # @noy-db/on-magic-link       — one-shot viewer session
  on-recovery/           # @noy-db/on-recovery         — printable recovery codes
  on-shamir/             # @noy-db/on-shamir           — k-of-n secret sharing
  on-totp/               # @noy-db/on-totp             — TOTP (RFC 6238)
  on-email-otp/          # @noy-db/on-email-otp        — email OTP with transport abstraction
  on-pin/                # @noy-db/on-pin              — session-resume PIN
  on-threat/             # @noy-db/on-threat           — lockout + duress + honeypot triad

  # AS (9 packages) — portable-artefact exports, two-tier authorization
  as-csv/                # @noy-db/as-csv              — plaintext, canExportPlaintext['csv']
  as-xlsx/               # @noy-db/as-xlsx             — Excel with dict-label expansion
  as-json/               # @noy-db/as-json             — structured JSON grouped by collection
  as-ndjson/             # @noy-db/as-ndjson           — newline-delimited streaming JSON
  as-xml/                # @noy-db/as-xml              — legacy / accounting software
  as-sql/                # @noy-db/as-sql              — postgres / mysql / sqlite dumps
  as-blob/               # @noy-db/as-blob             — single-attachment plaintext
  as-zip/                # @noy-db/as-zip              — composite record+blob archive
  as-noydb/              # @noy-db/as-noydb            — encrypted .noydb bundle (canExportBundle)

  # P2P / tooling / scaffolder
  p2p/                   # @noy-db/p2p                 — WebRTC peer-to-peer sync
  cli/                   # @noy-db/cli                 — command-line operations
  create-noy-db/         # create-noy-db               — npm create noy-db (unscoped)
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
- **Stores only see ciphertext.** Encryption happens in core before data reaches any store.
- **Envelope format:** `{ _noydb: 1, _v, _ts, _iv, _data }` — `_v` and `_ts` are unencrypted (sync engine needs them without keys).
- **Optimistic concurrency** via `_v` (version number). Adapters must support `expectedVersion` checks.

## Encrypted Record Envelope

```json
{ "_noydb": 1, "_v": 3, "_ts": "2026-04-04T10:00:00.000Z", "_iv": "<base64>", "_data": "<base64 ciphertext>" }
```

## Store Interface

All stores implement `NoydbStore` (formerly `NoydbAdapter`) — exactly 6 async methods:
`get(vault, collection, id)`, `put(vault, collection, id, envelope, expectedVersion?)`, `delete(vault, collection, id)`, `list(vault, collection)`, `loadAll(vault)`, `saveAll(vault, data)`

Use `createStore()` (formerly `defineAdapter()`) to define custom stores:

```ts
import { createStore } from '@noy-db/hub'
export const myStore = createStore((options: MyOptions) => ({ name: 'my-backend', ...methods }))
```

`StoreCapabilities` (formerly `AdapterCapabilities`) now includes two new fields:

```ts
interface StoreCapabilities {
  casAtomic: boolean  // true = atomic CAS at the storage layer
  auth: StoreAuth     // authentication kind/flow metadata
}
```

`casAtomic` per built-in store: `to-memory` true, `to-file` false, `to-browser-local` true, `to-browser-idb` true (single readwrite IDB transaction — #139), `to-aws-dynamo` true (ConditionExpression), `to-aws-s3` false.

`StoreCapabilityError` (code `'STORE_CAPABILITY'`) replaces `AdapterCapabilityError`; `runStoreConformanceTests` replaces `runAdapterConformanceTests`.

`NoydbOptions.store` replaces `NoydbOptions.adapter`. `openVault()` / `listVaults()` replace `openCompartment()` / `listCompartments()`. `VaultSnapshot` / `VaultBackup` replace `CompartmentSnapshot` / `CompartmentBackup`.

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
import { count, sum, avg, min, max } from '@noy-db/hub'
invoices.query().where(...).aggregate({ total: sum('amount'), n: count() }).run()
invoices.query().groupBy('clientId').aggregate({ total: sum('amount') }).run()

// Streaming (#76, #99) — Collection.scan() returns ScanBuilder<T>
for await (const r of invoices.scan()) { ... }  // backward-compat
await invoices.scan().join('clientId', { as: 'client' }).aggregate({ n: count() })
```

**Row ceilings:** joins throw `JoinTooLargeError` at 50k per side (override via `{ maxRows }`); groupBy warns at 10k groups and throws `GroupCardinalityError` at 100k. `scan().aggregate()` has O(reducers) memory, no ceiling.

**Ref-mode dispatch** on dangling refs (`strict` throws, `warn` attaches null + one-shot warn, `cascade` attaches null silently) is identical for eager and streaming joins.

**#87 partition-awareness seams** are plumbed but dormant: every `JoinLeg` carries `partitionScope: 'all'` and every reducer factory accepts a `{ seed }` parameter. Do not remove either — they're load-bearing for v0.11 partition-aware execution and will silently break the future work if dropped. Tests in `query-aggregate.test.ts` and `query-join.test.ts` pin the no-op behavior.

## `.noydb` Container Format (v0.6 #100)

Binary wrapper around `vault.dump()` for safe cloud storage drops. `writeNoydbBundle(vault)` / `readNoydbBundle(bytes)` / `readNoydbBundleHeader(bytes)` primitives in core; `saveBundle(path, vault)` / `loadBundle(path)` helpers in `@noy-db/to-file`. 10-byte fixed prefix (`NDB1` magic + flags + compression + header length uint32 BE) then JSON header (minimum disclosure: `formatVersion`, `handle`, `bodyBytes`, `bodySha256` — every other key rejected at parse time), then compressed body (brotli with gzip fallback via `CompressionStream` feature detection). ULID handles via `vault.getBundleHandle()` persist in a reserved `_meta/handle` envelope that bypasses AES-GCM the same way `_keyring` does.

## Peer-dep convention (v0.6+)

All store and auth packages (every `@noy-db/to-*`, `@noy-db/on-*`, `@noy-db/in-*`, `@noy-db/as-*`) use `"@noy-db/hub": "workspace:*"` in `peerDependencies` (NOT `"workspace:^"`). This prevents the changeset-cli pre-1.0 dep-propagation heuristic from computing major bumps on dependent packages when `@noy-db/hub` bumps minor. The looser constraint is safe because the monorepo ships all packages in lockstep — consumers always install matching versions. Do not revert to `workspace:^` or the next minor release will trip the same changeset bug.

## Testing Strategy

- Unit tests with `@noy-db/to-memory` store (crypto, keyring, permissions)
- Integration tests with `@noy-db/to-file` on temp directories
- DynamoDB tests with DynamoDB Local (Docker) in CI
- Security tests: wrong key rejection, tamper detection, revoked user lockout after rotation
- Edge cases: empty vaults, concurrent writes, 1MB+ records, Unicode/Thai text, corrupt files

## First Consumer

An established regional accounting firm platform. Vaults = companies, collections = invoices/payments/disbursements/clients. USB stick workflow via `to-file`, cloud via `to-aws-dynamo`. Vue/Nuxt frontend with Pinia stores.
