# Roadmap

> **Current:** v0.9.0 on npm — all 13 `@noy-db/*` packages on the 0.9.0 version line. Everything from v0.8 plus the full sync v2 layer: CRDT mode, pluggable conflict policies, presence, partial sync, sync transactions, and the new `@noy-db/yjs` Yjs interop package. **Next:** v0.10 — developer experience.
>
> Related docs:
> - [Architecture](./docs/architecture.md) — data flow, key hierarchy, threat model
> - [Deployment profiles](./docs/deployment-profiles.md) — pick your stack
> - [Getting started](./docs/getting-started.md) — install and first app
> - [Adapters](./docs/adapters.md) — built-in and custom adapters
> - [End-user features](./docs/end-user-features.md) — what consumers get
> - [Spec](./SPEC.md) — invariants (do not violate)
> - [v0.6 release notes](./docs/v0.6/release-notes-draft.md) — v0.6 changelog
> - [v0.6 release retrospective](./docs/v0.6/retrospective.md) — lessons from the v0.6 release window
> - [v0.7 merge runbook](./docs/v0.7/merge-runbook.md) — v0.7 release process reference

---

## Status

v0.9.0 is on npm (released 2026-04-09). All 13 `@noy-db/*` packages are on the **0.9.0** version line — `core`, `yjs`, `auth-webauthn`, `auth-oidc`, `pinia`, `memory`, `file`, `dynamo`, `s3`, `browser`, `vue`, `nuxt`, `create`. **1132 tests** passing across all packages (772 core + 11 yjs + 18 auth-webauthn + 21 auth-oidc + 310 other). Full v0.5 surface (zero-knowledge AES-256-GCM, five-role ACL, hash-chained ledger, `ref()` foreign keys, Standard Schema v1, verifiable backups, sync, Vue/Nuxt/Pinia) plus v0.6 query-DSL completion (joins, aggregations, streaming scan, `.noydb` container) plus v0.7 identity & sessions (session tokens, OIDC bridge, magic-link unlock, hardware-key keyrings via WebAuthn, session policies, dev-mode unlock, `_sync_credentials` reserved collection) plus v0.8 i18n & dictionaries (`dictKey` + `DictionaryHandle`, `i18nText`, `plaintextTranslator`, export snapshot, query DSL dictKey integration) plus v0.9 sync v2 (CRDT mode, pluggable conflict policies, presence, partial sync, sync transactions, `@noy-db/yjs`). **Next:** v0.10 — developer experience.

---

## Releases

| Version | Status      | Theme                              | Highlights                                                                |
|--------:|-------------|------------------------------------|---------------------------------------------------------------------------|
| 0.5     | ✅ shipped  | Initial release                    | Zero-knowledge encryption, multi-user ACL, ledger, verifiable backups, query DSL, sync, Vue/Nuxt/Pinia, scaffolder + CLI |
| 0.6     | ✅ shipped  | Query DSL completion + `.noydb` container | Joins (eager + multi-FK chain + live + streaming), aggregations v1 (reducers + `.aggregate()` + `.groupBy()` + `scan().aggregate()`), `.noydb` container format |
| 0.7     | ✅ shipped  | Identity & sessions                | Session tokens, OIDC bridge, magic links, hardware-key keyrings           |
| 0.8     | ✅ shipped  | i18n & localization                | `dictKey` + `i18nText` schema primitives, `plaintextTranslator` hook, per-locale read resolution, dictionary admin operations, export integration |
| 0.9     | ✅ shipped  | Sync v2                            | CRDT mode, pluggable conflict policies, presence, partial sync, sync transactions, `@noy-db/yjs` |
| **0.10** | 🚧 **next** | **Developer experience**           | `noydb` CLI, devtools panel, schema codegen, importers                   |
| 0.11    | 📋 planned  | Adapter expansion                  | R2, D1, Supabase, IPFS, Git, WebDAV, encrypted SQLite, Turso              |
| 0.12    | 📋 planned  | Other framework integrations       | React, Svelte, Solid, Qwik, TanStack Query/Table, Zustand                 |
| 1.0     | 📋 planned  | Stability + LTS release            | API freeze, third-party audit, perf benchmarks, migration tooling         |
| 1.x     | 🔭 vision   | Edge & realtime                    | Edge worker adapter, WebRTC peer sync, encrypted BroadcastChannel         |
| 2.0     | 🔭 vision   | Federation                         | Multi-instance federation, verifiable credentials, ZK proof exports       |

```mermaid
gantt
    title NOYDB release timeline
    dateFormat YYYY-MM
    axisFormat %Y-%m
    section Shipped
    v0.5 initial release             :done,    v05, 2026-04, 1d
    v0.6 query DSL completion        :done,    v06, 2026-04, 1d
    v0.7 identity & sessions         :done,    v07, 2026-04, 1d
    v0.8 i18n & localization         :done,    v08, 2026-04, 1d
    v0.9 sync v2                     :done,    v09, 2026-04, 1d
    section Next
    v0.10 developer experience       :active,  v010, after v09, 45d
    section Planned
    v0.11 adapter expansion          :         v011, after v010, 45d
    v0.12 other frameworks           :         v012, after v011, 45d
    v1.0 stability + LTS             :crit,    v10, after v012, 60d
```

---

## Guiding principles

Every future release respects these:

1. **Zero-knowledge stays zero-knowledge.** Adapters never see plaintext.
2. **Memory-first is the default.** Streaming, pagination, and lazy hydration are opt-in.
3. **Zero runtime crypto deps.** Web Crypto API only.
4. **Six-method adapter contract is sacred.** New capabilities go in core or in optional adapter extension interfaces.
5. **Pinia/Vue ergonomics are first-class.** If a feature makes Vue/Nuxt/Pinia adoption harder, it gets redesigned.
6. **Every feature ships with a `playground/` example** before it's documented as stable.

---

## v0.6 — Query DSL completion + `.noydb` container ✅ shipped

**Status:** Released 2026-04-09. See [release notes draft](./docs/v0.6/release-notes-draft.md) for the full changelog and [retrospective](./docs/v0.6/retrospective.md) for lessons learned during the release window.

**Goal (achieved):** Finish the query DSL story so consumers can express joins and aggregations directly in `.query()` / `.scan()` instead of folding in userland. Both features extend the same builder chain; they landed in the same release so the docs cover them together. The release also picked up the `.noydb` container format (spawned from discussion #92) — standalone from the query work, small enough to fit the milestone, and it unblocks the v0.10 reader (#102) and the v0.11 bundle adapters (#103, #104).

### Joins (spawned from discussion #64)

- **Eager single-FK join (#73)** — `.join('clientId', { as: 'client' })` resolves through an existing `ref()` declaration. Two planner paths: indexed nested-loop (when the FK target field is in the right side's `indexes`) and hash join (otherwise). Hard memory ceiling at `JoinTooLargeError` (default 50k rows per side, override via `{ maxRows }`). Same-compartment only — cross-compartment correlation goes through `queryAcross`.
- **Live joins (#74)** — `.join().live()` produces a merged subscription over both collections' change streams. Right-side disappearance follows the ref mode (`strict` / `warn` / `cascade`).
- **Multi-FK chaining (#75)** — `.join('clientId').join('parentId')` for queries that follow more than one relationship. Each join uses its own planner strategy.

### Aggregations v1 (spawned from discussion #65)

- **Built-in reducers (#97)** — `count()`, `sum(field)`, `avg(field)`, `min(field)`, `max(field)` reducer factories, a `.aggregate({ ... })` terminal, and a `.live()` mode that incrementally maintains running totals for `sum`/`count`/`avg`. Documented O(N) worst case for `min`/`max` on the "current extremum was just deleted" edge case. Every reducer accepts a `{ seed }` parameter (load-bearing for partition-aware aggregation in v0.10 — see #87).
- **`groupBy(field)` (#98)** with a documented cardinality warn at 10k groups and a hard error at 100k. Type-level enforcement that `dictKey` fields group by stable key (prep for #85 in v0.8).
- **`scan().aggregate(...)` (#99)** for memory-bounded aggregation over collections beyond the in-memory ceiling. Reuses the same reducer protocol — no duplicated API.
- **Out of scope for v1, tracked separately:** per-row callback reducers (`.reduce(fn, init)`), index-backed aggregation planner, multi-level groupBy, aggregations across joins, `.scan().groupBy().aggregate()`. These wait for a real consumer ask before being scheduled.

### Streaming joins (#76)

- **Streaming join over `scan()`** — different planner shape from the bounded join in #73, bypasses the row ceiling for very large right sides. Originally deferred; pulled into v0.6 alongside `scan().aggregate()` because both features share the same streaming-scan iteration story and they should land together so the docs cover memory-bounded cross-collection work as a coherent story.

### Container format (#100)

- **`.noydb` container format (spawned from discussion #92)** — wraps `compartment.dump()` with a 4-byte `NDB1` magic header, an opaque-handle-only metadata header (ULID + format version + body size/sha256, no business metadata), and a brotli-compressed body (gzip fallback). Ships the `writeNoydbBundle` / `readNoydbBundle` / `readNoydbBundleHeader` primitives in core and `saveBundle` / `loadBundle` helpers in `@noy-db/file`. Foundation for the v0.10 reader (#102) and the v0.11 bundle adapters (#103, #104).

---

## v0.7 — Identity & sessions ✅ shipped

**Status:** Released 2026-04-09. GitHub release: https://github.com/vLannaAi/noy-db/releases/tag/v0.7.0

- **Session tokens (#109).** Unlock once with passphrase or biometric, get a `SessionToken` valid for N minutes. DEK map encrypted with a non-extractable, tab-scoped AES-256-GCM session key. Closing the tab destroys the session.
- **`_sync_credentials` reserved collection (#110).** Encrypted per-adapter OAuth token store. ACL-gated (owner/admin only). Adapters see only ciphertext.
- **`@noy-db/auth-webauthn` (#111).** Hardware-key keyrings via WebAuthn + PRF extension. Covers YubiKey, Touch ID, Face ID, Windows Hello, passkeys. rawId-HKDF fallback for non-PRF authenticators. `singleDevice` guard rejects cloud-synced credentials.
- **`@noy-db/auth-oidc` (#112).** OAuth/OIDC bridge with Bitwarden-style split-key connector. Server never sees the full KEK. Built-in `knownProviders` for LINE, Google, Apple.
- **Magic-link unlock (#113).** Email a one-time link → derives a *viewer-only* KEK via `HKDF-SHA256(serverSecret, SHA256(token), compartmentId)`. Read-only client portals. Single-use at the application layer.
- **Session policies (#114).** `{ idleTimeoutMs, absoluteTimeoutMs, requireReAuthFor, lockOnBackground }`. `PolicyEnforcer` fires `onRevoke` callback automatically.
- **Dev-mode persistent unlock (#119).** Stores the unlocked keyring in `sessionStorage`/`localStorage` so hot-reload doesn't kill the session. Unconditional guardrails: throws in production, throws off localhost, requires explicit `acknowledge` string.

---

## v0.8 — Internationalization & dictionaries ✅ shipped 2026-04-09

**Goal (achieved):** Make i18n a first-class schema primitive instead of something every consumer hand-rolls on top of the library. Spawned from discussion #78.

**Shipped as:** PR #129 (dictKey + i18nText) + PR #130 (plaintextTranslator + export snapshot + query DSL integration). Released as v0.8.0 on 2026-04-09.

### What shipped

- **`dictKey(name, keys?)` + `DictionaryHandle` (#81)** — `_dict_<name>/` reserved encrypted collections. CRUD + `rename()` cascade-rewrite. `DictKeyMissingError` / `DictKeyInUseError` / `ReservedCollectionNameError`. Write-through sync cache for O(1) query executor snapshots.
- **`i18nText({ languages, required, autoTranslate? })` (#82)** — per-record multi-language prose. `required: 'all' | string[]`. `get(id, { locale, fallback? })` / `list({ locale })` locale resolution. `resolveI18nText` / `applyI18nLocale` helpers. `MissingTranslationError` / `LocaleNotSpecifiedError`.
- **`plaintextTranslator` hook (#83)** — consumer-supplied async translator; auto-fills missing required locales before `put()`. In-process content-hash cache, cleared on `db.close()`. `db.translatorAuditLog()` — entries with `cached` flag, deliberately no `contentHash`. `TranslatorNotConfiguredError`.
- **`exportStream()` dictionary snapshot (#84)** — `dictionaries` field attached to chunks; captured atomically before first yield. `exportJSON()` embeds `_dictionaries`; `resolveLabels` option omits it. Per-record granularity attaches snapshot to every chunk.
- **Query DSL dictKey integration (#85)** — `query().join(field)` resolves dictKey fields as dict joins, attaching `{ key, ...labels }`. `groupBy(field).aggregate(spec).runAsync({ locale })` adds `<field>Label` to bucket rows.

**Original goal description follows for reference:**

The proposal lands as **two structurally distinct schema primitives** because i18n content in real schemas splits into two cases that don't compose into one API:

### `dictKey('name')` — normalized dictionary keys

Bounded sets of stable values (status enums, category codes, filing types, role names) where the *set* is known and the *labels* differ per locale. Storage holds the stable key. Reads resolve to the caller's locale.

```ts
await company.dictionary('status').putAll({
  draft:    { en: 'Draft',    th: 'ฉบับร่าง' },
  open:     { en: 'Open',     th: 'เปิด' },
  paid:     { en: 'Paid',     th: 'ชำระแล้ว' },
})

const Invoice = z.object({
  id: z.string(),
  status: dictKey('status', ['draft', 'open', 'paid'] as const),
})

const inv = await invoices.get('inv-1', { locale: 'th' })
// → { id: 'inv-1', status: 'paid', statusLabel: 'ชำระแล้ว' }
```

- **Stored as a reserved encrypted collection** (`_dict_<name>/`) under the same compartment DEK. One collection per dictionary, not one collection with namespaces — composes with refs naturally and inherits ACL, ledger, schema, and query primitives without special-casing.
- **Type-narrowed via `as const` keys passed at schema-construction time.** No codegen — the runtime dictionary and the static literal union can drift, and `noy-db verify` catches the drift in CI.
- **`groupBy(dictKey)` groups by stable key, not localized label.** Grouping by the localized label would produce different buckets per reader, which is silently catastrophic. Enforced at the type level, not just docs.
- **Cascade-on-delete is not supported.** A dedicated `dictionary.rename(oldKey, newKey)` operation handles the only legitimate "mass rewrite" case with explicit consent. Default delete behavior is `strict` — refuse delete if any record references the key.

### `i18nText({ languages, required })` — multi-language content fields

Per-record prose (invoice notes, product descriptions, line-item descriptions) where each record has its own value in N languages.

```ts
const LineItem = z.object({
  id: z.string(),
  description: i18nText({
    languages: ['en', 'th'],
    required: 'all',                 // 'all' | 'any' | ['en']
  }),
})

await lineItems.put('li-1', {
  id: 'li-1',
  description: { en: 'Consulting hours', th: 'ค่าที่ปรึกษา' },
})

// Read with fallback
const li = await lineItems.get('li-1', { locale: 'th', fallback: 'en' })
// → { id: 'li-1', description: 'ค่าที่ปรึกษา' }

// Raw mode for bilingual exports
const raw = await lineItems.get('li-1', { locale: 'raw' })
// → { id: 'li-1', description: { en: '...', th: '...' } }
```

- **Strict / warn / relaxed enforcement** at the schema boundary
- **Declarative locale fallback on read** — `{ locale, fallback }` chain instead of per-consumer logic
- **Raw mode** for consumers that need every language at once (bilingual PDFs, XML exports with namespaced language elements)

### The `plaintextTranslator` hook

The most philosophically careful piece of the proposal. A common request is "auto-translate missing languages before `put()`," and the obvious implementation — calling an external translation API — sends plaintext over the network the moment it executes. NOYDB ships **the integration point, never the integration**:

```ts
const db = await createNoydb({
  adapter: ...,
  user: 'alice',
  secret: '...',
  plaintextTranslator: async ({ text, from, to, field, collection }) => {
    // Consumer's choice: DeepL, Argos, Claude with their data policy,
    // self-hosted LLM, human review queue. NOYDB does not know or care.
    return await myTranslator.translate(text, from, to)
  },
})

const LineItem = z.object({
  description: i18nText({
    languages: ['en', 'th'],
    autoTranslate: true,            // ← per-field opt-in, visible in schema source
  }),
})
```

The hook is named **`plaintextTranslator`** (not `translator`) deliberately — the same naming logic as `@noy-db/decrypt-*` packages. The word "plaintext" in the config key forces the consumer to acknowledge the boundary they're crossing every time they read or write the config.

**The full invariant statement** for what zero-knowledge does and does not promise lives in [`SPEC.md` §Design Principles → Zero-Knowledge Storage](./SPEC.md#2-zero-knowledge-storage). Key points:

- NOYDB ships **no built-in translator** and ships **no translator SDKs as dependencies** — the policy is that PRs adding either are rejected
- Per-field opt-in at schema-construction time, never at runtime
- Ledger entries record `{field, fromLocale, toLocale, translatorName, timestamp}` — **never** content, **never** content hashes (the hash would be a fingerprint that allows correlation of identical phrases, a subtle leak the audit logging is meant to prevent)
- Translator cache lives only in process memory, holds plaintext, **must clear on `db.close()`** alongside the KEK and DEKs

### Out of scope for v0.8 i18n

- **Pluralization** (ICU MessageFormat `one`/`other`/`few`/`many`) — that's the consumer's templating layer's job
- **Date / number / currency formatting** — `Intl.*` in the consumer's UI layer
- **RTL/LTR rendering** — locales are opaque BCP 47 codes to NOYDB; rendering is the UI layer's job
- **Per-locale CRDT merging in sync** — bundled-LWW in v0.8, per-locale CRDT is gated on v0.9 sync v2
- **Codegen for type narrowing** — pragmatic `as const` is what ships; codegen waits for a real consumer ask
- **Cross-compartment shared dictionaries** — would cross the isolation boundary; explicitly not supported

### Composition with other releases

| Release | Interaction |
|---|---|
| v0.6 (joins/aggregations) | `.join()` on a `dictKey` field resolves the label in the caller's locale; `.groupBy(dictKey)` groups by stable key and is **type-enforced** to prevent grouping by the resolved label |
| v0.9 (sync v2) | Per-locale CRDT merging of multi-lang fields is a sync v2 deliverable, not an i18n one. v0.8 ships with whole-field LWW; v0.9 upgrades to per-locale merge. |

---

## v0.9 — Sync v2 ✅ shipped 2026-04-09

**Status:** Released 2026-04-09. GitHub release: https://github.com/vLannaAi/noy-db/releases/tag/v0.9.0

**Goal (achieved):** Deterministic conflict resolution and collaborative editing, without sacrificing the zero-knowledge invariant.

### What shipped

- **Pluggable conflict policies (#131).** `conflictPolicy: 'last-writer-wins' | 'first-writer-wins' | 'manual' | CustomMergeFn` per collection. Manual mode emits `sync:conflict` with a `resolve(winner)` callback. Custom fn receives decrypted local + remote records and returns the winning value; the result is re-encrypted before storage.
- **CRDT mode (#132).** Optional `crdt: 'lww-map' | 'rga' | 'yjs'` per collection. LWW-Map: commutative field-level merges by timestamp — the stored value is a `LwwMapState` register, `get()` auto-resolves to the snapshot. RGA: stable-identity append-only array with tombstoning — items carry stable NIDs, tombstones kept in the `items` array for ordering. Yjs: delegates to `Y.Doc` merge at the application layer. `collection.getRaw(id)` returns the raw `CrdtState`. The CRDT conflict resolver is registered with the sync engine automatically.
- **`@noy-db/yjs` (#136).** New package. `yjsCollection(comp, name, { yFields })` wraps a `crdt: 'yjs'` collection. `getYDoc(id)` decodes the stored base64 update into a live `Y.Doc`. `putYDoc(id, doc)` encodes the doc back. `applyUpdate(id, bytes)` merges an incoming update. `yText()`, `yMap()`, `yArray()` field descriptors carry metadata without affecting storage.
- **Presence and live cursors (#134).** `collection.presence<P>()` returns a `PresenceHandle<P>`. `update(payload)` encrypts the presence payload with an HKDF-derived key from the collection DEK and publishes it. `subscribe(cb)` delivers a decrypted, stale-filtered list of active peers. Two transport strategies: pub/sub (when the sync adapter implements `presencePublish`/`presenceSubscribe`) and storage-poll fallback (writes to `_presence_<collection>` reserved collection on the sync adapter). The adapter never sees plaintext identities.
- **Partial sync (#133).** `push(comp, { collections? })`, `pull(comp, { collections?, modifiedSince? })`, `sync(comp, { push, pull })`. Adapters may implement optional `listSince?(compartment, collection, since): Promise<string[]>` for server-side timestamp filtering.
- **Sync transactions (#135).** `db.transaction(comp).put(col, id, rec).delete(col, id).commit()` — two-phase: local writes go through the normal collection layer (permissions, crypto, ledger), then a filtered push sends only the transacted records to the sync adapter.

---

## v0.10 — Developer experience 🎯 next

**Goal:** Make NOYDB easy to use, easy to debug, easy to import existing data into.

- **`noydb` CLI.** `init`, `open` (REPL), `dump`, `load`, `codegen`, `migrate`, `verify`, `import`.
- **Browser DevTools panel.** Compartments, collections, decrypted records (only with active session), ledger, sync status, query playground.
- **VSCode extension.** Schema-aware autocomplete for `where()` field names, hover-preview, run queries from the editor.
- **Importers.** `@noy-db/import-postgres`, `@noy-db/import-sqlite`, `@noy-db/import-csv`, `@noy-db/import-firebase`, `@noy-db/import-mongo`.
- **Type generation.** `noydb codegen` → fully typed `db.ts`.
- **Test utilities (`@noy-db/testing`).** `createTestDb()`, `seed()`, `snapshot()`, time-travel mocks, conflict simulators.

---

## v0.11 — Adapter expansion

| Adapter                       | Why                                                                  |
|-------------------------------|----------------------------------------------------------------------|
| `@noy-db/cloudflare-r2`       | Cheap S3-compatible, no egress fees                                  |
| `@noy-db/cloudflare-d1`       | SQLite at the edge, free tier                                        |
| `@noy-db/supabase`            | One-click Postgres + storage                                         |
| `@noy-db/ipfs`                | Content-addressed; fits the hash-chain ledger naturally              |
| `@noy-db/git`                 | Compartment = git repo, history = commits, sync = push/pull          |
| `@noy-db/webdav`              | Nextcloud, ownCloud, any WebDAV server                               |
| `@noy-db/sqlite-encrypted`    | Single-file backend (better than JSON for >10K records)              |
| `@noy-db/turso`               | Edge SQLite with replication                                         |
| `@noy-db/firestore`           | Firebase teams                                                       |
| `@noy-db/postgres`            | Postgres `jsonb` column, single-table pattern                        |

---

## v0.12 — Other framework integrations

Pinia/Vue already ship in `@noy-db/vue`, `@noy-db/pinia`, and `@noy-db/nuxt`. v0.12 brings the same first-class story to other ecosystems.

| Package                     | Provides                                                       |
|-----------------------------|----------------------------------------------------------------|
| `@noy-db/react`             | `useNoydb`, `useCollection`, `useQuery`, `useSync` hooks       |
| `@noy-db/svelte`            | Reactive stores                                                |
| `@noy-db/solid`             | Signals                                                        |
| `@noy-db/qwik`              | Resumable queries                                              |
| `@noy-db/tanstack-query`    | Query function adapter — paginate/infinite-scroll              |
| `@noy-db/tanstack-table`    | Bridge for the existing `useSmartTable` pattern                |
| `@noy-db/zustand`           | Zustand store factory mirroring `defineNoydbStore`             |

All share one core implementation; framework packages stay thin (~200 LoC each).

---

## v1.0 — Stability + LTS release

- API freeze. Every public symbol marked `@stable`. Semver enforced.
- Third-party security audit of crypto, sync, and access control.
- Performance benchmarks published; tracked in CI with regression alerts.
- Migration tooling: `noydb migrate --from 0.x` for envelope/keyring schema changes.
- Documentation site with searchable API docs, recipes, video walkthroughs.
- Reference apps: accounting demo (Vue/Pinia), personal journal (React), shared note-taker (Svelte), small CRM (Nuxt).
- LTS branch with security backports for 18 months.

---

## v1.x — Edge & realtime

- **Edge worker adapter.** NOYDB inside Cloudflare Workers / Deno Deploy / Vercel Edge.
- **WebRTC peer sync (`@noy-db/p2p`).** Direct browser-to-browser, encrypted, no server in the middle. TURN fallback only sees ciphertext.
- **Encrypted BroadcastChannel.** Multi-tab session and hot cache sharing.
- **Reactive subscriptions over the wire.** `collection.subscribe(query, callback)` works across tabs, peers, and edge workers.

---

## v2.0 — Federation & verifiable credentials

- **Multi-instance federation.** Two compartments at two organizations share a *bridged collection* via ECDH-derived session keys; each side keeps its own DEK.
- **Verifiable credentials (W3C VC).** Sign records as VCs; pairs with the hash-chained ledger for non-repudiation.
- **Zero-knowledge proofs.** "I have at least N invoices over $X without showing them" via zk-SNARKs. Gated by a real use case.
- **Compartment marketplaces.** Sealed encrypted bundles distributed and re-keyed on first open.

---

## Plaintext export packages — `@noy-db/decrypt-*`

> Spawned from discussion vLannaAi/noy-db#70.

`company.dump()` produces an **encrypted, tamper-evident envelope** for backup and transport. It is the right answer when bytes are leaving an active session and need to remain protected. It is the **wrong answer** when a downstream tool — accounting software, audit pipeline, ETL job, government tax portal — needs to read the records as plaintext in a standard format.

Plaintext exports are a legitimate operation for an authorized owner, but they cross two lines that the rest of the project does not cross:

1. **Plaintext on disk.** The library produces bytes that the consumer is now responsible for protecting (filesystem permissions, full-disk encryption, secure transfer, secure deletion). This is the inverse of what every other API in NOYDB does.
2. **External dependencies.** Some target formats (notably xlsx) cannot be hand-rolled inside the zero-runtime-deps invariant. Pulling in a format library means accepting an external supply-chain surface that core has spent the entire project keeping out.

Either of those alone justifies a separate package. Both together justify a **separate, named package family** distinct from the rest of the `@noy-db/*` namespace.

### Naming policy: `@noy-db/decrypt-{format}`

The family is named `@noy-db/decrypt-*` instead of `@noy-db/export-*` deliberately. The word "export" is routine — every database has it. The word **"decrypt"** in the package name forces the consumer to acknowledge what they are actually doing when they install it. It shows up in their `package.json`, in their import statement, in their lockfile, in `npm audit` output, and in every code review of the file that uses it. That visibility is the entire point.

```ts
// The verb in the function name is honest:
import { decryptToCSV }  from '@noy-db/decrypt-csv'
import { decryptToXML }  from '@noy-db/decrypt-xml'
import { decryptToXLSX } from '@noy-db/decrypt-xlsx'

await decryptToCSV(company.exportStream(), './invoices.csv')
//      ^^^^^^^^^ — the consumer is calling a function whose name says "I am decrypting"
```

### Package list

| Package                  | Deps                                          | Risk profile                                                                                                       | Target  |
|--------------------------|-----------------------------------------------|--------------------------------------------------------------------------------------------------------------------|---------|
| `@noy-db/decrypt-csv`    | **Zero.** ~50 LOC of correctly-escaped CSV.   | Plaintext-on-disk only. No supply chain surface.                                                                   | post-v0.5, opportunistic |
| `@noy-db/decrypt-xml`    | **Zero.** Hand-rolled subset, ~200–300 LOC. Covers elements, attributes, namespaces, CDATA, XSD generation. | Plaintext-on-disk only. No supply chain surface. Schema-aware via XSD; XSLT downstream story is the deciding factor for enterprise / regulated industries. | post-v0.5, opportunistic |
| `@noy-db/decrypt-xlsx`   | **Peer dep on `xlsx` or `exceljs`.**          | Plaintext-on-disk **plus** an external library with its own CVE history living inside the consumer's node_modules. **Highest-risk package in the family.** Ships last so the warning + review process is well-rehearsed by then. | v0.9+ |

JSON is **not** in this family. The `exportJSON()` helper lives in `@noy-db/core` itself because it is zero-dep, trivial, and is the universal default every consumer wants. The plaintext-on-disk warning still applies and is documented identically; the package boundary just isn't justified for five lines of code with no external deps.

### Mandatory README warning block

Every `@noy-db/decrypt-*` package's README starts with the same explicit block, written once and copy-pasted with the format name swapped in:

> **⚠ This package decrypts your records and writes plaintext to disk.**
>
> NOYDB's threat model assumes that records on disk are encrypted. This package deliberately violates that assumption: it produces a `<format>` file in plaintext, which the consumer is then responsible for protecting (filesystem permissions, full-disk encryption, secure transfer, secure deletion).
>
> Use this package only when:
> - You are the authorized owner of the data, **and**
> - You have a legitimate downstream tool that requires plaintext `<format>`, **and**
> - You have a documented plan for how the resulting file will be protected and eventually destroyed.
>
> If your goal is encrypted backup or transport between NOYDB instances, use **`company.dump()`** instead — it produces a tamper-evident encrypted envelope, never plaintext.

The warning lives at the top of the README, in the published package description on npm, and in the JSDoc of every exported function so that hovering it in an IDE shows the warning. **The warning is not optional and not collapsible.** `@noy-db/decrypt-xlsx` adds a second paragraph specific to its peer dep, naming the upstream library and explicitly transferring CVE-watch responsibility to the consumer.

### Explicitly out of scope: SQL DDL emitters

There will be **no `@noy-db/decrypt-mysql`** (or `decrypt-postgres`, `decrypt-sqlite`, etc.). Generating `CREATE TABLE` DDL from a Standard Schema means type mapping, identifier quoting, charset/collation, `AUTO_INCREMENT`, enum handling, date/datetime precision, reserved-word escaping, and a long tail of vendor-specific edge cases. It is a project, not a feature, and it would confuse what NOYDB is.

The right userland answer is: **export to JSON or CSV via `@noy-db/decrypt-csv`, then `mysqlimport` or any generic ETL tool handles the load into whatever relational database you want.** Every generic ETL tool in existence already does the JSON-or-CSV → MySQL step, and none of them do it badly. NOYDB does not need to compete with `mysqlimport`.

This position is documented here so consumers stop asking. If you arrived at this section while looking for "how do I export NOYDB to MySQL", the answer is: `decryptToCSV()` followed by `mysqlimport`.

---

## Concerns → releases

| Concern                                              | Addressed in                          |
|------------------------------------------------------|---------------------------------------|
| Joins / aggregations folded in userland              | v0.6                                  |
| Passphrase unlock awkward for client portals         | v0.7                                  |
| i18n hand-rolled per consumer; labels drift; multi-lang fields lose translations | v0.8 |
| Sync conflict resolution model unclear               | v0.9 ✅                               |
| Plaintext export formats beyond JSON                 | post-v0.5 `@noy-db/decrypt-*` family  |

---

## Cross-cutting investments

- **Bundle size budget.** Core under 30 KB gzipped. Each adapter under 10 KB.
- **Tree-shakeable feature flags.** Indexes, ledger, schema validation each cost zero bytes if unused.
- **WASM crypto fast path.** Optional accelerator for >10MB bulk encrypts. Never a dependency.
- **Accessibility.** Vue/Nuxt UI primitives produce ARIA-correct output.
- **i18n of error messages.** Especially Thai, given the first consumer.
- **Telemetry.** Opt-in only, local-first. `noydb stats` shows your own usage; nothing leaves the device.

---

## Contributing

Open a discussion before opening a PR that touches anything past v0.7 — the further out on the roadmap, the more likely the design will shift. Anything that violates the *Guiding principles* is out of scope, no matter how exciting.

---

*Roadmap last updated: noy-db v0.9.0 — 2026-04-09*
