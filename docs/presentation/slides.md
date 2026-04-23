<!--
  noy-db — canonical presentation deck (20 slides)

  Slide separator: `---` on its own line.
  Sub-slides / fragments: `--`.
  Reveal.js-compatible markdown. Convert via `pnpm exec reveal-md docs/presentation/slides.md`
  (or paste into any Markdown-slide tool — Marp, Slidev, Quarto, etc.).

  Length target: 20 slides. Hard cap for a 20-minute adoption pitch.
  Structure: 3 problem + 5 architecture + 5 showcases + 3 adoption + 4 roadmap.
-->

## noy-db

### None Of Your DataBase

> Your data. Your device. Your keys. Nobody else's server.

A zero-knowledge, offline-first, encrypted document store
with pluggable backends and multi-user access control.

<small>v0.12 · 2026 · github.com/vLannaAi/noy-db</small>

---

## The problem (1/3)

Most "privacy-friendly" databases ask you to **trust** someone —
the cloud provider, their staff, their subpoena response, their
future acquirer.

**Soft privacy** = a promise.
**Hard privacy** = removing the ability to break the promise.

noy-db is built for hard privacy.

---

## The problem (2/3)

Small, sensitive datasets — **1K to 50K records** — share a shape:

- ✅ Must work **offline** (local-first, cloud is optional)
- ✅ Must be **encrypted at rest on every backend**
- ✅ Must support **multiple users** with different access levels
- ✅ Must be **portable** (USB stick, email, backup, restore)
- ✅ Must **not lock you in** — swap backends without app rewrites

No existing library does all five. noy-db does.

---

## The problem (3/3)

Clients that fit:

| Who | Why |
|-----|-----|
| Small clinics | Patient records, offline + cloud mirror |
| Accounting firms | Client data on USB + DynamoDB |
| Field surveys | Collect offline, sync when connectivity returns |
| Personal finance | Never readable by the cloud provider |
| Any app where data fits in memory and privacy is non-negotiable | |

The first pilot consumer is an accounting firm in northern Thailand.

---

## Architecture (1/5)

```
Passphrase
  └─► PBKDF2-SHA256 (600K iterations) ► KEK  [memory only]
        └─► AES-KW unwrap ► DEK per collection
              └─► AES-256-GCM encrypt / decrypt
                    └─► Store — sees ciphertext only
```

The KEK exists only in process memory while a session is active.
Nothing on disk can be read without the passphrase.

---

## Architecture (2/5) — Envelope format

Every record, on every backend, looks like:

```json
{
  "_noydb": 1,
  "_v": 3,
  "_ts": "2026-04-21T10:00:00Z",
  "_iv":   "<12-byte random, base64>",
  "_data": "<AES-GCM ciphertext, base64>"
}
```

- `_v` + `_ts` unencrypted — **sync engine needs them without keys**.
- `_iv` + `_data` — the only thing the store ever sees of your data.

---

## Architecture (3/5) — The 6-method store

```ts
interface NoydbStore {
  get(vault, collection, id): Envelope | null
  put(vault, collection, id, envelope, expectedVersion?): void
  delete(vault, collection, id): void
  list(vault, collection): string[]
  loadAll(vault): VaultSnapshot
  saveAll(vault, data): void
}
```

Implement 6 methods, you have a new store. file, DynamoDB, S3,
IndexedDB, localStorage, in-memory — all ship. WebDAV, IPFS, Git,
Cloudflare R2, Supabase, Turso, Postgres — on the roadmap.

---

## Architecture (4/5) — Memory-first

Load the vault once. Query in memory with `Array.filter`.

```ts
invoices.query()
  .where('status', '==', 'open')
  .groupBy('clientId')
  .aggregate({ total: sum('amount') })
  .run()
```

No query engine. No index rebuild. Joins, groupBy, aggregates all
run against the decrypted in-process cache. **Target scale:
1K–50K records per vault.** Above that, pick a different tool.

---

## Architecture (5/5) — Routing + middleware

Production deployments compose primitives:

```ts
const store = wrapStore(
  routeStore({
    default: dynamo({ table: 'records' }),
    blobs:   s3({ bucket: 'blobs' }),
    age:     { cold: s3({ bucket: 'archive' }), coldAfterDays: 90 },
  }),
  withRetry(), withCircuitBreaker(),
  withCache(), withMetrics(onOp),
)
const db = await createNoydb({ store, sync: [{ store: peer, role: 'sync-peer' }] })
```

That expression covers records/blobs split + hot/cold tiering + retry +
circuit breaker + caching + metrics + peer sync.

---

## Showcases (1/5) — 14 runnable demos

Every feature ships with a **vitest** test that doubles as **demo**
and **tutorial**.

```bash
pnpm --filter @noy-db/showcases test
# 58 pass + 8 skipped (AWS + OIDC env-gated) in 3s
```

14 files, each a self-contained topology pattern:

local, split-store, sync-two-offices, blob-lifecycle, cascade FK,
query-analytics, resilient-middleware, CRDT, cloud DynamoDB, AWS
split, OIDC, WebAuthn, multi-locale (EN/TH/AR).

---

## Showcases (2/5) — Accounting Day

A real Pinia store, encrypted at every layer:

```ts
const useInvoices = defineNoydbStore<Invoice>('invoices', {
  vault: 'firm-demo',
})
const store = useInvoices()

await store.add('inv-001', { amount: 12500, status: 'draft' })
expect(store.count).toBe(1)       // reactive

store.query().where('status', '==', 'draft')
  .aggregate({ total: sum('amount') }).run()
// → { total: 12500 }
```

Drop-in Pinia ergonomics. Encryption is invisible.

---

## Showcases (3/5) — Split storage topology

One `createNoydb()` call, two backends:

```ts
routeStore({
  default: dynamo({ table: 'records' }),
  blobs:   s3({ bucket: 'blobs' }),
})
```

Records go to DynamoDB (CAS-atomic).
Blob chunks go to S3 (unlimited size, cheap).
**27× blob-storage cost reduction** vs DynamoDB-only.

---

## Showcases (4/5) — Passphrase-less unlock

Two shipped auth methods — more planned:

```ts
// WebAuthn (passkey / Touch ID / security key)
const enrolment = await enrollWebAuthn(keyring, vault)
// Later:
const unlocked = await unlockWebAuthn(enrolment)

// OIDC (Google / Apple / LINE / Auth0 / Keycloak)
const enrolment = await enrollOidc(keyring, vault, config, idToken)
const unlocked = await unlockOidc(enrolment, config, freshIdToken)
```

Split-key design: key-connector sees ciphertext only.
Coming: TOTP, email OTP, recovery codes, Shamir k-of-n.

---

## Showcases (5/5) — Multi-locale (EN / TH / AR)

Thai Unicode + Arabic RTL round-trip through AES-GCM:

```ts
vault.dictionary('status').putAll({
  draft: { en: 'Draft', th: 'ฉบับร่าง', ar: 'مسودة' },
  paid:  { en: 'Paid',  th: 'ชำระแล้ว',  ar: 'مدفوع' },
})

invoices.put('inv-1', {
  status: 'paid',  // stable key — dictionary resolves at read
  description: {
    en: 'Service fee',
    th: 'ค่าบริการ',
    ar: 'رسوم الخدمة',
  },
})
```

First-class Thai support given the Thailand-focused first adopter.

---

## Adoption (1/3) — Pick your topology in 30 seconds

Answer two questions:

**Where does the data live?**
browser → `to-browser-idb`
desktop → `to-file`
cloud → `to-aws-dynamo` + `to-aws-s3`
USB → `to-file` on the mount
prototype → `to-memory`

**What drives the UI?**
Nuxt → `in-nuxt`
Vue + Pinia → `in-pinia`
Yjs → `in-yjs`
vanilla → just `@noy-db/hub`

---

## Adoption (2/3) — Pick your stack in 30 seconds

```bash
npm create noy-db@latest my-app
cd my-app
pnpm install
pnpm dev
```

Templates shipping today:

- **vanilla** — Vite + TS, no framework (~200 LoC, smallest starter)
- **nuxt-default** — Nuxt 4 + Pinia + IndexedDB (full-stack reference)

Coming: vite-vue, electron, react (planned).

---

## Adoption (3/3) — Ship in a day

Day 1:
1. `npm create noy-db@latest` → pick template
2. Define your domain types (Invoice / Client / Patient / …)
3. `npx noy-db add <collection>` per domain entity
4. `pnpm dev` → reactive CRUD over encrypted storage

Day 2+:
- Pick a sync target (DynamoDB / WebDAV / Drive)
- Add `@noy-db/on-webauthn` for passkey unlock
- Configure `routeStore` for blobs + cold tier

Everything composable.

---

## Roadmap (1/4) — Where we are

| Version | Status | Theme |
|---------|--------|-------|
| v0.12 | ✅ | Storage structure — blob, routing, middleware, multi-backend |
| v0.13 | 📋 P1 | Developer tools |
| v0.14 | 📋 P2 | Playground expansion |
| **v0.15** | 🎯 **P3** | **Pre-distribution — target for 3 pilot adopters** |

v0.15 is the release window. START_HERE.md, ROADMAP rewrite,
Thai translation, slide deck, visual overview.

---

## Roadmap (2/4) — Near-term trunk

- **v0.16 Advanced core** — time-machine queries, shadow vaults,
  consent boundaries, partition-aware joins
- **v0.17 Time partitioning & auditing** — period closure / opening,
  financial + audit showcases
- **v0.18 Hierarchical access levels** — tiers, elevation, delegation,
  cross-tier audit notification
- **v0.19 Advanced crypto** — deterministic encryption (opt-in),
  Shamir k-of-n, ZK-proofs for compliance
- **v0.20 Edge & realtime** — `@noy-db/p2p` (WebRTC), edge workers,
  BroadcastChannel

---

## Roadmap (3/4) — Parallel forks (always-open)

Three always-open milestones absorb per-adapter work independently:

**Fork · Stores** — cloud (R2, D1, Supabase, Turso, Firestore),
SQL (sqlite, postgres, mysql), bundle (WebDAV, Drive, iCloud,
IPFS, Git), network (SMB, NFS), novel (QR, stego)

**Fork · Integrations** — React, Svelte, Solid, Qwik, TanStack
Query/Table, Zustand, LLM function-calling

**Fork · On** — recovery codes, TOTP, email OTP, Shamir,
threat-response (lockout + duress modes)

---

## Roadmap (4/4) — The invariants

Every release respects these:

1. **Zero-knowledge stays zero-knowledge.** Stores never see plaintext.
2. **Memory-first is the default.** Streaming is opt-in.
3. **Zero runtime crypto deps.** Web Crypto API only.
4. **Six-method store contract is sacred.** No bloat.
5. **Pinia/Vue ergonomics are first-class.**
6. **Every feature ships with a showcase** before it's stable.

A feature that violates them is out of scope. **No matter how exciting.**

---

## Thank you

> Your data. Your device. Your keys.
> **None Of Your Business.**

**github.com/vLannaAi/noy-db**

Read: [`docs/START_HERE.md`](https://github.com/vLannaAi/noy-db/blob/main/docs/START_HERE.md)
Showcases: [`showcases/`](https://github.com/vLannaAi/noy-db/tree/main/showcases)
Roadmap: [`ROADMAP.md`](https://github.com/vLannaAi/noy-db/blob/main/ROADMAP.md)
