# NOYDB Topology Matrix

> A NOYDB deployment rarely uses one store for everything. Records belong in a
> CAS-capable KV (DynamoDB, IndexedDB). Blobs belong in an object store (S3).
> Cold data belongs in an archive tier (S3 Glacier, a filesystem quota-cordon,
> a WebDAV bucket). A backup belongs somewhere you can't accidentally overwrite.
>
> This document maps **which store plays which role**, **which framework
> surface exposes which primitive**, and **which combinations form coherent
> deployment patterns**.
>
> It is not exhaustive. It captures the current design space so a reader
> can pick a topology without reading the whole SPEC.

---

## The seven topology roles

Every store in a NOYDB deployment is playing one of these roles. A single
store may play several. A deployment may use different stores for each.

| Role | Lives in core as | What it holds |
|------|------------------|----------------|
| **Working records** | `NoydbOptions.store` (primary) | The canonical copy of structured records — the store `createNoydb()` opens against |
| **Blob/attachment** | `routeStore({ blobs: ... })` | Binary chunks from `collection.blob(id).put()` — optionally size-tiered |
| **Memory-edit layer** | `Noydb` in-process cache | The decrypted in-RAM working copy all queries hit — never a persistent store, always the hub itself |
| **Team-sync peer** | `SyncTarget[]` with `role: 'sync-peer'` | A second primary that receives write fanout from the local peer |
| **Backup target** | `SyncTarget[]` with `role: 'backup'` | Pull-only fallback if the primary is unavailable |
| **History / ledger** | Hub's `LedgerStore` inside the primary store | Per-record version log + hash chain — typically colocated with working records |
| **Cold archive** | `routeStore({ age: { cold: ..., coldAfterDays } })` or `role: 'archive'` | Records older than N days, migrated to cheaper tier on a schedule |

These seven roles are the columns of View 1.

---

## View 1 — Stores × Topology role

Rows are the six built-in `to-*` adapters. Cells rate suitability for each
role: **★** native fit, **✓** good fit, **~** ok but with caveats, **✗** bad
fit, **—** not applicable.

| Adapter | Working records | Blob/attachment | Memory-edit | Team-sync peer | Backup target | History / ledger | Cold archive |
|---------|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| `@noy-db/to-memory`       | ~ dev/test only | ~ dev/test only | — | ✗ process-local | ✗ volatile | ✗ volatile | ✗ volatile |
| `@noy-db/to-file`         | ★ USB / desktop | ✓ JSON chunks inline | — | ~ shared folder w/ lock risk | ★ single tarball / bundle | ✓ inline files | ✓ move-to-archive-dir |
| `@noy-db/to-browser-local`| ~ <5 MB vaults | ✗ 5 MB hard cap | — | ✗ tab-local | ~ via `dump()` | ~ inline (slow >5K records) | ✗ |
| `@noy-db/to-browser-idb`  | ★ browser default | ✓ 256 KB-chunk OK | — | ✗ tab-local | ✓ via `dump()` | ✓ inline | ~ |
| `@noy-db/to-aws-dynamo`   | ★ CAS-atomic, fast | ✗ 400 KB item cap | — | ★ multi-client safe | ✓ as backup role | ✓ inline | ✗ cost at age |
| `@noy-db/to-aws-s3`       | ~ no CAS, last-write-wins | ★ unlimited chunks | — | ✗ no CAS for peers | ★ bucket versioning | ~ | ★ lifecycle → Glacier |

Memory-edit is always `—` because it's not a store role — it's the hub's
in-process working copy, allocated when `createNoydb()` opens and freed on
`close()`. Every deployment has it; you don't pick it.

### Reading the matrix

- A **single-store** deployment means picking an adapter whose column is
  mostly ★/✓. For browsers, `to-browser-idb`. For desktop, `to-file`.
- A **split-store** deployment uses `routeStore()` to pair two adapters —
  each plays roles the other is weak at. The canonical pair is
  `dynamo` (records ★) + `s3` (blobs ★, cold ★).
- A **multi-backend** deployment uses `SyncTarget[]` to fan writes to
  multiple primaries (each a `sync-peer`) and pulls fall back to
  `backup`/`archive` targets.

---

## View 2 — Frameworks × API shape

Rows are the framework-integration packages. Columns are the primitives each
package exposes over the hub API.

| Integration | Reactive primitive | Open/close wiring | Live query | Multi-collection compose | Sync hook | Blob hook |
|-------------|--------------------|-------------------|------------|---------------------------|-----------|-----------|
| **Vanilla / Node** (`@noy-db/hub` only) | — (imperative) | `await createNoydb()` / `db.close()` | `query().subscribe(cb)` / `.live()` | manual | `db.push()`, `db.pull()` | `collection.blob(id)` |
| **Vue 3** (`@noy-db/in-vue`) | `ref`/`shallowRef` | `NoydbPlugin` in `createApp`, `useNoydb()` to inject | `useCollection().live` | `useCollection` per-collection | `useSync()` | `useCollection().blob(id)` |
| **Pinia** (`@noy-db/in-pinia`) | Pinia store | `setActiveNoydb(db)` before `defineNoydbStore` | `defineNoydbStore(...).live()` | one store per collection | Pinia action wraps `db.push/pull` | `store.blob(id)` |
| **Nuxt 4** (`@noy-db/in-nuxt`) | Pinia store (via in-pinia) | Module adds `nuxt.config.ts` wiring + client plugin | Auto-imported `defineNoydbStore` | same as Pinia | `useSync()` (auto-imported) | same as Pinia |
| **Yjs** (`@noy-db/in-yjs`) | Y.Doc observers | `yjsCollection(vault, name, { yFields })` | native Y.Doc events | Y.Map / Y.Array / Y.Text nested fields | flows through normal sync | — (use Y.Doc binary) |

### Additional framework bindings

See [`docs/packages-integrations.md`](./packages/integrations.md) for the
full catalog (React + Next.js + Zustand + TanStack Query/Table, Svelte,
Solid, Qwik, AI tool-calling, Yjs). The table below highlights a few:

| Target | Package | Primitive |
|---|---|---|
| React | `@noy-db/in-react` | `useNoydb`, `useVault`, `useCollection`, `useQuery`, `useSync` hooks |
| Next.js App Router | `@noy-db/in-nextjs` | `getNoydb()`, `getVault()`, `withVault()`, client re-exports |
| Svelte | `@noy-db/in-svelte` | zero-dep reactive stores (Svelte 4 + 5 compat) |
| Solid | `@noy-db/in-solid` | signals |
| Qwik | `@noy-db/in-qwik` | resumable queries |
| TanStack Query | `@noy-db/in-tanstack-query` | query function adapter |
| Zustand | `@noy-db/in-zustand` | store factory mirroring `defineNoydbStore` |

---

## View 3 — Deployment patterns (topology × recipe)

A *pattern* is a canonical combination of stores + routing + sync config that
answers one real-world need. Each pattern is a recipe: the ingredients and
the glue.

### Pattern A — Local only

One user, one device, no cloud, no peers. The simplest deployment.

```ts
const db = await createNoydb({
  store: jsonFile({ dir: './data' }),    // or browserIdbStore() in the browser
  user: 'owner', secret: passphrase,
})
```

**When** — single-user desktop apps, USB-stick workflows, CLIs, prototypes.
**Showcase proof** — #01 Single-device workflow, #02 Multi-user Access, #05 Blob Lifecycle.

### Pattern B — Offline-first + cloud mirror

Primary local store, secondary cloud sync for availability and cross-device
access. The local copy is authoritative for edits; the cloud is a peer.

```ts
const db = await createNoydb({
  store: browserIdbStore(),                          // primary local
  sync: [{ store: dynamo({ table: 'app' }), role: 'sync-peer' }],
  syncPolicy: INDEXED_STORE_POLICY,                  // on-change push
})
```

**When** — most consumer / SME apps. Works offline, syncs opportunistically.
**Showcase proof** — #04 Sync Two Offices, #10 Cloud DynamoDB.

### Pattern C — Records + blobs split (the canonical `routeStore` shape)

DynamoDB has a 400 KB per-item cap and gets expensive on large blobs; S3 has
no CAS. Pair them: records → DynamoDB, binary blobs → S3. Single
`createNoydb()` call.

```ts
const store = routeStore({
  default: dynamo({ table: 'records' }),
  blobs: s3({ bucket: 'blobs' }),
})
const db = await createNoydb({ store, user: 'alice', secret: passphrase })
```

**When** — any app with PDF attachments, image uploads, receipts, or audio.
**Showcase proof** — #03 Store Routing, #05 Blob Lifecycle.
**Cost note** — ~27× blob-storage cost reduction vs DynamoDB-only,
based on AWS list prices for attachment-heavy workloads.

### Pattern D — Hot + cold tiered

Records older than N days move to archive. Use `routeStore.age` — no
application code change when data ages out.

```ts
const store = routeStore({
  default: dynamo({ table: 'hot' }),
  age: { cold: s3({ bucket: 'archive' }), coldAfterDays: 90 },
})
```

**When** — audit logs, transaction history, time-series data, compliance
retention with a hot query window.
**Showcase proof** — #03 Store Routing exercises the age dimension with
synthetic clocks.

### Pattern E — Multi-peer team sync

Two or more primaries that fan writes to each other. Each peer is a full
store; each peer's local writes are pushed to all other peers. Backup and
archive are pull-only fallbacks.

```ts
const db = await createNoydb({
  store: browserIdbStore(),
  sync: [
    { store: dynamo({ table: 'team-hot' }),   role: 'sync-peer' },
    { store: s3({ bucket: 'team-backup' }),    role: 'backup' },
    { store: s3({ bucket: 'team-archive' }),   role: 'archive' },
  ],
})
```

**When** — small teams (2–20 people), multi-device per person, intermittent
connectivity. The primary peer is usually the cheap CAS-capable store; the
backup is a same-region S3 bucket; archive is S3 Glacier.
**Showcase proof** — #04 Sync Two Offices.

### Pattern F — CRDT collaboration

Two users edit the same record at once, real-time. Yjs CRDT fields handle
the merge; the rest of the record uses normal OCC. The Y.Doc binary state
lives inside the encrypted envelope — storage still sees only ciphertext.

```ts
const notes = yjsCollection<Note>(vault, 'notes', {
  yFields: { body: yText(), metadata: yMap() },
})
```

**When** — shared documents, collaborative editing, live comments, presence.
**Showcase proof** — #09 Encrypted CRDT.

### Pattern G — Middleware-hardened production

Wrap any store with retry + circuit breaker + cache + health check. No
custom error handling in application code.

```ts
const store = wrapStore(
  dynamo({ table: 'prod' }),
  withRetry({ maxRetries: 3 }),
  withCircuitBreaker({ failureThreshold: 5, resetTimeoutMs: 30_000 }),
  withCache({ ttlMs: 60_000 }),
  withHealthCheck(),
  withMetrics({ onOperation: metric => metrics.emit(metric) }),
)
```

**When** — any deployment past prototype. Retry + circuit breaker are close
to mandatory at production scale.
**Showcase proof** — #08 Resilient Middleware.

### Pattern H — USB portable

Data lives on a removable drive. Plug in, unlock, work offline, eject. No
network, no peers. The vault directory is a self-contained, encrypted
portable file tree.

```ts
const db = await createNoydb({
  store: jsonFile({ dir: '/Volumes/USB/noydb-data' }),
  user: 'owner', secret: passphrase,
})
```

**When** — field workers, pre-connectivity environments, regulated workflows
that explicitly avoid cloud storage.
**Showcase proof** — #01 Single-device workflow (uses `memory()` but pattern is
identical).

### Pattern J — Authentication bridges (passphrase-less unlock)

Once a vault is enrolled under OIDC or WebAuthn, the passphrase becomes
an enrolment-only input — day-to-day unlock uses the identity provider
(OIDC) or the device authenticator (WebAuthn) and the stored wrapping
key half.

```ts
// Enrol once (after normal passphrase unlock)
const enrolment = await enrollOidc(keyring, 'company-a', config, idToken)
// ...persist enrolment...

// Later sessions — no passphrase required
const keyring = await unlockOidc(enrolment, config, freshIdToken)
```

**When** — any deployment whose users should not carry a vault
passphrase in their head (SMEs with OIDC-provided SSO, iOS/macOS apps
with passkey-first UX, shared-device workflows with a personal security
key).
**Showcase proof** — #12 OIDC bridge (automated), #13 WebAuthn
(automated + real-biometric demo at `playground/nuxt/pages/webauthn.vue`).
**Per-provider setup** — `docs/integrations-oidc.md` walks through Google,
Apple, LINE, Meta, Auth0, and Keycloak.

### Pattern I — Multi-tenant geographic sharding

Vaults with an `EU-` prefix go to an EU DynamoDB table; vaults with a `US-`
prefix go to a US table. One `createNoydb()` call; routing is transparent.

```ts
const store = routeStore({
  default: dynamo({ table: 'default-region' }),
  vaultRoutes: {
    'EU-': dynamo({ table: 'eu-records', region: 'eu-west-1' }),
    'US-': dynamo({ table: 'us-records', region: 'us-east-1' }),
  },
})
```

**When** — GDPR/data-residency requirements, multi-region SaaS.
**Showcase proof** — currently shown in #03 Store Routing as one of the
routing dimensions exercised; not a dedicated showcase.

---

## Showcase → matrix coverage

Which cells does each showcase actually exercise? This is the honest
traceability map — if a pattern only appears in a planned showcase, it's
unverified.

| Showcase | Stores | Framework | Topology roles demonstrated | Pattern |
|----------|--------|-----------|-----------------------------|---------|
| **#01 Single-device workflow**        | `memory`               | Pinia      | Working records, Memory-edit                         | A |
| **#02 Multi-user Access**     | `memory`               | Node       | Working records, History (keyring rotation)          | A |
| **#03 Store Routing**         | `memory` × 2           | Node       | Working records + Cold archive + override/suspend    | C, D, I |
| **#04 Sync Two Offices**      | `memory` × 3           | Vue        | Team-sync peer (×2) + shared cloud                   | B, E |
| **#05 Blob Lifecycle**        | `memory`               | Node       | Blob/attachment, History (blob versions)             | C (single-store variant) |
| **#06 Cascade Delete FK**     | `memory`               | Nuxt+Pinia | Working records, FK refs                             | A |
| **#07 Query Analytics**       | `memory`               | Pinia      | Working records, Memory-edit (aggregate/groupBy)     | A |
| **#08 Resilient Middleware**  | flaky `memory` wrapper | Node       | Working records + middleware pipeline                | G |
| **#09 Encrypted CRDT**        | `memory`               | Yjs        | Working records w/ CRDT fields                       | F |
| **#10 Cloud DynamoDB**        | `dynamo`               | Nuxt       | Working records (real cloud), Team-sync peer         | B |
| **#11 AWS Split Store**       | `routeStore(dynamo + s3)` | Node    | Working records (DynamoDB) + Blob/attachment (S3)    | C |
| **#12 OIDC Bridge**           | `memory` + fetch mock  | Pure hub   | Authentication — passphrase-less unlock via split-key OIDC | Authentication |
| **#13 WebAuthn**              | `memory` + nav stub    | Pure hub   | Authentication — passphrase-less unlock via hardware key   | Authentication |
| **#14 Dictionary + i18n**     | `memory`               | Pure hub   | Multi-locale — `dictKey` + `i18nText` over EN/TH/AR (RTL)  | i18n |

Gaps to note: no showcase exercises Pattern H (USB) directly — it's identical
to Pattern A at the code level and wouldn't add coverage. Pattern I
(geographic) isn't its own showcase; it's one dimension of #03.

---

## Choosing a topology — fast path

If you're not sure which pattern applies, answer these in order:

1. **Is the data leaving the device?**
   No → Pattern A (local only).
   Yes → continue.

2. **Is the cloud store the authority, or a mirror?**
   Authority (cloud-first, offline is read-only) → Pattern B with
   `browserIdbStore()` demoted to cache via `withCache`.
   Mirror (offline is authoritative) → Pattern B as written.

3. **Are there binary attachments (>100 KB)?**
   No → stay with the single-store pattern.
   Yes → add Pattern C (split records + blobs).

4. **Is data retention >12 months?**
   Cold tier is usually cheaper than keeping everything hot → add Pattern D.

5. **How many people edit the same records at the same time?**
   Zero or one → skip CRDT.
   Many, real-time → Pattern F (CRDT).

6. **Is this production?**
   Yes → Pattern G (middleware) wraps whichever store pattern you arrived at.

The patterns compose. `routeStore` outputs are valid inputs to `wrapStore`;
`wrapStore` outputs are valid inputs to `SyncTarget[]`. The composition
order that production deployments tend to use is:

```ts
const store = wrapStore(
  routeStore({ default: dynamo(...), blobs: s3(...), age: { cold: glacier(...), coldAfterDays: 90 } }),
  withRetry(), withCircuitBreaker(), withHealthCheck(), withMetrics(...),
)
const db = await createNoydb({ store, sync: [{ store: peerStore, role: 'sync-peer' }] })
```

That one expression covers patterns C + D + G + E at once.

---

*Last updated: 2026-04-23.*
