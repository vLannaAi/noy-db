# NOYDB Implementation Roadmap

> **Version 2.0** — Refined with architecture diagrams, configuration guides, and innovation analysis.
> Supersedes the original roadmap. Companion to `NOYDB_SPEC.md`.

---

## Why NOYDB? — Value at a Glance

```
┌─────────────────────────────────────────────────────────────────────────┐
│                                                                         │
│   🔐  WHAT MAKES NOYDB DIFFERENT                                       │
│                                                                         │
│   ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐     │
│   │  ZERO-KNOWLEDGE  │  │  OFFLINE-FIRST   │  │  PLUGGABLE       │     │
│   │                  │  │                  │  │  BACKENDS        │     │
│   │  Backends store  │  │  Works without   │  │                  │     │
│   │  ciphertext only │  │  internet. Sync  │  │  Same API for    │     │
│   │  No server ever  │  │  when available. │  │  USB, DynamoDB,  │     │
│   │  sees plaintext  │  │  Local = primary │  │  S3, Browser,    │     │
│   │                  │  │                  │  │  or your own     │     │
│   └──────────────────┘  └──────────────────┘  └──────────────────┘     │
│                                                                         │
│   ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐     │
│   │  MULTI-USER      │  │  ZERO RUNTIME    │  │  MEMORY-FIRST    │     │
│   │  ACCESS CONTROL  │  │  DEPENDENCIES    │  │  QUERIES         │     │
│   │                  │  │                  │  │                  │     │
│   │  5 roles, per-   │  │  Web Crypto API  │  │  Array.filter()  │     │
│   │  collection perms│  │  only. No npm    │  │  No query engine │     │
│   │  Portable keyrings│  │  crypto packages │  │  1K-50K records  │     │
│   │                  │  │                  │  │                  │     │
│   └──────────────────┘  └──────────────────┘  └──────────────────┘     │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

### The Gap NOYDB Fills

```
  Existing Solutions                          NOYDB
  ──────────────────                          ─────

  RxDB ──────── Paid encryption plugin        Free, built-in, zero-knowledge
  Amplify ───── Mandatory AppSync             No middleman, works offline
  PouchDB ──── CouchDB only                  Any backend (6 methods)
  TinyBase ─── No encryption                 AES-256-GCM everything
  LowDB ────── No sync, no encryption        Sync + encrypt + multi-user
  Dexie ────── Browser only                  Node + Browser + USB + Cloud
  Replicache── BSL license (paid)            MIT license

  None of the above combines:
  ┌─────────────────────────────────────────────────────────────┐
  │  encrypted-at-rest  +  pluggable backends  +  offline sync  │
  │  +  multi-user ACL  +  per-collection perms +  zero deps   │
  └─────────────────────────────────────────────────────────────┘
```

---

## Architecture Deep Dive

### Data Flow — Write Path

```
  Application Code                    What each layer sees
  ─────────────────                   ─────────────────────

  invoices.put('inv-001', {           { amount: 5000 }          PLAINTEXT
    amount: 5000,                          │
    status: 'draft'                        ▼
  })                            ┌─ Permission Check ─────────┐
                                │  keyring → role → "rw"?    │  Checks only
                                └────────────┬───────────────┘
                                             ▼
                                ┌─ Crypto Layer ─────────────┐
                                │  DEK + random IV           │  Last layer to
                                │  AES-256-GCM encrypt       │  see plaintext
                                │  → base64 ciphertext       │
                                └────────────┬───────────────┘
                                             ▼
                                ┌─ Envelope ─────────────────┐
                                │ { _noydb:1, _v:3, _ts:..., │  CIPHERTEXT
                                │   _iv: "a3f2...",          │  from here on
                                │   _data: "U2Fs..." }      │
                                └────────────┬───────────────┘
                                             ▼
                                ┌─ Adapter ──────────────────┐
                                │  .put(compartment, coll,   │  Adapter sees
                                │        id, envelope)       │  ONLY ciphertext
                                └────────────┬───────────────┘
                                             ▼
                            ┌────────────────┼────────────────┐
                            ▼                ▼                ▼
                        USB File       DynamoDB Item      S3 Object
                     (ciphertext)     (ciphertext)      (ciphertext)
```

### Key Hierarchy

```
  ┌───────────────────────────────────────────────────────────────────┐
  │                                                                   │
  │   User Passphrase: "correct-horse-battery-staple"                 │
  │          │                                                        │
  │          ▼ PBKDF2-SHA256 (600,000 iterations + per-user salt)     │
  │          │                                                        │
  │      ┌───┴───┐                                                    │
  │      │  KEK  │  Key Encryption Key — MEMORY ONLY, never stored    │
  │      └───┬───┘                                                    │
  │          │                                                        │
  │          │  AES-KW unwrap (from keyring file)                     │
  │          │                                                        │
  │    ┌─────┼──────────────┬──────────────────┐                      │
  │    ▼     ▼              ▼                  ▼                      │
  │  ┌─────┐ ┌─────┐    ┌─────┐           ┌─────┐                   │
  │  │DEK_1│ │DEK_2│    │DEK_3│    ...     │DEK_n│                   │
  │  └──┬──┘ └──┬──┘    └──┬──┘           └──┬──┘                   │
  │     │       │          │                  │                       │
  │     ▼       ▼          ▼                  ▼                       │
  │  invoices  payments  clients           reports                    │
  │  (all records encrypted with their collection's DEK)              │
  │                                                                   │
  │   Compromise one DEK = one collection exposed                     │
  │   Compromise KEK = all collections exposed                        │
  │   Compromise passphrase = derive KEK = all collections            │
  │                                                                   │
  │   But: passphrase is never stored. KEK is never stored.           │
  │   DEKs are wrapped (encrypted) in keyrings — useless without KEK. │
  │                                                                   │
  └───────────────────────────────────────────────────────────────────┘
```

### Multi-User Access Model

```
  Compartment "C101" (บริษัท ABC จำกัด)
  ══════════════════════════════════════

  ┌─ _keyring/ ──────────────────────────────────────────────────────┐
  │                                                                   │
  │  owner-01.json          admin-noi.json       op-somchai.json     │
  │  ┌────────────┐         ┌────────────┐       ┌────────────┐     │
  │  │ role: owner │         │ role: admin │       │role:operator│     │
  │  │ perm: *: rw │         │ perm: *: rw │       │perm:        │     │
  │  │ deks:       │         │ deks:       │       │ inv: rw     │     │
  │  │  inv:  ███  │         │  inv:  ███  │       │ dis: rw     │     │
  │  │  pay:  ███  │         │  pay:  ███  │       │deks:        │     │
  │  │  dis:  ███  │         │  dis:  ███  │       │ inv:  ███   │     │
  │  │  cli:  ███  │         │  cli:  ███  │       │ dis:  ███   │     │
  │  └────────────┘         └────────────┘       └────────────┘     │
  │                                                                   │
  │  viewer-audit.json      client-abc.json                          │
  │  ┌────────────┐         ┌────────────┐                           │
  │  │role: viewer │         │role: client │                           │
  │  │ perm: *: ro │         │perm:        │   ███ = wrapped DEK      │
  │  │ deks:       │         │ inv: ro     │   (encrypted with that   │
  │  │  inv:  ███  │         │deks:        │    user's KEK)           │
  │  │  pay:  ███  │         │ inv:  ███   │                           │
  │  │  dis:  ███  │         └────────────┘   No KEK = no unwrap      │
  │  │  cli:  ███  │                           No unwrap = no decrypt  │
  │  └────────────┘                           No decrypt = no access   │
  │                                                                   │
  └───────────────────────────────────────────────────────────────────┘

  Permission Matrix:
  ┌──────────┬────────┬────────┬────────┬────────┬─────────┐
  │          │ owner  │ admin  │operator│ viewer │ client  │
  ├──────────┼────────┼────────┼────────┼────────┼─────────┤
  │ read     │ all    │ all    │granted │ all    │ granted │
  │ write    │ all    │ all    │granted │ --     │ --      │
  │ grant    │ all    │ ↓roles │ --     │ --     │ --      │
  │ revoke   │ all    │ ↓roles │ --     │ --     │ --      │
  │ export   │ yes    │ yes    │ --     │ --     │ --      │
  │ rotate   │ yes    │ yes    │ --     │ --     │ --      │
  └──────────┴────────┴────────┴────────┴────────┴─────────┘
         ↓roles = can grant/revoke operator, viewer, client
```

---

## Deployment Profiles — Pick Your Stack

NOYDB supports 8 deployment profiles. Each diagram shows the data flow and which packages to install.

### Profile 1: USB Stick (Offline Only)

```
  npm install @noydb/core @noydb/file

  ┌──────────────┐         ┌──────────────────────────────┐
  │  Application │────────▶│  @noydb/file                 │
  │              │         │  /Volumes/USB/noydb-data/     │
  │  createNoydb │         │    C101/                      │
  │  ({          │         │      invoices/                │
  │    adapter:  │         │        inv-001.json (cipher)  │
  │    jsonFile  │         │      _keyring/                │
  │  })          │         │        owner-01.json          │
  └──────────────┘         └──────────────────────────────┘

  Use case: Accountant carries client data on USB between office and home
  Pros:     Zero internet needed, fully portable, works anywhere
  Cons:     Single device, no sync, USB loss = rely on backups
```

### Profile 2: Cloud Only (DynamoDB)

```
  npm install @noydb/core @noydb/dynamo

  ┌──────────────┐         ┌──────────────────────────────┐
  │  Application │────────▶│  @noydb/dynamo                │
  │              │ HTTPS   │  Table: noydb-prod            │
  │  createNoydb │         │  Region: ap-southeast-1       │
  │  ({          │         │                               │
  │    adapter:  │         │  pk: C101                     │
  │    dynamo    │         │  sk: invoices#inv-001         │
  │  })          │         │  _data: U2Fsd... (cipher)    │
  └──────────────┘         └──────────────────────────────┘

  Use case: Cloud-native app with always-on connectivity
  Pros:     Managed infrastructure, multi-device access
  Cons:     Requires internet, AWS dependency
```

### Profile 3: Offline-First + Cloud Sync

```
  npm install @noydb/core @noydb/file @noydb/dynamo

  ┌──────────────┐    primary     ┌─────────────────────────┐
  │  Application │───────────────▶│  @noydb/file (LOCAL)     │
  │              │                │  ./data/                  │
  │  createNoydb │                └─────────────────────────┘
  │  ({          │                          ▲
  │    adapter:  │                          │ sync engine
  │    jsonFile, │                          │ (push/pull)
  │    sync:     │    secondary   ┌────────┴────────────────┐
  │    dynamo    │───────────────▶│  @noydb/dynamo (REMOTE)  │
  │  })          │                │  Table: noydb-prod       │
  └──────────────┘                └─────────────────────────┘

                         ┌──────────────────────────┐
                         │   Sync Flow              │
                         │                          │
                         │   WRITE ──▶ local file   │
                         │            + dirty log   │
                         │                          │
                         │   ONLINE ──▶ push dirty  │
                         │             to DynamoDB  │
                         │                          │
                         │   PULL ──▶ fetch remote  │
                         │           merge to local │
                         │                          │
                         │   CONFLICT ──▶ strategy  │
                         │   (version/local/remote) │
                         └──────────────────────────┘

  Use case: Niwat — USB at home, DynamoDB at office, auto-sync
  Pros:     Best of both worlds, works offline, syncs when available
  Cons:     Conflicts possible (mitigated by strategies)
```

### Profile 4: Browser App with Local Cache

```
  npm install @noydb/core @noydb/browser

  ┌──────────────┐         ┌──────────────────────────────┐
  │  SPA / PWA   │────────▶│  @noydb/browser               │
  │              │         │                               │
  │  createNoydb │         │  < 5MB ──▶ localStorage       │
  │  ({          │         │  > 5MB ──▶ IndexedDB          │
  │    adapter:  │         │                               │
  │    browser   │         │  Key: noydb:C101:inv:inv-001  │
  │  })          │         │  Val: { _iv, _data } (cipher) │
  └──────────────┘         └──────────────────────────────┘

  Use case: Personal finance app, offline PWA
  Pros:     Zero server, instant load, works offline
  Cons:     Browser storage limits, single device
```

### Profile 5: Browser + Cloud Sync

```
  npm install @noydb/core @noydb/browser @noydb/dynamo

  ┌──────────────┐    primary     ┌─────────────────────────┐
  │  Vue/Nuxt    │───────────────▶│  @noydb/browser (LOCAL)  │
  │  SPA         │                │  IndexedDB cache         │
  │              │                └─────────────────────────┘
  │  createNoydb │                          ▲
  │  ({          │                          │ auto-sync
  │    adapter:  │                          │ (online/offline)
  │    browser,  │    secondary   ┌────────┴────────────────┐
  │    sync:     │───────────────▶│  @noydb/dynamo (REMOTE)  │
  │    dynamo    │                │  Cloud persistence       │
  │  })          │                └─────────────────────────┘

  Use case: Multi-device web app with offline capability
  Pros:     Instant hydration from cache, multi-device via cloud
  Cons:     Browser storage limits for large datasets
```

### Profile 6: S3 Archive

```
  npm install @noydb/core @noydb/s3

  ┌──────────────┐         ┌──────────────────────────────┐
  │  Application │────────▶│  @noydb/s3                    │
  │              │ HTTPS   │  Bucket: noydb-archive        │
  │  createNoydb │         │                               │
  │  ({          │         │  s3://bucket/C101/invoices/   │
  │    adapter:  │         │    inv-001.json (cipher)      │
  │    s3        │         │  Concurrency: ETags           │
  │  })          │         │                               │
  └──────────────┘         └──────────────────────────────┘

  Use case: Long-term encrypted archival, bulk backup
  Pros:     Cheapest storage, lifecycle policies, versioning
  Cons:     Higher latency than DynamoDB, not ideal for frequent writes
```

### Profile 7: Vue/Nuxt Full Stack

```
  npm install @noydb/core @noydb/file @noydb/dynamo @noydb/vue

  ┌────────────────────────────────────────────────────────────┐
  │  Nuxt Application                                          │
  │                                                            │
  │  ┌─ useNoydb() ──────────────────────────────────────────┐ │
  │  │  const db = useNoydb()                                │ │
  │  │  const { data, loading } = useCollection<Invoice>(    │ │
  │  │    db, 'C101', 'invoices'                             │ │
  │  │  )                                                    │ │
  │  │  const { dirty, online, push, pull } = useSync(db)   │ │
  │  └───────────────────────────────┬───────────────────────┘ │
  │                                  │                          │
  │                                  ▼                          │
  │  ┌─ @noydb/core ────────────────────────────────────────┐  │
  │  │  Compartment → Collection → Crypto → Adapter          │  │
  │  └──────────────────────┬───────────────────────────────┘  │
  │                         │                                   │
  │              ┌──────────┴──────────┐                        │
  │              ▼                     ▼                        │
  │     @noydb/file (local)    @noydb/dynamo (sync)            │
  └────────────────────────────────────────────────────────────┘

  Use case: Niwat accounting platform (production target)
  Pros:     Reactive UI, type-safe, auto-sync, full offline support
```

### Profile 8: Development / Testing

```
  npm install @noydb/core @noydb/memory

  ┌──────────────┐         ┌──────────────────────────────┐
  │  Test Suite  │────────▶│  @noydb/memory                │
  │              │         │  (in-memory Map, no I/O)      │
  │  createNoydb │         │                               │
  │  ({          │         │  Instant, deterministic,      │
  │    adapter:  │         │  no cleanup needed            │
  │    memory(), │         │                               │
  │    encrypt:  │         │  encrypt: false ──▶ plaintext │
  │    false     │         │  (inspect data in tests)      │
  │  })          │         │                               │
  └──────────────┘         └──────────────────────────────┘

  Use case: Unit tests, rapid prototyping, demos
  Pros:     Zero setup, instant, deterministic
```

### Package Selection Matrix

```
  Which packages do I need?
  ─────────────────────────

  ┌─────────────────────┬──────┬──────┬────────┬─────┬─────────┬─────┐
  │                     │ core │ file │ dynamo │ s3  │ browser │ vue │
  ├─────────────────────┼──────┼──────┼────────┼─────┼─────────┼─────┤
  │ USB / Local disk    │  *   │  *   │        │     │         │     │
  │ Cloud only          │  *   │      │   *    │     │         │     │
  │ Offline + sync      │  *   │  *   │   *    │     │         │     │
  │ Browser SPA         │  *   │      │        │     │    *    │     │
  │ Browser + sync      │  *   │      │   *    │     │    *    │     │
  │ S3 archive          │  *   │      │        │  *  │         │     │
  │ Vue/Nuxt full stack │  *   │  *   │   *    │     │         │  *  │
  │ Testing / dev       │  *   │      │        │     │         │     │
  └─────────────────────┴──────┴──────┴────────┴─────┴─────────┴─────┘
                          always     pick your backend(s)      UI
                          required                             layer
```

---

## Innovation Analysis — What We Validated and What's New

During the roadmap refinement we evaluated several enhancements beyond the original spec. Here's what we're adopting and what we're deferring.

### Adopted Innovations

#### 1. `defineAdapter()` Helper (spec-aligned)

The spec mentions `defineAdapter()` but the original roadmap didn't include it. This is a typed factory wrapper that ensures custom adapters satisfy the `NoydbAdapter` interface at compile time.

```ts
// Developer writes:
export const redis = defineAdapter((opts: RedisOpts) => ({
  name: 'redis',
  async get(c, col, id) { /* ... */ },
  // TypeScript enforces all 6 methods
}))
```

**Impact:** Lowers the barrier for community adapters. Ships in Phase 1 as part of `types.ts`.

#### 2. Adapter Middleware / Composition Pattern

A significant innovation: adapters can be composed. A `withCache()` wrapper turns any remote adapter into a cache-first adapter:

```
  ┌──────────────────────────────────────────────────┐
  │  withCache(browser(), dynamo({ table: 'prod' })) │
  │                                                   │
  │  READ:   browser first ──miss──▶ dynamo ──▶ cache │
  │  WRITE:  write to both (cache + remote)           │
  │  RESULT: instant reads, durable writes            │
  └──────────────────────────────────────────────────┘
```

**Phase:** Ships in Phase 4 alongside browser adapter.

#### 3. Reactive Queries (Vue Integration)

Beyond simple `useCollection`, the Vue package will support reactive queries that auto-update when underlying data changes:

```ts
const drafts = useQuery(invoices, i => i.status === 'draft')
// drafts.value auto-updates when any invoice changes
```

**Phase:** Ships in Phase 4 with `@noydb/vue`.

#### 4. Adapter Health Check

Each adapter gets an optional `ping()` method for connectivity checks:

```ts
interface NoydbAdapter {
  // ... existing 6 methods ...
  ping?(): Promise<boolean>  // optional connectivity check
}
```

Used by sync engine to determine online/offline status without relying solely on `navigator.onLine`.

**Phase:** Ships in Phase 3 alongside sync engine.

#### 5. Migration Utility

A `migrate()` function to copy data between adapters:

```ts
await migrate({
  from: jsonFile({ dir: './old-data' }),
  to: dynamo({ table: 'noydb-prod' }),
  compartments: ['C101', 'C102'],
  onProgress: (pct) => console.log(`${pct}% done`)
})
```

**Phase:** Ships in Phase 5 as a core utility.

### Evaluated but Deferred

| Innovation | Why Deferred |
|-----------|-------------|
| **CRDT-based conflict resolution** | Adds complexity; version-based + strategies cover 95% of cases. Revisit post-1.0 if community demands it. |
| **Schema validation hooks** | Application-layer concern. Users can validate before `put()`. Adding it to core would violate minimalism. |
| **Time-travel (version history)** | Requires storing all versions. Doubles storage. Better handled by adapter-level versioning (S3 versioning, DynamoDB streams). |
| **Plugin system (pre/post hooks)** | Events already cover this. `db.on('change', ...)` is sufficient for most cases. Plugins add API surface without clear benefit. |
| **End-to-end streaming** | Target scale is 1K-50K records in memory. Streaming adds complexity without solving a real bottleneck. |
| **Post-quantum key exchange** | AES-256 is quantum-resistant (Grover's → 128-bit effective). Not needed until quantum computers can break 128-bit symmetric keys. |

---

## Refined Phase Plan

### Phase Overview

```
  Phase 0        Phase 0.5       Phase 1         Phase 2
  ────────       ─────────       ───────         ───────
  Scaffolding    Test Infra      Core MVP        Multi-User
  ┌──────┐       ┌──────┐       ┌──────┐        ┌──────┐
  │ git  │       │ test │       │crypto│        │keyring│
  │ pnpm │──────▶│ harn │──────▶│ CRUD │───────▶│grant │
  │turbo │       │ conf │       │ file │        │revoke│
  │  CI  │       │ suite│       │memory│        │rotate│
  └──────┘       └──────┘       └──────┘        └──────┘
  ~2 hrs          ~3 hrs         ~8 hrs          ~4 hrs
                                    │
                              Usable library!
                              (single-user, local)

  Phase 3         Phase 4         Phase 5
  ───────         ───────         ───────
  Sync Engine     Browser+Vue     Polish
  ┌──────┐        ┌──────┐       ┌──────┐
  │dirty │        │IndexDB│       │  S3  │
  │push  │───────▶│WebAuth│──────▶│ CLI  │
  │pull  │        │ Vue  │       │ docs │
  │dynamo│        │cache │       │migrate│
  └──────┘        └──────┘       └──────┘
  ~6 hrs           ~5 hrs         ~4 hrs
```

---

### Phase 0 — Repository Scaffolding & Tooling

**Goal:** A fully configured monorepo that builds, lints, typechecks, and runs (empty) tests.

#### 0.1 Git + Monorepo Init

```
noydb/
├── .github/
│   ├── workflows/
│   │   ├── ci.yml                    # lint → typecheck → test → build (Node 18/20/22)
│   │   └── release.yml               # changesets → npm publish
│   └── CODEOWNERS
├── .changeset/
│   └── config.json                   # access: public, linked: [["@noydb/*"]]
├── packages/
│   ├── core/                         # @noydb/core
│   ├── adapter-memory/               # @noydb/memory
│   ├── adapter-file/                 # @noydb/file
│   ├── adapter-dynamo/               # @noydb/dynamo (Phase 3)
│   ├── adapter-s3/                   # @noydb/s3 (Phase 5)
│   ├── adapter-browser/              # @noydb/browser (Phase 4)
│   └── vue/                          # @noydb/vue (Phase 4)
├── test-harnesses/                   # private, never published
│   ├── adapter-conformance/
│   ├── simulation-sync/
│   ├── simulation-concurrent/
│   ├── simulation-offline-online/
│   ├── simulation-filesystem/
│   ├── simulation-multiuser/
│   └── benchmarks/
├── .gitignore
├── .npmrc                            # engine-strict=true
├── package.json                      # private root, pnpm workspaces
├── pnpm-workspace.yaml
├── turbo.json
├── tsconfig.base.json                # strict TS shared config
├── vitest.config.ts                  # workspace projects
├── eslint.config.mjs                 # flat config, strict-type-checked
├── LICENSE                           # MIT
├── README.md
├── SECURITY.md
└── CONTRIBUTING.md
```

**Root devDependencies:** `turbo`, `typescript` (~5.7), `tsup`, `vitest`, `eslint`, `@typescript-eslint/*`, `@changesets/cli`

**tsconfig.base.json highlights:**
- `strict: true`, `exactOptionalPropertyTypes: true`, `noUncheckedIndexedAccess: true`
- `target: "ES2022"`, `module: "ESNext"`, `moduleResolution: "bundler"`

#### 0.2 Per-Package Template

Every package follows this structure:

```
packages/{name}/
├── src/
│   └── index.ts              # entry point
├── __tests__/                # tests (excluded from build and npm)
├── package.json              # dual ESM/CJS exports
├── tsconfig.json             # extends ../../tsconfig.base.json
└── tsup.config.ts            # entry: src/index.ts, format: [esm, cjs], dts: true
```

**Dual export pattern:**
```json
{
  "type": "module",
  "exports": {
    ".": {
      "import": { "types": "./dist/index.d.mts", "default": "./dist/index.mjs" },
      "require": { "types": "./dist/index.d.cts", "default": "./dist/index.cjs" }
    }
  },
  "files": ["dist"],
  "engines": { "node": ">=18.0.0" }
}
```

#### 0.3 Five Layers Keeping Tests Out of Production

```
  Layer 1: "files": ["dist"]          Only dist/ ships to npm
  Layer 2: __tests__/ outside src/    tsup entry is src/index.ts
  Layer 3: test-harnesses/ private    "private": true, never published
  Layer 4: .npmignore safety net      Excludes __tests__/, *.test.ts
  Layer 5: CI dry-run assertion       pnpm pack --dry-run grep check
```

#### 0.4 CI Pipeline

```
  ci.yml (push/PR to main):
  ┌──────────────────────────────────────────────────┐
  │  Matrix: Node 18, 20, 22                         │
  │                                                   │
  │  pnpm install                                     │
  │      │                                            │
  │      ├──▶ lint (zero warnings)                    │
  │      ├──▶ typecheck (zero errors)                 │
  │      ├──▶ test (all pass)                         │
  │      └──▶ build (ESM + CJS + .d.ts)              │
  │              │                                    │
  │              └──▶ pack --dry-run (no test files)  │
  └──────────────────────────────────────────────────┘

  release.yml (main merge with changesets):
  ┌──────────────────────────────────────────────────┐
  │  build → test → changeset publish → git tag      │
  └──────────────────────────────────────────────────┘
```

**Acceptance:** `pnpm turbo build` succeeds, `pnpm turbo test` runs (empty), CI green.

---

### Phase 0.5 — Test Architecture (Before Any Implementation)

**Goal:** Define all test infrastructure first. Implementation (Phase 1+) makes tests pass.

#### Adapter Conformance Suite

A single parameterized test factory that every adapter imports:

```ts
export function runAdapterConformanceTests(
  name: string,
  factory: () => Promise<NoydbAdapter>,
  cleanup?: () => Promise<void>
) {
  describe(`Adapter Conformance: ${name}`, () => {
    // Basic CRUD .......................... 7 tests
    // Optimistic concurrency .............. 3 tests
    // Bulk operations (loadAll/saveAll) ... 4 tests
    // Compartment/collection isolation .... 3 tests
    // Edge cases .......................... 5 tests
    //   - Unicode/Thai IDs and values
    //   - 1MB+ envelopes
    //   - Special characters in IDs
    //   - 100 rapid sequential writes
    //   - Empty compartment/collection
  })
}
```

Each adapter runs it with one import:
```ts
import { runAdapterConformanceTests } from '@noydb/test-adapter-conformance'
runAdapterConformanceTests('memory', async () => memory())
```

#### Test Harness Overview

```
  test-harnesses/
  ├── adapter-conformance/          22 tests, parameterized
  ├── simulation-sync/              Two-instance sync scenarios
  ├── simulation-concurrent/        Race conditions, rapid writes
  ├── simulation-offline-online/    Network toggle simulations
  ├── simulation-filesystem/        Corrupt files, permissions, USB edge cases
  ├── simulation-multiuser/         Grant/revoke/rotate with 3+ users
  └── benchmarks/                   vitest.bench for performance baselines
```

---

### Phase 1 — Core + Memory + File Adapters (Single-User MVP)

**Goal:** A usable encrypted document store with file-based persistence. Single-user (owner mode).

#### Source Files

```
packages/core/src/
├── env-check.ts       Runtime: throws if Node <18 or crypto.subtle missing
├── types.ts           All interfaces + defineAdapter() helper
├── errors.ts          NoydbError base + 10 subtypes
├── crypto.ts          deriveKey, generateDEK, wrapKey, unwrapKey, encrypt, decrypt
├── keyring.ts         Phase 1 stub: owner-only mode
├── collection.ts      Collection<T>: get, put, delete, list, query, count
├── compartment.ts     Compartment: manages collections, dump, load, export
├── events.ts          Typed EventEmitter (on/off/emit)
├── noydb.ts           Noydb class + createNoydb() factory
└── index.ts           Re-exports public API + env-check side effect

packages/adapter-memory/src/
└── index.ts           memory() factory backed by nested Maps

packages/adapter-file/src/
└── index.ts           jsonFile({ dir, pretty? }) using node:fs/promises
```

#### Implementation Order (within Phase 1)

```
  1. types.ts + errors.ts ──▶ interfaces, error classes, defineAdapter
  2. crypto.ts ──────────────▶ implement + unit test in isolation
  3. adapter-memory ──────────▶ implement + conformance tests
  4. events.ts ──────────────▶ typed emitter
  5. keyring.ts ─────────────▶ owner-only stub (load, derive, unwrap)
  6. collection.ts ──────────▶ CRUD with encryption
  7. compartment.ts ─────────▶ manages collections, dump/load
  8. noydb.ts + env-check ───▶ createNoydb() factory
  9. adapter-file ───────────▶ implement + conformance + filesystem simulation
  10. Integration test ───────▶ create → put → get → dump → load → verify
```

#### Phase 1 Test Coverage

| Test File | What It Tests | Count |
|-----------|--------------|:-----:|
| `crypto.test.ts` | Round-trip, wrong key, tamper, IV uniqueness, Thai text, 1MB, perf | ~12 |
| `collection.test.ts` | CRUD + encryption, version increment, `encrypt:false` | ~8 |
| `events.test.ts` | Emit on put/delete, off() unsubscribes | ~4 |
| `errors.test.ts` | All types extend NoydbError, correct codes | ~10 |
| Memory conformance | Via adapter-conformance suite | 22 |
| File conformance | Via adapter-conformance suite | 22 |
| Filesystem simulation | Corrupt files, permissions, Unicode paths, 10K perf | ~10 |
| **Total** | | **~88** |

#### Acceptance Criteria

- [ ] All adapter conformance tests pass for memory and file
- [ ] All crypto round-trip tests pass
- [ ] Full lifecycle: `createNoydb` → `compartment` → `collection` → CRUD → dump → load
- [ ] `encrypt: false` dev mode works
- [ ] Env check throws on Node <18 / missing crypto.subtle
- [ ] `pnpm turbo build` produces ESM + CJS + .d.ts for all 3 packages
- [ ] `pnpm pack --dry-run` shows zero test files
- [ ] All filesystem simulation tests pass

---

### Phase 2 — Multi-User Access Control

**Goal:** Full keyring management with 5 roles and per-collection permissions.

#### Changes

- **`keyring.ts`** — Full implementation: `grant()`, `revoke()`, `rotateKeys()`, `changeSecret()`, `listUsers()`
- **`collection.ts`** — Permission checks on every operation (rw vs ro)
- **`noydb.ts`** — Expose grant/revoke/changeSecret at top level

#### Key Rotation Flow

```
  revoke('C101', { userId: 'op-somchai', rotateKeys: true })

  ┌────────────────────────────────────────────────────────────┐
  │  1. Delete op-somchai.json from _keyring/                  │
  │                                                            │
  │  2. For each collection op-somchai had access to:          │
  │     ┌────────────────────────────────────────────────────┐ │
  │     │  a. Generate NEW random DEK                        │ │
  │     │  b. Re-encrypt ALL records with new DEK            │ │
  │     │  c. For each REMAINING user with access:           │ │
  │     │     - Re-wrap new DEK with their KEK               │ │
  │     │     - Update their keyring file                    │ │
  │     └────────────────────────────────────────────────────┘ │
  │                                                            │
  │  3. Old DEKs discarded                                     │
  │     Old wrapped copies in revoked keyring → decrypt NOTHING │
  └────────────────────────────────────────────────────────────┘
```

#### Phase 2 Tests

| Test File | What It Tests | Count |
|-----------|--------------|:-----:|
| `keyring.test.ts` | grant, revoke, rotate, changeSecret | ~10 |
| `access-control.test.ts` | Full 5-role × operation matrix | ~20 |
| Multi-user simulation | 3 concurrent users, revoke+rotate | ~8 |
| **Total** | | **~38** |

#### Acceptance Criteria

- [ ] Full permission matrix: every role/operation combination correct
- [ ] Key rotation after revoke renders old keyrings useless
- [ ] Multi-user simulation passes with 3 concurrent users
- [ ] `changeSecret` re-wraps without data re-encryption

---

### Phase 3 — Sync Engine + DynamoDB Adapter

**Goal:** Dirty tracking, push/pull, conflict detection, DynamoDB adapter.

#### Sync Architecture

```
  ┌─────────────────────────────────────────────────────────────┐
  │  Sync Engine (operates on encrypted blobs — no keys needed) │
  │                                                             │
  │  ┌─ Dirty Log ──────────────────────────────────────────┐  │
  │  │  _sync/dirty.json                                     │  │
  │  │  [{ collection, id, action, version, timestamp }, ...] │  │
  │  │  Appended on every put() and delete()                  │  │
  │  │  Persists to local adapter (survives restarts)         │  │
  │  └──────────────────────────────────────────────────────┘  │
  │                                                             │
  │  ┌─ Push ──────────────────────────────────────────────┐   │
  │  │  For each dirty entry:                               │   │
  │  │    Read encrypted record from local                  │   │
  │  │    PUT to remote (expectedVersion check)             │   │
  │  │    Success → remove from dirty log                   │   │
  │  │    Conflict (409) → add to conflicts                 │   │
  │  │    Network error → skip, retry next push             │   │
  │  └─────────────────────────────────────────────────────┘   │
  │                                                             │
  │  ┌─ Pull ──────────────────────────────────────────────┐   │
  │  │  Fetch all remote records (or delta since lastPull)  │   │
  │  │  For each:                                           │   │
  │  │    Missing locally → save                            │   │
  │  │    Older locally → update                            │   │
  │  │    Same version → skip                               │   │
  │  │    Both changed → conflict                           │   │
  │  └─────────────────────────────────────────────────────┘   │
  │                                                             │
  │  ┌─ Conflict Strategies ────────────────────────────────┐  │
  │  │  'version'      Higher version wins (default)        │  │
  │  │  'local-wins'   Always keep local                    │  │
  │  │  'remote-wins'  Always accept remote                 │  │
  │  │  custom fn      (conflict) => 'local' | 'remote'    │  │
  │  └─────────────────────────────────────────────────────┘  │
  │                                                             │
  │  New: ping() ──▶ adapter.ping?.() for health check         │
  │  New: events ──▶ sync:push, sync:pull, sync:conflict       │
  │                  sync:online, sync:offline                  │
  └─────────────────────────────────────────────────────────────┘
```

#### DynamoDB Single-Table Design

```
  Table: noydb-prod
  ┌──────────┬───────────────────┬────┬─────────┬──────┬───────────┐
  │ pk (PK)  │ sk (SK)           │ _v │ _ts     │ _iv  │ _data     │
  ├──────────┼───────────────────┼────┼─────────┼──────┼───────────┤
  │ C101     │ invoices#inv-001  │ 3  │ 2026-.. │ a3f2 │ U2Fsd...  │
  │ C101     │ invoices#inv-002  │ 1  │ 2026-.. │ b4g3 │ R3dhY...  │
  │ C101     │ payments#pay-001  │ 2  │ 2026-.. │ c5h4 │ Tm95d...  │
  │ C101     │ _keyring#owner-01 │    │         │      │ {keyring} │
  │ C101     │ _sync#meta        │    │         │      │ {meta}    │
  │ C102     │ invoices#inv-001  │ 1  │ 2026-.. │ d6i5 │ Zw9vZ...  │
  └──────────┴───────────────────┴────┴─────────┴──────┴───────────┘

  Optimistic concurrency:
  ConditionExpression: '#v = :expected OR attribute_not_exists(pk)'
```

#### Phase 3 Tests

| Test Suite | What It Tests | Count |
|-----------|--------------|:-----:|
| `sync.test.ts` | Dirty log persist/clear, conflict detection | ~8 |
| DynamoDB conformance | Full adapter-conformance suite (Docker) | 22 |
| Sync simulation | Two-instance push/pull/conflict scenarios | ~12 |
| Offline-online simulation | Network toggle, dirty accumulation, auto-push | ~8 |
| **Total** | | **~50** |

#### CI Addition

```yaml
services:
  dynamodb-local:
    image: amazon/dynamodb-local
    ports: ['8000:8000']
```

#### Acceptance Criteria

- [ ] Dirty log persists across restarts
- [ ] All 4 conflict strategies work (version, local-wins, remote-wins, custom)
- [ ] DynamoDB adapter passes full conformance suite
- [ ] Two-instance sync simulation passes
- [ ] Offline → online transitions without data loss
- [ ] `ping()` correctly detects connectivity

---

### Phase 4 — Browser Adapter + WebAuthn + Vue + Adapter Composition

**Goal:** Browser storage, biometric auth, Vue composables, and the `withCache()` composition pattern.

#### New Packages

```
packages/adapter-browser/src/
└── index.ts       browser() — localStorage (<5MB) / IndexedDB (>5MB)

packages/vue/src/
├── index.ts
├── plugin.ts       Vue/Nuxt plugin providing Noydb instance
├── useNoydb.ts     Composable: injected db instance
├── useCollection.ts  Reactive collection data (auto-refetch on change)
├── useQuery.ts     Reactive filtered query (NEW — innovation)
└── useSync.ts      Reactive sync status + push/pull
```

#### Core Additions

- **`biometric.ts`** — WebAuthn enrollment/unlock (wraps KEK with credential-derived key)
- **`compose.ts`** — `withCache(cacheAdapter, remoteAdapter)` composition (NEW)
- **`sync.ts`** — Auto-sync: `online`/`offline` event listeners, optional periodic interval

#### Adapter Composition Detail

```ts
// Usage:
const db = await createNoydb({
  adapter: withCache(browser(), dynamo({ table: 'prod' })),
  user: 'owner-01',
  secret: 'passphrase',
})

// Behavior:
// READ:  try cache first → miss → fetch remote → populate cache → return
// WRITE: write to cache AND remote (cache-aside)
// loadAll: remote is authoritative, cache is populated after
```

#### Phase 4 Tests

| Test Suite | What It Tests |
|-----------|--------------|
| Browser conformance | adapter-conformance in jsdom/happy-dom |
| Biometric tests | Mocked WebAuthn API |
| Vue composable tests | vue-test-utils |
| withCache tests | Cache-miss, cache-hit, write-through |

#### Acceptance Criteria

- [ ] Browser adapter passes conformance suite
- [ ] Biometric enroll/unlock works with mocked WebAuthn
- [ ] Vue composables reactive: data updates when collections change
- [ ] `useQuery()` auto-updates on underlying data change
- [ ] `withCache()` read/write-through behavior correct

---

### Phase 5 — S3 Adapter + Polish + Publish

**Goal:** Final adapter, migration utility, documentation, npm publish.

#### New Package

```
packages/adapter-s3/src/
└── index.ts       s3({ bucket, prefix?, region? }) — ETags for concurrency
```

#### Core Additions

- **`migrate.ts`** — `migrate({ from, to, compartments, onProgress })` (NEW)
- **`validation.ts`** — Passphrase strength validation (entropy check)
- **`session.ts`** — Session timeout: auto-clear KEK/DEKs after configurable duration
- **`noydb.ts`** — `db.close()` explicit key clearing

#### Documentation Plan

| Doc | Content |
|-----|---------|
| `README.md` | Badges, install profiles, quick start, API overview |
| `docs/getting-started.md` | Step-by-step first app tutorial |
| `docs/api-reference.md` | Typedoc-generated API reference |
| `docs/security-model.md` | Threat model, crypto details, recommendations |
| `docs/adapters.md` | All adapters, custom adapter guide, `defineAdapter` |
| `docs/sync.md` | Sync engine, conflict strategies, offline patterns |
| `docs/multi-user.md` | Roles, grant/revoke, key rotation |
| `docs/migration.md` | `migrate()` utility, adapter switching guide |

#### Final Quality Gates

- [ ] All 5 adapters pass conformance suite (memory, file, dynamo, browser, s3)
- [ ] All 6 simulation harnesses pass
- [ ] Benchmarks recorded as baseline
- [ ] 90%+ code coverage on core
- [ ] `pnpm pack --dry-run` clean for every package
- [ ] Typedoc generation succeeds
- [ ] `migrate()` tested: file → dynamo, browser → s3
- [ ] First npm publish: `@noydb/core@0.1.0` + all adapters

---

## Dependency Budget

```
  ┌────────────────────┬─────────────────┬──────────────────────────┐
  │ Package            │ Runtime deps    │ Peer deps                │
  ├────────────────────┼─────────────────┼──────────────────────────┤
  │ @noydb/core        │ 0               │ —                        │
  │ @noydb/memory      │ 0               │ @noydb/core              │
  │ @noydb/file        │ 0 (node:fs)     │ @noydb/core              │
  │ @noydb/dynamo      │ 0               │ @noydb/core,             │
  │                    │                 │ @aws-sdk/lib-dynamodb     │
  │ @noydb/s3          │ 0               │ @noydb/core,             │
  │                    │                 │ @aws-sdk/client-s3        │
  │ @noydb/browser     │ 0               │ @noydb/core              │
  │ @noydb/vue         │ 0               │ @noydb/core, vue         │
  ├────────────────────┼─────────────────┼──────────────────────────┤
  │ TOTAL RUNTIME DEPS │ 0               │ (peers provided by user) │
  └────────────────────┴─────────────────┴──────────────────────────┘

  Zero. Runtime. Dependencies.
  AWS SDKs and Vue are peer deps — the user's app already has them.
```

---

## Performance Targets

```
  ┌────────────────────────────────────┬─────────────┬──────────────────────┐
  │ Operation                          │ Target      │ Notes                │
  ├────────────────────────────────────┼─────────────┼──────────────────────┤
  │ Open + decrypt 1,000 records       │ < 500ms     │ AES-GCM is HW-accel │
  │ Single put (encrypt + write)       │ < 5ms       │ 1 encrypt + 1 write  │
  │ Single get (read + decrypt)        │ < 2ms       │ 1 read + 1 decrypt   │
  │ List 1,000 records (in memory)     │ < 1ms       │ Already loaded       │
  │ Query filter 1,000 records         │ < 1ms       │ Array.filter()       │
  │ Key rotation (re-encrypt 1,000)    │ < 1s        │ Bulk re-encrypt      │
  │ PBKDF2 key derivation              │ ~200ms      │ 600K iter, by design │
  │ Full backup dump                   │ < 200ms     │ Serialize ciphertext │
  │ Sync push (100 dirty records)      │ < 2s        │ Network-dependent    │
  │ 1,000 encrypts (benchmark)         │ < 500ms     │ CI performance gate  │
  └────────────────────────────────────┴─────────────┴──────────────────────┘
```

---

## Verification Checklist (Run After Each Phase)

```bash
pnpm turbo lint                    # zero warnings
pnpm turbo typecheck               # zero errors
pnpm turbo test                    # all tests pass
pnpm turbo build                   # ESM + CJS + .d.ts

# Verify lean production packages:
for pkg in packages/*/; do
  cd "$pkg" && pnpm pack --dry-run 2>&1 \
    | grep -E '\.(test|spec)\.' \
    && echo "FAIL: test files in $pkg" && exit 1
  cd -
done
```

For DynamoDB tests (Phase 3+):
```bash
docker run -d -p 8000:8000 amazon/dynamodb-local
pnpm vitest run --project adapter-dynamo
```

---

## Quick Reference — Encrypted Envelope

```
  On disk / DynamoDB / S3:

  ┌──────────────────────────────────────────────────────────┐
  │ {                                                        │
  │   "_noydb": 1,              ← format version (plain)    │
  │   "_v": 3,                  ← record version (plain)    │
  │   "_ts": "2026-04-04T...",  ← timestamp (plain)         │
  │   "_iv": "a3f2b8c1d4e5..", ← 12-byte IV (plain)        │
  │   "_data": "U2FsdGVk..."   ← AES-256-GCM ciphertext    │
  │ }                                ▲                       │
  │                                  │                       │
  │                         This is ALL the adapter sees.    │
  │                         Plaintext? Never reaches here.   │
  └──────────────────────────────────────────────────────────┘

  _v and _ts are unencrypted so the sync engine can compare
  versions WITHOUT needing the encryption key.
```

---

*Roadmap v2.0 — 2026-04-05*
*Companion to NOYDB_SPEC.md v1.0.0*
