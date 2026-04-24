# Start here

> **One-page entry point** for adopters. If you read three noy-db docs,
> read this one, [`docs/guides/topology-matrix.md`](./topology-matrix.md), and
> [`SPEC.md`](../../SPEC.md) — in that order.
>

---

## What noy-db is, in 60 seconds

A **zero-knowledge, offline-first, encrypted document store** with
pluggable backends and multi-user access control. You install a
TypeScript library; it encrypts every record with AES-256-GCM before
the record reaches any storage backend. The backend — file, DynamoDB,
S3, IndexedDB, WebDAV — only ever sees opaque ciphertext envelopes.

Three promises in one line each:

- **Your data is yours.** The library alone holds the key; the backend
  cannot read it.
- **Works offline.** The local store is the authority; sync is an
  optional mirror.
- **Any backend.** One-line swap between file, cloud, browser, USB.

---

## Pick your stack in 30 seconds

Answer two questions in order, then follow the arrow.

### Question 1 — where does the data live?

| Answer | Your primary store |
|--------|--------------------|
| A browser tab (web app, PWA, Electron) | **`@noy-db/to-browser-idb`** |
| A Node.js process on a laptop / server | **`@noy-db/to-file`** |
| A cloud backend (multi-device access) | **`@noy-db/to-aws-dynamo`** + **`@noy-db/to-aws-s3`** (blobs) |
| A USB stick you carry physically | **`@noy-db/to-file`** pointed at the mount |
| Just testing / prototyping | **`@noy-db/to-memory`** |

### Question 2 — what framework is driving the UI?

| Answer | Your integration |
|--------|------------------|
| Nuxt 4 | **`@noy-db/in-nuxt`** (wraps Pinia below) |
| Vue 3 + Pinia | **`@noy-db/in-pinia`** |
| Vue 3, composables only | **`@noy-db/in-vue`** |
| Yjs collaborative editing | **`@noy-db/in-yjs`** |
| React / Svelte / Solid / Qwik / Zustand | planned — see `Fork · Integrations` milestone |
| Nothing — plain TypeScript / vanilla DOM | just `@noy-db/hub` (+ a store) |

---

## Quick start (30 seconds)

Run the scaffolder and pick a template:

```bash
npm create noy-db@latest my-app
cd my-app
pnpm install
pnpm dev
```

The scaffolder ships three templates:

- **`vanilla`** — Vite + TypeScript, no framework. Smallest starting
  point. [See the template README →](../packages/create-noy-db/templates/vanilla/README.md)
- **`nuxt-default`** — Nuxt 4 + Pinia + IndexedDB. The canonical
  full-stack starting point. [Template README →](../packages/create-noy-db/templates/nuxt-default/README.md)
- **`vite-vue`** and **`electron`** templates are additional options.

---

## The mental model, by diagram

```
                  ┌─────────────────────────────────────────┐
                  │                Your app                  │
                  │  (Nuxt / Vue / Pinia / React / plain JS) │
                  └────────────────┬────────────────────────┘
                                   │
                                   ▼
         ┌────────────────────────────────────────────────────┐
         │  @noy-db/in-* integration (optional, thin — ~200 LoC)│
         └────────────────────────────┬────────────────────────┘
                                      ▼
         ┌──────────────────────────────────────────────────────┐
         │                   @noy-db/hub                         │
         │                                                        │
         │  Passphrase                                            │
         │    └─► PBKDF2-SHA256 (600K) ► KEK  [memory only]       │
         │          └─► AES-KW unwrap ► DEK per collection        │
         │                └─► AES-256-GCM encrypt / decrypt       │
         │                       │                                │
         │                       ▼                                │
         │                 NoydbStore                             │
         │              (sees ciphertext only)                    │
         └────────────────────────────┬─────────────────────────┘
                                      ▼
         ┌──────────────────────────────────────────────────────┐
         │  @noy-db/to-* store — pick any: file, IDB, S3,       │
         │  DynamoDB, WebDAV, IPFS, Git, custom, …              │
         └──────────────────────────────────────────────────────┘
```

The four package prefixes — each reads as a preposition:

- **`to-`** — *data goes to* a storage backend (file, DynamoDB, S3, IndexedDB, ...)
- **`in-`** — *runs in* a framework runtime (Vue, Pinia, Nuxt, Yjs, ...)
- **`on-`** — *you get on* via an authentication method (WebAuthn, OIDC, magic-link, PIN, ...)
- **`as-`** — *export as* a portable artefact. Plaintext tier (record formatters + document/blob extractors) under `canExportPlaintext` (default off); encrypted tier (`as-noydb`) under `canExportBundle` (default on for owner/admin). See [`docs/patterns/as-exports.md`](./patterns/as-exports.md).

Locale-specific logic (Thai BE years, Japanese fiscal calendars, GDPR retention rules, …) deliberately lives **in userland**, not in noy-db. Hub is content-agnostic. See [`docs/patterns/i18n-boundaries.md`](./patterns/i18n-boundaries.md) for the three-layer model and how to wire your own Layer-3 helpers.

---

## Tree-shake-friendly subpath imports

The main `@noy-db/hub` barrel re-exports every symbol — you never
need to touch subpaths. But if bundle size matters, you can import
the narrower surface you actually use:

```ts
// Solo app, no i18n, no sync, no blob routing:
import { createNoydb } from '@noy-db/hub'                  // ~370 KB main

// Multi-locale app:
import { dictKey, i18nText } from '@noy-db/hub/i18n'       // +19 KB

// Team / multi-user app:
import { grant, SyncEngine } from '@noy-db/hub/team'       // +38 KB

// Heavy router / middleware:
import { routeStore, wrapStore } from '@noy-db/hub/store'  // +77 KB

// Query-only consumer:
import { Query, sum, count } from '@noy-db/hub/query'      // +66 KB

// Session:
import { createSession, validateSessionPolicy } from '@noy-db/hub/session'  // +14 KB

// History / audit / time-travel (versioning + diff + hash-chain + JSON Patch):
import { LedgerStore, diff, saveHistory, computePatch } from '@noy-db/hub/history'  // +28 KB
```

Every subpath is additive — the main entry keeps working unchanged.

## Feature inventory

| Area | What's in |
|------|-----------|
| **Encryption** | AES-256-GCM, per-record random IV, PBKDF2-SHA256 600K iterations, AES-KW for DEK wrapping |
| **Storage** | 6-method `NoydbStore` contract; `file`, `memory`, `browser-idb`, `browser-local`, `aws-dynamo`, `aws-s3` |
| **Query DSL** | Chainable builder (`where` / `orderBy` / `limit` / `join` / `groupBy` / `aggregate`) over hydrated in-memory data |
| **Joins** | Eager joins (indexed nested-loop + hash), multi-FK chaining, live (reactive) joins, streaming `scan().aggregate()` |
| **Ref integrity** | `ref(target, { mode })` — strict / warn / cascade dangling-FK behaviour; `vault.checkIntegrity()` |
| **Blobs** | `collection.blob(id)` → `BlobSet` with versioning, HMAC eTags, AAD-bound chunks, MIME magic detection (55 rules) |
| **Sync** | Multi-target (`SyncTarget[]`), roles `sync-peer` / `backup` / `archive`, 4 push modes + 3 pull modes via `syncPolicy` |
| **Store routing** | `routeStore({ default, blobs, routes, age, vaultRoutes, overflow })` — 5+ routing dimensions, runtime `override()` / `suspend()` / `resume()` |
| **Middleware** | `wrapStore(store, withRetry, withCircuitBreaker, withCache, withHealthCheck, withMetrics, withLogging)` |
| **Sessions** | Session tokens, idle/absolute timeouts, re-auth policies, magic-link unlock, dev-mode unlock |
| **Access control** | 5 roles (owner / admin / operator / viewer / client), per-collection permissions, key rotation on revoke |
| **Auth (on-*)** | `@noy-db/on-webauthn` (passkey + PRF), `@noy-db/on-oidc` (split-key key-connector) |
| **i18n** | `dictKey()` for stable-key labels + `i18nText()` for per-record multi-locale content, Thai Unicode first-class |
| **Integrity** | Hash-chained ledger, `.noydb` encrypted bundle format, tamper detection |
| **Testing** | 950+ hub tests + 14 end-to-end showcases, happy-dom for Vue/Pinia/WebAuthn tests |

For what's next, see [`ROADMAP.md`](../../ROADMAP.md).

---

## Where to go next

| You want to... | Read |
|----------------|------|
| Pick the right store / topology for your app | [`docs/guides/topology-matrix.md`](./topology-matrix.md) |
| Understand every design decision | [`SPEC.md`](../../SPEC.md) |
| Learn the threat model | [`docs/reference/architecture.md`](../reference/architecture.md) |
| Copy-paste a minimal setup | [`docs/guides/getting-started.md`](./getting-started.md) |
| See every feature exercised end-to-end | [`showcases/`](../showcases/) — 14 vitest files, each a self-contained tutorial |
| Plug into Google / Apple / LINE / Meta / Auth0 / Keycloak | [`docs/guides/oidc-providers.md`](./oidc-providers.md) |
| Model a composite entity (invoice + its PDF, email + attachments) | [`docs/patterns/email-archive.md`](./patterns/email-archive.md) — decision matrix for "what's record vs what's blob" |
| Understand what hub does (and doesn't) do with language content | [`docs/patterns/i18n-boundaries.md`](./patterns/i18n-boundaries.md) — content-agnostic design; where translation / collation / fiscal logic actually lives |
| Export data — plaintext (`.xlsx`/`.csv`/`.pdf`) for end users or encrypted (`.noydb`) for backup — without breaking zero-knowledge | [`docs/patterns/as-exports.md`](./patterns/as-exports.md) — the `as-*` family (two tiers + authorization model), working pattern today with SheetJS |
| Stop wrong-shape data at the door with Zod / Valibot / ArkType | [`docs/patterns/schema-validation.md`](./patterns/schema-validation.md) — Standard Schema v1 integration, input + output validation, schema evolution patterns |
| Subscribe to every put/delete on a collection (audit-trail / inbox UI) | `collection.subscribe(event => …)` — fires `{ type: 'put' \| 'delete', id, record }` post-commit; returns an unsubscribe function. Event stream, not reactive value (for reactive state use `query().live()`). |
| Resolve sync conflicts when two operators edit the same record offline | [`docs/patterns/conflict-resolution.md`](./patterns/conflict-resolution.md) — four built-in policies (LWW / FWW / manual / custom merge), multi-office worked example, pitfalls |
| Contribute code | [`CLAUDE.md`](../../CLAUDE.md) — coding conventions; [`ROADMAP.md`](../../ROADMAP.md) — open milestones |

---

## Which showcases do what

| # | File | What it proves |
|---|------|----------------|
| 01 | `01-accounting-day.showcase.test.ts` | Pinia + reactive CRUD + aggregates |
| 02 | `02-multi-user-access.showcase.test.ts` | Keyring rotation, revoked-user lockout |
| 03 | `03-store-routing.showcase.test.ts` | `routeStore` + runtime override / suspend / resume |
| 04 | `04-sync-two-offices.showcase.test.ts` | Offline-first + multi-peer sync + conflict strategies |
| 05 | `05-blob-lifecycle.showcase.test.ts` | `BlobSet` — put / get / `response()` / `publish()` / versions |
| 06 | `06-cascade-delete-fk.showcase.test.ts` | FK refs + `vault.checkIntegrity()` + orphan handling |
| 07 | `07-query-analytics.showcase.test.ts` | 200-row analytics — `groupBy` / `aggregate` / top-N |
| 08 | `08-resilient-middleware.showcase.test.ts` | `wrapStore` + retry + circuit breaker + metrics + recovery |
| 09 | `09-encrypted-crdt.showcase.test.ts` | Yjs CRDTs round-tripping through AES-GCM |
| 10 | `10-cloud-dynamo.showcase.test.ts` | Real AWS DynamoDB (env-gated via `NOYDB_SHOWCASE_AWS_PROFILE`) |
| 11 | `11-aws-split-store.showcase.test.ts` | Records to DynamoDB + blobs to S3 via `routeStore` |
| 12 | `12-oidc-bridge.showcase.test.ts` | OIDC split-key passphrase-less unlock |
| 13 | `13-webauthn.showcase.test.ts` | WebAuthn PRF + rawId-fallback passkey unlock |
| 14 | `14-dictionary-i18n.showcase.test.ts` | Multi-locale (EN / TH / AR-RTL) with `dictKey` + `i18nText` |

Every showcase is runnable: `pnpm --filter @noy-db/showcases test`.
