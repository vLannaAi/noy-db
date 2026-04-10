# Roadmap

> **Current:** v0.11.0 shipped — 15 packages on the hub/to-*/in-* taxonomy. **Next:** v0.12 — developer experience.
>
> Related docs:
> - [Architecture](./docs/architecture.md) — data flow, key hierarchy, threat model
> - [Deployment profiles](./docs/deployment-profiles.md) — pick your stack
> - [Getting started](./docs/getting-started.md) — install and first app
> - [Spec](./SPEC.md) — invariants (do not violate)

---

## Status

v0.11.0 is the current codebase (2026-04-10). **15 packages** on the **hub / to-* / in-*** naming taxonomy. Full surface from v0.5 through v0.11: zero-knowledge encryption, multi-user ACL, query DSL (joins, aggregations, streaming), sync v2 (CRDT, presence, partial), i18n primitives, identity/sessions, `.noydb` container format, store rename (NoydbStore / createStore / Vault), browser store split, AWS store renames, IndexedDB CAS fix, and the v0.11 package taxonomy rename. **1065 tests** passing.

npm publishing is **paused** pending registry cleanup — see HANDOVER.md.

---

## Releases

| Version  | Status          | Theme                            |
|---------:|-----------------|----------------------------------|
| 0.5–0.11 | ✅ shipped      | Core library + all renames       |
| **0.12** | 🔨 **next**     | **Developer experience**         |
| 0.13     | 📋 planned      | Store expansion                  |
| 0.14     | 📋 planned      | Framework integrations           |
| 1.0      | 📋 planned      | Stability + LTS release          |
| 1.x      | 🔭 vision       | Edge & realtime                  |
| 2.0      | 🔭 vision       | Federation                       |

---

## Guiding principles

Every future release respects these:

1. **Zero-knowledge stays zero-knowledge.** Adapters never see plaintext.
2. **Memory-first is the default.** Streaming, pagination, and lazy hydration are opt-in.
3. **Zero runtime crypto deps.** Web Crypto API only.
4. **Six-method store contract is sacred.** New capabilities go in core or in optional store extension interfaces.
5. **Pinia/Vue ergonomics are first-class.** If a feature makes Vue/Nuxt/Pinia adoption harder, it gets redesigned.
6. **Every feature ships with a `playground/` example** before it's documented as stable.

---

## v0.12 — Developer experience

**Goal:** Make the day-to-day development loop fast and observable — local debugging, store health checks, devtools, and scaffolder improvements. All tooling features that were deferred from v0.11 (which became the package rename) land here.

### store-probe (#146)

`@noy-db/store-probe` — setup-time suitability test and runtime reliability monitor for any attached store. Two modes:

- **`probeStore(store, options?)`** (setup-time) — runs a battery of round-trip checks (put/get/delete, CAS atomicity, list semantics) and returns a structured `ProbeReport` with pass/fail per capability. Throws `StoreSuitabilityError` on hard failures. Designed to be called once during app startup in dev/staging.
- **`monitorStore(store, options?)`** (runtime) — wraps a store instance and tracks per-operation latency, error rates, and CAS retry counts. Exposes `store.monitor.stats()` and emits `probe:degraded` events when thresholds are crossed.

Both work against any `NoydbStore` implementation — the probe is the canonical way to validate a custom store before shipping it.

### Naked mode (#106)

Dev-only plaintext storage mode for debugging — opt-in with heavy guardrails:

- `NoydbOptions.naked: true` disables AES-GCM and stores records as cleartext JSON
- Unconditionally throws in production (`process.env.NODE_ENV === 'production'`)
- Throws if hostname is not `localhost` / `127.0.0.1`
- Requires `acknowledge: 'I understand this stores plaintext'` string in options
- Stamps every envelope with `_naked: true` so naked-mode data is never silently loaded by an encrypted instance

Use case: debugging query plans, verifying record shapes, profiling without crypto overhead.

### .noydb reader — CLI + browser extension (#102)

`noydb inspect <file.noydb>` CLI command and companion browser extension for reading `.noydb` bundle files without writing code:

- CLI: prints bundle header (handle, format version, body size, sha256), then decrypts and pretty-prints records given a passphrase
- Browser extension: drag-and-drop `.noydb` files, enter passphrase, browse vaults/collections in a tree view
- Both are read-only — no write path

### Nuxt devtools tab

`@noy-db/in-nuxt` devtools integration via `@nuxt/devtools-kit`:

- Vault/collection tree in the devtools panel
- Live sync status and ledger tail viewer
- Query playground — run `.query()` chains from the browser devtools

### `nuxi noydb` CLI extension

`nuxi noydb <cmd>` integration for Nuxt projects:

- `nuxi noydb inspect` — inspect a `.noydb` bundle
- `nuxi noydb probe` — run store-probe against the configured adapter
- `nuxi noydb migrate` — run keyring/envelope migrations across a vault directory

### Scaffolder templates (#39)

`create-noy-db` new templates:

- **`vite-vue`** — plain Vite + Vue 3, no Nuxt, with `@noy-db/in-vue` + `@noy-db/to-browser-idb`
- **`electron`** — Electron desktop app with `@noy-db/to-file` on the main process, `@noy-db/in-vue` renderer
- **`vanilla`** — zero-framework, TypeScript only with `@noy-db/hub` + `@noy-db/to-browser-idb`

---

## v0.13 — Store expansion

| Store                           | Why                                                                  |
|---------------------------------|----------------------------------------------------------------------|
| `@noy-db/to-cloudflare-r2`      | Cheap S3-compatible, no egress fees                                  |
| `@noy-db/to-cloudflare-d1`      | SQLite at the edge, free tier                                        |
| `@noy-db/to-supabase`           | One-click Postgres + storage                                         |
| `@noy-db/to-ipfs`               | Content-addressed; fits the hash-chain ledger naturally              |
| `@noy-db/to-git`                | Vault = git repo, history = commits, sync = push/pull                |
| `@noy-db/to-webdav`             | Nextcloud, ownCloud, any WebDAV server                               |
| `@noy-db/to-sqlite`             | Single-file backend (better than JSON for >10K records)              |
| `@noy-db/to-turso`              | Edge SQLite with replication                                         |
| `@noy-db/to-firestore`          | Firebase teams                                                       |
| `@noy-db/to-postgres`           | Postgres `jsonb` column, single-table pattern                        |

Also tracked in this milestone: `NoydbBundleAdapter` interface (#103), `syncPolicy` debounce/interval scheduling (#101), Google Drive bundle adapter (#104), encrypted binary attachment store (#105), `@noy-db/decrypt-sql` (#107), SQL-backed adapters (#108).

---

## v0.14 — Framework integrations

Pinia/Vue/Nuxt already ship. v0.14 brings the same first-class story to other ecosystems.

| Package                         | Provides                                                       |
|---------------------------------|----------------------------------------------------------------|
| `@noy-db/in-react`              | `useNoydb`, `useCollection`, `useQuery`, `useSync` hooks       |
| `@noy-db/in-svelte`             | Reactive stores                                                |
| `@noy-db/in-solid`              | Signals                                                        |
| `@noy-db/in-qwik`               | Resumable queries                                              |
| `@noy-db/in-tanstack-query`     | Query function adapter — paginate/infinite-scroll              |
| `@noy-db/in-tanstack-table`     | Bridge for the existing `useSmartTable` pattern                |
| `@noy-db/in-zustand`            | Zustand store factory mirroring `defineNoydbStore`             |

All share one core implementation; framework packages stay thin (~200 LoC each).

---

## v1.0 — Stability + LTS release

- API freeze. Every public symbol marked `@stable`. Semver enforced.
- Third-party security audit of crypto, sync, and access control.
- Performance benchmarks published; tracked in CI with regression alerts.
- Migration tooling: `noydb migrate --from 0.x` for envelope/keyring schema changes.
- Documentation site with searchable API docs, recipes, video walkthroughs.
- LTS branch with security backports for 18 months.

---

## v1.x — Edge & realtime

- **Edge worker adapter.** NOYDB inside Cloudflare Workers / Deno Deploy / Vercel Edge.
- **WebRTC peer sync (`@noy-db/p2p`).** Direct browser-to-browser, encrypted, no server in the middle. TURN fallback only sees ciphertext.
- **Encrypted BroadcastChannel.** Multi-tab session and hot cache sharing.
- **Reactive subscriptions over the wire.** `collection.subscribe(query, callback)` works across tabs, peers, and edge workers.

---

## v2.0 — Federation & verifiable credentials

- **Multi-instance federation.** Two vaults at two organizations share a *bridged collection* via ECDH-derived session keys; each side keeps its own DEK.
- **Verifiable credentials (W3C VC).** Sign records as VCs; pairs with the hash-chained ledger for non-repudiation.
- **Zero-knowledge proofs.** "I have at least N invoices over $X without showing them" via zk-SNARKs. Gated by a real use case.

---

## Plaintext export packages — `@noy-db/decrypt-*`

> Spawned from discussion vLannaAi/noy-db#70.

`vault.dump()` produces an **encrypted, tamper-evident envelope** for backup and transport. It is the right answer when bytes are leaving an active session and need to remain protected. It is the **wrong answer** when a downstream tool needs to read records as plaintext in a standard format.

### Naming policy: `@noy-db/decrypt-{format}`

Named `@noy-db/decrypt-*` instead of `@noy-db/export-*` deliberately. The word **"decrypt"** in the package name forces the consumer to acknowledge what they are actually doing — it shows up in `package.json`, imports, the lockfile, `npm audit`, and every code review. That visibility is the entire point.

```ts
import { decryptToCSV }  from '@noy-db/decrypt-csv'
import { decryptToXML }  from '@noy-db/decrypt-xml'
import { decryptToXLSX } from '@noy-db/decrypt-xlsx'
```

| Package                  | Deps                                  | Target              |
|--------------------------|---------------------------------------|---------------------|
| `@noy-db/decrypt-csv`    | Zero. ~50 LOC.                        | opportunistic       |
| `@noy-db/decrypt-xml`    | Zero. Hand-rolled ~200–300 LOC.       | opportunistic       |
| `@noy-db/decrypt-xlsx`   | Peer dep on `xlsx` or `exceljs`.      | v0.9+               |

Every `@noy-db/decrypt-*` README starts with an explicit warning block: what plaintext-on-disk means, when use is legitimate, and a pointer to `dump()` for the encrypted path.

JSON is **not** in this family — `exportJSON()` lives in `@noy-db/hub` (zero-dep, five lines, same warning in docs).

---

## Cross-cutting investments

- **Bundle size budget.** Core under 30 KB gzipped. Each store under 10 KB.
- **Tree-shakeable feature flags.** Indexes, ledger, schema validation each cost zero bytes if unused.
- **WASM crypto fast path.** Optional accelerator for >10MB bulk encrypts. Never a dependency.
- **Accessibility.** Vue/Nuxt UI primitives produce ARIA-correct output.
- **i18n of error messages.** Especially Thai, given the first consumer.
- **Telemetry.** Opt-in only, local-first. `noydb stats` shows your own usage; nothing leaves the device.

---

## Contributing

Open a discussion before opening a PR that touches anything past v0.12 — the further out on the roadmap, the more likely the design will shift. Anything that violates the *Guiding principles* is out of scope, no matter how exciting.

---

*Roadmap last updated: noy-db v0.11.0 — 2026-04-10*
