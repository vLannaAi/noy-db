<div align="center">

<sub><a href="https://github.com/vLannaAi/noy-db-docs/blob/main/content/docs/th/README.md">🇹🇭 ภาษาไทย</a></sub>

<img alt="noy-db logo" src="https://raw.githubusercontent.com/vLannaAi/noy-db-docs/main/content/docs/assets/brand.svg" width="180">

# noy-db

## None Of Your DataBase
<sub><em>(formerly shortened as: "None Of Your <strong>Damn Business</strong>")</em></sub>

**Your data. Your device. Your keys. Nobody else's server.**

An encrypted, offline-first, **serverless** document store. The library lives inside your app, stores in whatever backend you choose, and nobody in the middle ever sees plaintext — not the cloud provider, not the sysadmin, not the database vendor. Not noy-db either.

[![npm](https://img.shields.io/npm/v/@noy-db/hub.svg?label=%40noy-db%2Fhub)](https://www.npmjs.com/package/@noy-db/hub)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-18%2B-green.svg)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-Strict-blue.svg)](https://www.typescriptlang.org)
[![Runtime Deps](https://img.shields.io/badge/Runtime_Deps-0-brightgreen.svg)](#zero-dependencies)
[![Crypto](https://img.shields.io/badge/Crypto-Web_Crypto_API-purple.svg)](#encryption)

</div>

---

> 📚 **Documentation, tutorials, showcases, and recipes live in [noy-db-docs](https://github.com/vLannaAi/noy-db-docs)** — the docs site, the 00-49 numbered showcase suite, the CLI/Nuxt playgrounds, and the runnable starter recipes all moved there. This repo stays a lean, production package tree.

---

## What makes noy-db different

- **🔒 Hard privacy by construction.** Stores only ever see ciphertext. AES-256-GCM with per-user keys derived from a secret via PBKDF2. Breach the cloud, subpoena the provider, lose the USB stick — **every one of those surfaces already holds ciphertext**. Zero crypto dependencies — only the Web Crypto API.
- **☁️ Serverless, runs anywhere.** No noy-db server. No Docker. No managed service. The library embeds in your app — ~30 KB, 0 runtime deps. Works in Node 18+, Bun, Deno, every modern browser, Cloudflare Workers, Electron, mobile PWAs.
- **📴 Offline-first.** Every operation works without network. Sync when you want to, to whatever you want to. Single code path for online and offline — no "online mode" to toggle.
- **👥 Multi-user, no auth server.** 5 roles (owner / admin / operator / viewer / client), per-collection permissions, key rotation on revoke. The keyring travels with the data.
- **🧩 One core, many bridges.** `@noy-db/hub` is the encrypted document-store core. ~60 optional `to-*` / `in-*` / `on-*` / `as-*` / `by-*` / `at-*` packages let existing apps keep their preferred storage, framework, unlock method, export format, session-share transport, and server-side sealing host — without changing anything else.
- **🔐 Advanced crypto features.** Hierarchical per-record tiers, deterministic encryption for searchable indexes, WebRTC peer-to-peer sync, AES-256-GCM blob store with deduplication, HKDF-keyed ETags, hash-chained audit ledger.
- **🧪 Thousand-plus tests, CI in under a minute.** Every store / integration / auth / export package is mock-tested — CI runs without AWS, Google Drive, SFTP servers, or any real service.

> **`@noy-db/hub` is the trust boundary.** Encryption happens in the core before data reaches any store. The `to-*`, `in-*`, `on-*`, `as-*`, and `by-*` bridges **never see plaintext** — zero-knowledge by construction.
>
> **Two trust boundaries.** The `at-*` family is the one deliberate exception: a sealing-key host *you* control (Lambda, EC2, a worker) **can decrypt the scoped slice it unseals** — that's the point, so you can run server-side work for users who never hold a key. You trust it because it's your infrastructure and the key lives in your managed key store; least privilege via per-user sealed credentials. Offline-first by default; online when you want.
>
> **Pre-1.0 stance.** The core privacy model, envelope format, keyrings, permissions, and query DSL are implemented and tested. Public APIs may still change based on adopter feedback before 1.0; data migrations and security-critical changes will be documented. No third-party cryptographic audit yet — that is a v1.0 target.

---

## 30-second vanilla example

The minimum — no framework, no cloud, nothing to install beyond `@noy-db/hub`:

```ts
import { createNoydb } from '@noy-db/hub'

const db = await createNoydb({       // zero-config: in-memory by default (built-in store)
  user: 'alice',
  secret: 'correct-horse-battery-staple',
})

const vault = await db.openVault('acme')
const invoices = vault.collection<{ id: string; amount: number }>('invoices')

await invoices.put('inv-001', { id: 'inv-001', amount: 1200 })
console.log(await invoices.get('inv-001'))   // { id: 'inv-001', amount: 1200 }

await db.close()                               // clears keys from memory
```

`createNoydb()` needs no `store` — it uses a **built-in in-memory store** by default (non-persistent). For tests wanting the fuller in-memory backend (adds `listVaults`/`tx`/`listPage`), add **[`@noy-db/to-memory`](https://github.com/vLannaAi/noy-db-docs/blob/main/content/docs/packages/to-stores.md)** and pass `store: toMemory()`.

**Swap storage with one line** — keep the rest identical:

```ts
// Persist to disk
import { toFile } from '@noy-db/to-file'
store: toFile({ dir: './data' })

// Browser (IndexedDB)
import { idbStore } from '@noy-db/to-browser-idb'
store: idbStore()
```

Extended cloud and SQL backends (`@noy-db/to-aws-dynamo`, `@noy-db/to-aws-s3`, `@noy-db/to-postgres`, and 13 more) live in the **[noy-db-to](https://github.com/vLannaAi/noy-db-to)** companion repo — same npm names, separate install.

→ Full store catalog: **[Storage stores (`to-*`)](https://github.com/vLannaAi/noy-db-docs/blob/main/content/docs/packages/to-stores.md)**.

---

## The 24-service catalog

A minimalist core (~6,500 LOC) plus 24 opt-in capabilities behind `with*()` strategy seams. Apps that don't import a strategy ship none of its code.

```ts
import { createNoydb } from '@noy-db/hub'
import { withHistory } from '@noy-db/hub/history'
import { withAggregate } from '@noy-db/hub/aggregate'
import { withBlobs } from '@noy-db/hub/blobs'

const db = await createNoydb({
  store: ...,
  user: ...,
  historyStrategy: withHistory(),     // versioning + ledger + time-machine
  aggregateStrategy: withAggregate(), // sum/groupBy/avg
  blobsStrategy: withBlobs(),          // file attachments
  // ... 21 more available
})
```

| Cluster | Services |
|---|---|
| **Read & Query** | [indexing](https://github.com/vLannaAi/noy-db-docs/blob/main/content/docs/services/indexing.md) · [joins](https://github.com/vLannaAi/noy-db-docs/blob/main/content/docs/services/joins.md) · [aggregate](https://github.com/vLannaAi/noy-db-docs/blob/main/content/docs/services/aggregate.md) · [live](https://github.com/vLannaAi/noy-db-docs/blob/main/content/docs/services/live.md) |
| **Write & Mutate** | [history](https://github.com/vLannaAi/noy-db-docs/blob/main/content/docs/services/history.md) · [transactions](https://github.com/vLannaAi/noy-db-docs/blob/main/content/docs/services/transactions.md) · [crdt](https://github.com/vLannaAi/noy-db-docs/blob/main/content/docs/services/crdt.md) |
| **Derived data** | [derivations](https://github.com/vLannaAi/noy-db-docs/blob/main/content/docs/services/derivations.md) · [materialized-views](https://github.com/vLannaAi/noy-db-docs/blob/main/content/docs/services/derivations.md#materialized-views) · [overlay-views](https://github.com/vLannaAi/noy-db-docs/blob/main/content/docs/services/derivations.md#overlay-views) |
| **Data Shape** | [blobs](https://github.com/vLannaAi/noy-db-docs/blob/main/content/docs/services/blobs.md) · [i18n](https://github.com/vLannaAi/noy-db-docs/blob/main/content/docs/services/i18n.md) |
| **Time & Audit** | [periods](https://github.com/vLannaAi/noy-db-docs/blob/main/content/docs/services/periods.md) · [consent](https://github.com/vLannaAi/noy-db-docs/blob/main/content/docs/services/consent.md) · [guards](https://github.com/vLannaAi/noy-db-docs/blob/main/content/docs/services/guards.md) |
| **Snapshot & Portability** | [shadow](https://github.com/vLannaAi/noy-db-docs/blob/main/content/docs/services/shadow.md) · [bundle](https://github.com/vLannaAi/noy-db-docs/blob/main/content/docs/services/bundle.md) |
| **Collaboration & Auth** | [sync](https://github.com/vLannaAi/noy-db-docs/blob/main/content/docs/services/sync.md) · [team](https://github.com/vLannaAi/noy-db-docs/blob/main/content/docs/services/team.md) · [session](https://github.com/vLannaAi/noy-db-docs/blob/main/content/docs/services/session.md) |
| **Operations** | [routing](https://github.com/vLannaAi/noy-db-docs/blob/main/content/docs/services/routing.md) |

→ Full catalog: **[SERVICES.md](SERVICES.md)**
→ Starter recipes: **[noy-db-docs/content/docs/recipes](https://github.com/vLannaAi/noy-db-docs/tree/main/content/docs/recipes)** — personal-notebook · accounting-app · realtime-crdt-app · analytics-app

---

## Try it — playground + showcases

Playground apps and the showcase suite now live in **[noy-db-docs](https://github.com/vLannaAi/noy-db-docs)**:

- **[`playground/cli/`](https://github.com/vLannaAi/noy-db-docs/tree/main/playground/cli)** — guided 5-minute CLI walkthrough. Shows CRUD, multi-user, sync, backup.
- **[`playground/nuxt/`](https://github.com/vLannaAi/noy-db-docs/tree/main/playground/nuxt)** — runnable Nuxt 4 reference app (invoices, multi-tenant, biometric unlock, magic-link client portal).
- **[`showcases/`](https://github.com/vLannaAi/noy-db-docs/tree/main/showcases)** — 50 progressive end-to-end tests that double as tutorials. Numbered 00-49 across storage, multi-user, services, auth, exports, frameworks, and session-share transports — pick a feature and read the runnable code. Plus recipe tests verifying the starter applications.

---

## The six package families

Each prefix reads as a preposition — the mental model stays the same as you scale from one-file vaults to multi-tenant cloud deployments.

| Prefix | Reads as | What it is | Catalog |
|---|---|---|---|
| **`to-`** | *"data goes **to** a backend"* | **Storage destinations** — the only piece that touches ciphertext on the wire. 5 essentials (`to-file`, `to-memory`, `to-browser-idb`, `to-probe`, `to-meter`) in this repo; extended cloud/SQL/remote-FS backends in [noy-db-to](https://github.com/vLannaAi/noy-db-to). | [→ stores.md](https://github.com/vLannaAi/noy-db-docs/blob/main/content/docs/packages/to-stores.md) |
| **`in-`** | *"runs **in** a framework"* | **Framework integrations** — thin reactive bindings. React, Next.js, Vue, Nuxt, Pinia, Svelte, Zustand, TanStack Query/Table, Yjs CRDT, LLM tool-calling. | [→ integrations.md](https://github.com/vLannaAi/noy-db-docs/blob/main/content/docs/packages/in-integrations.md) |
| **`on-`** | *"you get **on** via this method"* | **Unlock / auth** — composable primitives. Passkeys (WebAuthn), OIDC split-key, magic links, TOTP, email OTP, recovery codes, Shamir k-of-n, duress + honeypot. | [→ auth.md](https://github.com/vLannaAi/noy-db-docs/blob/main/content/docs/packages/on-auth.md) |
| **`as-`** | *"export **as** XLSX / JSON / …"* | **Portable artefacts** — two-tier authorisation with audit ledger. CSV, Excel, XML, JSON, NDJSON, SQL dump, PDF blobs, ZIP, and the encrypted `.noydb` bundle. | [→ exports.md](https://github.com/vLannaAi/noy-db-docs/blob/main/content/docs/packages/as-exports.md) |
| **`by-`** | *"sync **by** way of …"* | **Session-share transports** — live-state bridges between realms. `@noy-db/by-peer` (WebRTC peers, renamed from `@noy-db/p2p`) and `@noy-db/by-tabs` (BroadcastChannel multi-tab) ship today; `by-server`, `by-room` reserved. | [→ transports.md](https://github.com/vLannaAi/noy-db-docs/blob/main/content/docs/packages/by-transports.md) |
| **`at-`** | *"sealed **at** a trusted host"* | **Sealing-key providers** — the online complement to offline-first. A host you control unseals a scoped slice for server-side work (it *can* decrypt what it unseals — the one non-zero-knowledge family). `at-env`, `at-macos-keychain`, `at-aws-kms`, `at-gcp-kms`, `at-azure-keyvault`. | [→ at-hosts.md](https://github.com/vLannaAi/noy-db-docs/blob/main/content/docs/packages/at-hosts.md) |

Plus the hub (`@noy-db/hub`) and the standalone tools: `@noy-db/cli`, `create-noy-db` (scaffolder).

> **Maturity at a glance.** `@noy-db/hub` is **Core** — security-critical, highest test bar. `to-memory`, `to-file`, `to-browser-idb` are **Recommended** essentials that ship here. Cloud/SQL backends (`to-aws-dynamo`, `to-aws-s3`, `to-postgres`, etc.) are in [noy-db-to](https://github.com/vLannaAi/noy-db-to) — same quality bar, separate repo. Most other satellites are **Bridges** — thin adapters proven in tests but less production-battled. P2P, niche stores, and unusual auth modes are **Experimental** — useful, validate before depending on them.

---

## Schema-driven UI

Two sibling packages — `@noy-db/ui` and `@noy-db/ui-nuxt` — ship from a separate repo ([`vLannaAi/noy-db-ui`](https://github.com/vLannaAi/noy-db-ui)) but publish under the same `@noy-db` npm org. They are a **domain-free, schema-driven** search/list/detail layer that renders itself from `collection.describe()` — the field-metadata surface the hub exposes (labels, types, dictKey enums, PII masking, i18n, JSON-Schema) — so you don't hand-write forms or tables for each collection. `@noy-db/ui` is the framework-agnostic engine plus design tokens; `@noy-db/ui-nuxt` is the Nuxt module and components built on it. They stay on the *right* side of the trust boundary: the UI only ever touches records the hub has **already decrypted in-process**, never ciphertext or keys, and they peer-depend on `@noy-db/hub` by published-version range on their own independent release line.

---

## Querying without SQL

The store never sees plaintext, so it never runs your query. The query DSL lives inside `@noy-db/hub` and runs **after decryption** — the storage backend stays a dumb, untrusted ciphertext store.

```ts
await invoices.query()
  .where('status', '==', 'issued')
  .where('clientId', '==', 'c-42')
  .orderBy('issuedAt', 'desc')
  .toArray()

// Intra-vault joins, live queries, aggregations, streaming
invoices.query().join<'client', Client>('clientId', { as: 'client' }).toArray()
invoices.query().where(...).live().subscribe(() => render())
invoices.query().groupBy('clientId').aggregate({ total: sum('amount') }).run()
for await (const r of invoices.scan()) { /* backpressure-friendly */ }
```

Joins are **intra-vault and core-side** — no backend ever inspects plaintext fields. Cross-vault correlation is explicit via `queryAcross`. Huge relational workloads are still better served by a real database; noy-db is for sensitive, small-to-mid datasets where the trust boundary matters more than query throughput.

**Private, AI-ready retrieval.** On top of the query DSL, `collection.retrieve(query)` adds a ranked search tier that — like everything else — runs *after decryption*, so no plaintext, no embedding, and no query ever leaves the process. It layers from client-side lexical ranking, to an optional persisted lexical index, to encrypted-local **semantic/vector** search (cosine over locally-computed embeddings), to a **hybrid** mode that fuses lexical and semantic results with reciprocal-rank fusion. The fusion primitive (`fuseRetrieval`) is exported from `@noy-db/hub/cargo` (the klum orchestration seam), so an orchestrator can federate ranked result-sets across many vaults without any of them sharing plaintext.

```ts
const hits = await invoices.retrieve('overdue acme', { mode: 'hybrid', limit: 10 })
```

---

## The 6-method store contract

```ts
get(vault, collection, id)
put(vault, collection, id, envelope, expectedVersion?)
delete(vault, collection, id)
list(vault, collection)
loadAll(vault)
saveAll(vault, data)
```

> If your existing storage can implement these six methods, it can store noy-db ciphertext. That is the full contract — the kernel ships a **built-in in-memory store** (so `store` is optional for the in-memory case); 5 essential `to-*` stores ship here for persistence and the fuller in-memory backend; 16 extended stores (SQL, cloud, remote-FS, personal drives) live in [noy-db-to](https://github.com/vLannaAi/noy-db-to). A custom store is `createStore(opts => ({ name, ...methods }))`.

---

## Install for common scenarios

```bash
# Development / testing — in-memory, no persistence (built-in; nothing to add)
pnpm add @noy-db/hub
# …or the fuller in-memory test store (adds listVaults / tx / listPage):
pnpm add @noy-db/hub @noy-db/to-memory

# Local CLI / Node service — files on disk
pnpm add @noy-db/hub @noy-db/to-file

# Browser app with IndexedDB
pnpm add @noy-db/hub @noy-db/to-browser-idb

# Nuxt 4 + Pinia — the happy path
pnpm add @noy-db/in-nuxt @noy-db/in-pinia @noy-db/hub @noy-db/to-browser-idb @pinia/nuxt pinia

# React / Next.js
pnpm add @noy-db/in-nextjs @noy-db/in-react @noy-db/hub @noy-db/to-browser-idb

# Offline-first with cloud sync (cloud adapters from noy-db-to)
pnpm add @noy-db/hub @noy-db/to-file @noy-db/to-aws-dynamo
```

For starter applications see [`noy-db-docs/content/docs/recipes`](https://github.com/vLannaAi/noy-db-docs/tree/main/content/docs/recipes) — four runnable recipes covering personal, accounting, real-time, and analytics shapes.

### Release channels

noy-db ships through two npm dist-tags. The default install pulls the curated, themed releases; an opt-in `@next` channel carries in-flight features for early-adopter consumers.

```bash
# Stable — themed releases (default)
pnpm add @noy-db/hub

# Early-adopter — in-flight features, expect breakage between versions
pnpm add @noy-db/hub@next
```

Pre-1.0 (today): both channels can be ahead of where you'd expect a `0.x` library to be — anything in `@next` is "actively maturing"; anything in `@latest` has at least passed a themed release gate. Post-1.0: `@latest` becomes a strict-SemVer contract, `@next` keeps its experimental nature.

---

## Runs on whatever you've got

| Platform | Runtime | Default backend |
|---|---|---|
| 🖥️ Desktop (macOS / Linux / Windows) | Node 18+, Bun, Deno | [`to-file`](https://github.com/vLannaAi/noy-db-docs/blob/main/content/docs/packages/to-stores.md) |
| 📱 Mobile browser | Safari 14+, Chrome 90+ | [`to-browser-idb`](https://github.com/vLannaAi/noy-db-docs/blob/main/content/docs/packages/to-stores.md) |
| 🌐 Desktop browser | Chrome, Firefox, Safari, Edge | [`to-browser-idb`](https://github.com/vLannaAi/noy-db-docs/blob/main/content/docs/packages/to-stores.md) |
| ⚡ PWA / offline web app | Service Worker + browser | [`to-browser-idb`](https://github.com/vLannaAi/noy-db-docs/blob/main/content/docs/packages/to-stores.md) |
| 🖧 Server (headless) | Node 18+ | [`to-file`](https://github.com/vLannaAi/noy-db-docs/blob/main/content/docs/packages/to-stores.md) / `to-aws-dynamo` / `to-postgres` *(noy-db-to)* |
| 💾 USB stick / removable disk | Any OS + any runtime | [`to-file`](https://github.com/vLannaAi/noy-db-docs/blob/main/content/docs/packages/to-stores.md) |
| 🔌 Electron / Tauri | Desktop shell | [`to-file`](https://github.com/vLannaAi/noy-db-docs/blob/main/content/docs/packages/to-stores.md) |
| ☁️ Cloudflare Workers | Edge JS | `to-cloudflare-d1` + `to-cloudflare-r2` *(noy-db-to)* |
| 🧪 Tests / CI | Any JS runtime | [`to-memory`](https://github.com/vLannaAi/noy-db-docs/blob/main/content/docs/packages/to-stores.md) |

Minimum requirements: a JavaScript engine and the Web Crypto API. That's it.

---

## Hard privacy is the point

In privacy engineering there's a distinction worth naming.

- **Soft privacy** is a promise. A provider pledges to protect your data — by policy, by staff training, by a compliance certificate on the wall. You trust the policy, the people, the future owners, the jurisdiction, the subpoena response, the breach-response team on their worst day.
- **Hard privacy** removes the need for that trust. Nobody else *can* break the promise because nobody else is in a position to. They don't have the keys. They never had the keys.

noy-db is a hard-privacy tool. The only party that can read a record is the party holding the secret. That holds whether your cloud is breached, a sysadmin inspects the table, a court compels the provider, a laptop is stolen, or a backup is left on café Wi-Fi — **every one of those surfaces already holds ciphertext**.

There is no "encrypted in transit, briefly decrypted at rest for processing" step. There is no support engineer at noy-db with a recovery key — we do not run a service and we do not possess any key. The KEK exists in your process memory for the length of a session and is destroyed when you call `db.close()`.

This matters to an individual keeping private journals, medical notes, immigration paperwork, legal correspondence, or financial records. It matters a great deal more to an **organisation** that holds other people's sensitive data as a fiduciary — a law firm, an professional services firm, a clinic, a small newsroom, a union office, a humanitarian NGO — and cannot, in good conscience, hand that data to a third-party service whose incident response, jurisdiction, and future acquirer they don't control.

### A note on the ethics of hard privacy

Strong encryption is a dual-use technology. The same guarantees that protect dissidents, journalists, abuse survivors, clinicians' patients, and every ordinary person's private life can also shield conduct that is unlawful or harmful. We do not pretend otherwise.

Our position: **the capacity to keep one's own records, thoughts, and correspondence private from everyone else — including one's government, one's employer, and the company selling one the software — is foundational. It is bound up with personal autonomy itself, and it is a right, not a feature we chose to grant.**

noy-db does not inspect your data. It cannot — that is the architectural point. What you choose to store in a noy-db vault, and what you do with it, is your business. If you are using noy-db in a context where you have legal or professional obligations — GDPR, PDPA, HIPAA, PCI-DSS, retention, lawful-access rules, auditability, tax record-keeping — those obligations remain yours to meet under the law of wherever you operate.

---

## Encryption

| Layer | Algorithm | Purpose |
|---|---|---|
| Key derivation | PBKDF2-SHA256 (600K iterations) | Secret → KEK |
| Key wrapping | AES-KW (RFC 3394) | KEK wraps/unwraps DEKs |
| Data encryption | AES-256-GCM | DEK encrypts records |
| IV generation | CSPRNG | Fresh 12-byte IV per write |
| Integrity | HMAC-SHA256 | Presence channel + blob eTags |

**Zero crypto dependencies.** Everything uses `crypto.subtle` — built into Node 18+ and modern browsers.

---

## Roles & permissions

| Role | Read | Write | Grant | Revoke | Export |
|---|:-:|:-:|:-:|:-:|:-:|
| **owner** | all | all | all roles | all | yes |
| **admin** | all | all | operator, viewer, client, admin | admin and below | yes |
| **operator** | granted collections | granted collections | — | — | ACL-scoped |
| **viewer** | all | — | — | — | yes |
| **client** | granted collections | — | — | — | ACL-scoped |

Every mutation (grant, revoke, rotate, elevate) writes a hash-chained audit ledger entry. Hierarchical per-record classification tiers (`collection.elevate()` / `demote()` / `delegate()` / invisibility / ghost modes) plus scoped tier-elevated handles (`vault.elevate(tier, { ttlMs, reason })` for time-boxed privileged writes) are covered in the [`history`](https://github.com/vLannaAi/noy-db-docs/blob/main/content/docs/services/history.md) and [`team`](https://github.com/vLannaAi/noy-db-docs/blob/main/content/docs/services/team.md) services.

---

## Not for

- Million-row analytics workloads.
- Server-side SQL over plaintext — the store is deliberately blind.
- Workloads that need the storage backend itself to run joins, filters, or aggregations over plaintext.
- Search-heavy workloads unless the searchable-index privacy tradeoff (opt-in deterministic encryption) is acceptable for your threat model.
- Teams that need **audited** cryptography today — noy-db has not yet had a third-party cryptographic audit. That is a v1.0 target.

Serious use of noy-db is for sensitive, small-to-mid datasets where the privacy boundary matters more than query throughput.

---

## Architecture

<picture>
  <img alt="noy-db architecture overview — hub at the center, five satellite package families around it" src="https://raw.githubusercontent.com/vLannaAi/noy-db-docs/main/content/docs/assets/overview.svg" width="100%">
</picture>

Stores **only see ciphertext**. Encryption happens in core before data reaches any backend — a DynamoDB admin, an S3 bucket owner, or whoever finds the USB stick all see encrypted blobs.

---

## International project, Global project

noy-db is an international open-source project. The first production consumer was an enterprise pilot — the library's design assumptions (offline-first, multi-user, sensitive domain data, per-tenant isolation, USB-based workflows for intermittent connectivity) come directly from that real-world deployment.

**Multi-language data is a first-class concern, not an afterthought.** The optional [`i18n`](https://github.com/vLannaAi/noy-db-docs/blob/main/content/docs/services/i18n.md) service lets a single field hold values in multiple locales (`i18nText({ languages: ['en', 'th', 'zh'] })`), pairs enum-like fields with shared label dictionaries (`dictKey('status', ['draft', 'paid'])` resolving to per-locale labels), and resolves the right locale at read time without touching ciphertext on the wire. Dictionaries are themselves encrypted and versioned, so even your translation strings stay private. Records, dictionaries, and exports are Unicode-clean — Thai (ภาษาไทย), Chinese (中文), Arabic (العربية), Devanagari (हिंदी), Cyrillic, Hebrew, every script the Web Crypto API and your storage backend can carry. Locale-aware exports round-trip human-readable headers back to stable keys (the `xlsx` reader inverts dictionary labels on import; same for `csv`, `json`, `ndjson`, `xml`).

---

<a name="zero-dependencies"></a>
## Zero dependencies

Every package has zero runtime dependencies. SDKs like `@aws-sdk/client-dynamodb`, `ssh2`, `pg`, `mysql2`, `zustand`, `react`, `vue`, `@tanstack/query-core` are peer dependencies — you already have them in your app.

The hub package itself uses only `crypto.subtle`, which is built into every target runtime (Node ≥ 18, Bun, Deno, modern browsers, Cloudflare Workers).

---

## Where to go next

| If you want to… | Read |
|---|---|
| see what's always-on (the floor) | [`docs/core/`](https://github.com/vLannaAi/noy-db-docs/tree/main/content/docs/core) |
| browse the 24 opt-in services | [`docs/services/`](https://github.com/vLannaAi/noy-db-docs/tree/main/content/docs/services) — index + the [SERVICES.md](SERVICES.md) catalog |
| copy a starter recipe | [`docs/recipes/`](https://github.com/vLannaAi/noy-db-docs/tree/main/content/docs/recipes) — personal-notebook · accounting-app · realtime-crdt-app · analytics-app |
| pick a storage backend | [`docs/packages/to-stores.md`](https://github.com/vLannaAi/noy-db-docs/blob/main/content/docs/packages/to-stores.md) |
| pick a framework integration | [`docs/packages/in-integrations.md`](https://github.com/vLannaAi/noy-db-docs/blob/main/content/docs/packages/in-integrations.md) |
| pick an unlock method | [`docs/packages/on-auth.md`](https://github.com/vLannaAi/noy-db-docs/blob/main/content/docs/packages/on-auth.md) |
| pick an export format | [`docs/packages/as-exports.md`](https://github.com/vLannaAi/noy-db-docs/blob/main/content/docs/packages/as-exports.md) |
| pick a session-share transport | [`docs/packages/by-transports.md`](https://github.com/vLannaAi/noy-db-docs/blob/main/content/docs/packages/by-transports.md) |
| see real workflows | [`showcases/`](https://github.com/vLannaAi/noy-db-docs/tree/main/showcases) |
| check what is stable or next | [`ROADMAP.md`](https://github.com/vLannaAi/noy-db-docs/blob/main/ROADMAP.md) |
| audit design decisions | [`SPEC.md`](https://github.com/vLannaAi/noy-db-docs/blob/main/SPEC.md) |

---

## License

[MIT](LICENSE)

---

<div align="center">
  <sub>Your data. Your device. Your keys. <b>None Of Your DataBase.</b></sub>
  <br>
  <sub><em>(Originally, and still occasionally: "None Of Your <strong>Damn Business</strong>".)</em></sub>
</div>
