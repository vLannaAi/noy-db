# `@noy-db/hub` — Refactoring / Tech-Debt Review

Scope: `/Users/vicio/lanna-db/noy-db/packages/hub`. Read-only. Oriented around the upcoming
reorg that groups optional subsystems into 7 `with-*` dimension folders. Flags which debt is
best paid **WITH** the reorg vs **independently**.

---

## TL;DR

The five giant files total ~18.4K LOC. The real problem isn't size per se — it's that
`collection.ts` (5,739) and `vault.ts` (4,676) are **god-objects** mixing 8+ concerns each, and
the crypto/envelope/sealed-field logic that *should* live in one place is **copy-pasted** across
`collection.ts`, `vault.ts`, `record-keys/sealing.ts`, and a dozen subsystem files. The reorg
will physically move subsystem code into `with-*` folders; if the duplication isn't consolidated
first, the reorg just **scatters the copies further apart**, making the eventual edge-crypto
redesign harder. Highest leverage: extract a small shared crypto/envelope/sealed-slot module
**before** the move, then split the two god-objects along seams that already exist in the method
layout. `errors.ts` and `types.ts` are big but cohesive — low-risk mechanical splits, best done
**with** the reorg so error/type modules can live beside their dimension.

---

## 1. The giant files

### 1a. `collection.ts` — 5,739 LOC, one class, ~70 methods, ~60 private fields

**Yes, it is doing far too many jobs.** The single `Collection<T,S,Q,M>` class owns: envelope
crypto (encrypt/decrypt/CEK wrap), sealed-field group-encryption, deterministic-index ciphertext,
the working-set cache + LRU, eager & persisted index maintenance, unique constraints, full-text +
vector search + retrieval, i18n densify/translate, money fields, computed fields, refs/joins,
CRDT merge, history/ledger writes, materialized-view & derivation dispatch, tiers
(elevate/demote/putAtTier), and presence. The constructor alone is **~630 lines (L624–1255)**.

**Extract candidates (by line range):**

| Concern | Lines (approx) | Extract to | Notes |
|---|---|---|---|
| **Crypto / envelope build & decrypt** | `encryptRecord` 5052–5117, `encryptJsonString` 4998–5050, `buildDebugEnvelope` 4980–4996, `decryptJsonString` 5509–5535, `decryptRecord` 5612+, `resolveEnvelopeCek` 5485–5493, `resolveRecordCek` 4952 | a `record-codec.ts` (sibling to `record-keys/`) taking `{getDEK, name, storeCiphertext, flags}` | **This is the seam the CLAUDE.md invariant cares about.** Pulling it out makes "encryption happens in the hub" a *named module* instead of 250 lines buried in a collection method. Highest-value extraction. |
| **Sealed-field seal/unseal** | `unsealField` 5559–5579, `makeSealedHandle` 5588, `toCacheRecord` 5599–5610, seal loop inside `encryptRecord` 5074–5094 | `record-keys/sealing.ts` (already exists!) | The parse + dual-read is **already duplicated** there (see §2a). Merge. |
| **Deterministic index** | `findByDet` 5132, `queryByDet` 5163, det loop 5104–5116 | `record-keys/deterministic.ts` | Self-contained; only needs DEK + name. |
| **Tiers** (elevate/demote/putAtTier/getAtTier/listAtTier/cross-tier events) | 5194–5485 (~290 LOC) | a `with-tiers` mixin/helper | A whole subsystem living inside the class. Prime reorg target. |
| **Index maintenance** (persisted/eager/unique/reconcile) | `maintainPersistedIndexesOnPut/Delete` 4660–4758, `rebuildEagerIndexes` 4191, `rebuildUniqueConstraints` 4205, `rebuildIndexes` 4233, `reconcileIndex` 4299–4415, `autoReconcile` 4849 | extend `indexing/` (already a folder) | Index logic is split between `indexing/` and the class; consolidate. |
| **Search/retrieval** | `search` 3114, `buildRetrievalDocs` 3132, `retrieve*` 3296–3376, `similarTo` 3377, `warmIndex`/`flushIndex` 3212/3281 | extend `search/` | |
| **`putInternal`** | 1746–2210 (**~465 LOC single method**) | decompose into a pipeline | computed → schema → money → i18n → refs → crdt → history → embeddings → ledger → cache, all inline. See §3. |
| **Constructor field-wiring + facade closures** | 624–1255, esp. derivation/MV/ref/join facade closures 930–1000 | a `CollectionConfig` resolver + `buildFacades(vault)` | 60+ `this.x = opts.x` assignments; the inline facade closures (derivationSource, materializedViewSource, refEnforcer, joinResolver) are ~150 lines of object literals in the ctor. |

Natural cut: the class keeps the **core CRUD + cache + query orchestration**; everything in the
table moves behind the strategy handles it already holds (`blobStrategy`, `crdtStrategy`,
`aggregateStrategy`, `historyStrategy`, `i18nStrategy`, `syncStrategy` — the pattern exists, it's
just not applied to crypto/tiers/det/search). **Do the crypto + sealed extraction independently
and first; do tiers/search/index consolidation WITH the reorg.**

### 1b. `vault.ts` — 4,676 LOC, `Vault` class (~90 methods) + `Transaction` class (L4616+)

Cohesive *clusters* are visible in the method layout and map almost 1:1 to subsystems already
having folders. Extract candidates:

- **Periods** (`closePeriod` 3559, `listPeriods`, `getPeriod`, `_assertTsWritable` 3680,
  `_loadPeriodsCache`, `_writePeriodRecord` 3709, `_decryptPeriodRecord` 3737) → `periods/` exists.
- **Sealing/record-keys** (`sealRecordToHost` 2781, `revokeSealedRecord`, `rotateRecordCek` 2818,
  `sealingContext` 2827) → `record-keys/` / `sealed-record/`.
- **Backup/dump/load** (`dump` 3960, `load` 4044, `verifyBackupIntegrity` 4159 (~370 LOC),
  `exportJSON` 4531) → a `vault-backup.ts`.
- **Attestation** (`issueAttestation` 1999, `revokeAttestation` 2041, `publishRevocationList`,
  `makeIssueContext`/`makeRevokeContext`) → `attestation/` exists.
- **Refs/links enforcement** (`enforceRefsOnPut` 2142, `enforceRefsOnDelete` 2242,
  `enforceLinksOnDelete` 2330, `resolveRef`, `resolveSource`) → `links/`.
- **Subsystem `_init*` registry wiring** (`_initGuards` 2852, `_initDerivations` 2882,
  `_initMaterializedViews` 2920, `_initOverlayedViews` 2964) → a single `registerSubsystems()` —
  these four are near-identical boilerplate (see §2c).
- **Export/import capability gating** (`assertCanExport`/`assertCanImport`/`canExport`/`canImport`
  overloads 1692–2141) → a `capabilities.ts`.
- The inner **`Transaction` class (4616–4664)** is a separate type sharing the file; move to `tx/`.

`Vault` should retain `collection()` (683–1162, the factory that wires every option into a
`Collection`), keyring/role accessors, and the subsystem registry handles. Most of the rest is
delegatable. **Almost all WITH the reorg** — these clusters *are* the dimensions being created.

### 1c. `noydb.ts` — 3,110 LOC

The instance-lifecycle core (`openVault` 507, `vault` 658, `transaction` overloads 1269–1340,
event/tab-coordination accessors) is reasonable. The bloat is one cluster:

- **Auth / recovery / enrollment** — `enrollAuthenticator` 1894 → `clearQuickUnlock` 2802 is
  **~900 contiguous LOC**: authenticators, WebAuthn, passphrase rotate/recover, Shamir, managed
  passphrase, PIN unlock. `team/` already holds `authenticators.ts`, `recovery.ts`,
  `rotate-recover.ts`, `managed-passphrase.ts`, `shamir-*` — these `noydb` methods are thin-ish
  wrappers that should move next to their implementations (or into an `on-*`/`team` facade).
- **Snapshots** (`snapshot` 2971, `initSnapshotCadence` 2988, `listSnapshots`, `restoreSnapshot`
  3039) → `snapshots/` exists.
- **Policy/session** (`attachPolicyEnforcer` 459, `touchPolicy`, `checkPolicyOperation`,
  `bootstrapPolicy` 1806, `getPolicy`/`updatePolicy`) → `policy/`.

**WITH the reorg** (auth → `with-team`/`on-*` dimension, snapshots → its own).

### 1d. `types.ts` — 2,449 LOC, 89 exported types

Cohesive but monolithic. It's a **god-barrel**: `NoydbStore` (423–606, the store contract),
`EncryptedEnvelope` (118), `NoydbOptions` (1927–2364, ~440 LOC of option surface), blob types
(1705–1925), sync types (1048–1210), export/capability types (633–945). Splitting by dimension
(envelope+store → `adapter`/`store` already export some; options → near the factory; blob → `blobs/`;
sync → `sync/`) lets each `with-*` folder own its types. **Mechanical, low-risk, do WITH the reorg**
so types co-locate with the code that moves. Watch the `index.ts` barrel (1,079 LOC) and the frozen
`kernel` seam — keep public re-exports stable.

### 1e. `errors.ts` — 2,417 LOC, **102 error classes**, all extending `NoydbError`

Flat list, each class ~15–30 LOC (message builder + `code` + structured fields). Pure mechanical
split by dimension: index/unique errors → `indexing/errors.ts`, derivation/MV/overlay errors →
their folders, schema-update errors (already a subclass tree `SchemaUpdateError` 981–1051) →
`schema-update/`, sealed/tier/record-cek → `record-keys/`. Keep `NoydbError` base + the truly-core
ones (`DecryptionError`, `TamperedError`, `NoAccessError`, `ValidationError`) in a root `errors.ts`,
re-export all from the barrel for back-compat. **Lowest-risk of the five; do WITH the reorg.**

---

## 2. Duplication (DRY)

### 2a. Sealed-field `iv:data` parse + dual-read — **duplicated, drifting** ⚠️
`collection.ts unsealField` (5559–5579) and `record-keys/sealing.ts` (154–165) implement the *same*
three steps independently: `const sep = blob.indexOf(':'); iv = slice(0,sep); data = slice(sep+1)`,
then **try `deriveSealedFieldKeyFromCek` → catch → fall back to `deriveSealedFieldKey(dek)`** (the
#306 dual-read). Two copies of a security-critical fallback that *must* stay byte-identical.
`history/history.ts:25` has a third colon-split. **Extract `parseSealedSlot(blob)` +
`unsealSlot(blob, {cek, dek, collection, field})` into `record-keys/sealing.ts` and call from both.**
High-value, low-effort, **do BEFORE the reorg** (the edge-crypto redesign will rewrite this path;
one copy is far cheaper to redesign than three).

### 2b. Envelope literal construction — repeated ~30× across the tree
`{ _noydb: NOYDB_FORMAT_VERSION, _v, _ts: new Date().toISOString(), _iv, _data, _by, ...}` is
hand-built **7× in `vault.ts`, 7× in `collection.ts`, 8× in `blobs/blob-set.ts`**, plus
`record-keys/sealing.ts`, `meta/user-envelope/storage.ts`, `history/ledger/store.ts`,
`team/recovery.ts`, `sequence`, `numbering`, `i18n/dictionary`, `forget/subject-index`. The
"encrypt-then-wrap-in-envelope" idiom (`const {iv,data} = await encrypt(json, dek); return {_noydb,…,_iv:iv,_data:data,_by}`)
and its plaintext counterpart (`_iv:'', _data:json`) recur verbatim. **Extract
`buildEnvelope(json, {dek?|cek?, version, by, ts?, provenance?})` and `buildPlaintextEnvelope(...)`
into the record-codec module.** Removes the most-copied 6-line block in the package. **BEFORE the
reorg** — otherwise the copies scatter into 7 folders.

### 2c. Subsystem triplet boilerplate — `index.ts` + `active.ts` + `strategy.ts`
~13 subsystems follow the identical shape (`aggregate`, `blobs`, `crdt`, `consent`, `indexing`,
`snapshots`, `tx`, `periods`, `shadow`, plus `history` etc.): a `strategy.ts` (the `with*()` factory
+ no-op stub seam), an `active.ts` (the real impl), an `index.ts` (barrel). And `vault.ts`'s four
`_initGuards/_initDerivations/_initMaterializedViews/_initOverlayedViews` (2852–3010) are
near-identical registry-wiring. The `with-*` reorg is the moment to **codify the triplet as a
template** (or a tiny `defineSubsystem({ stub, active })` helper) so each dimension folder is
uniform and the `_init*` quartet collapses to one parameterised `registerSubsystem(handle)`.
**This IS the reorg work** — fold it in rather than relocating 13 ad-hoc triplets.

### 2d. `isTombstone(env, storeCiphertext)` — called 6× in collection (1493/1737/2282/2293/2672/2953)
Already extracted (`record-keys/tombstone.ts`) — good. No change; cited as the *model* the
crypto/envelope extraction should follow.

---

## 3. Complexity hotspots

- **`Collection.putInternal` (1746–2210, ~465 LOC, one method).** The write pipeline —
  computed→schema→money→i18n densify/translate→refs→crdt(lww/rga branch)→history→cache→embeddings→ledger
  — all inline with deep `if (this.x)` nesting (the i18n + crdt blocks alone reach 4–5 levels,
  e.g. 1953–1999, 1882–1918). A reader cannot hold it in their head. Refactor to an explicit
  ordered list of pipeline steps (each a private method taking a small mutable write-context), so
  the order is legible and individually testable. High-value; **independent of reorg** but easier
  once crypto is extracted (§1a).
- **`Collection` constructor (624–1255).** 60+ field assignments + ~150 LOC of inline facade-closure
  object literals. Extract `resolveCollectionConfig(opts)` and `buildFacades(vault)`.
- **`Vault.verifyBackupIntegrity` (4159–~4530, ~370 LOC)** and **`Vault.load` (4044–4159)** — long,
  branchy backup logic; move to `vault-backup.ts` and decompose.
- **`noydb` auth/recovery cluster (1894–2802, ~900 LOC)** — many near-parallel rotate/recover
  variants (`rotateRecoveryPaper` 2341 vs `rotateRecoveryShamir` 2376; `recoverPassphrase` vs
  `recoverManagedPassphrase` vs `recoverUser`). Consolidate behind `team/recovery`.

---

## 4. The eager-cache default (`prefetch: true`)

`vault.ts:661` documents the default: `prefetch:true` (eager) "loads everything on first access";
`prefetch:false` (lazy) uses a bounded LRU and **requires `cache` bounds**. Eager mode means the
**entire collection is decrypted into a `Map` (`collection.ts:214`) on first touch** and held in
RAM as plaintext for the session.

Assessment:
- **Correctness/perf:** eager-by-default is the simpler mental model and makes `list()/query()`
  synchronous-feeling, but it's the wrong default for (a) large collections, (b) the zero-knowledge
  threat model (whole-collection plaintext resident in RAM longer than necessary), and (c) memory on
  constrained edge/browser/Worker targets. The code already *supports* lazy fully (LRU, persisted
  indexes, `ensurePersistedIndexesLoaded`, auto-reconcile) — lazy is a mature path, not a stub.
- **Cost of flipping the default to lazy:** lazy currently **requires** explicit `cache` bounds and
  changes the perf profile of unindexed `query()`/`list()` to a store scan + decrypt (vault.ts:2253
  notes this). Flipping naively would break callers relying on eager warmth and force every
  collection to declare cache bounds. A safe path: pick a **sensible default LRU bound** so lazy
  needs no config, keep eager opt-in for small/hot collections, and let `describe()`/indexes drive
  warmth.
- **Overlap with the edge-crypto redesign (specced separately):** the redesign reportedly reworks how/
  when plaintext materialises. **Do NOT flip the default as part of *this* refactor** — but the
  crypto/envelope extraction (§1a) is a prerequisite that makes the lazy/eager boundary a clean seam.
  Recommendation: treat "lazy-by-default + zero-config LRU bound" as a **decision owned by the
  edge-crypto spec**, and land §1a first so that spec has a single `record-codec` to target rather
  than crypto smeared through `Collection`. Note the overlap explicitly in the reorg plan; the
  mechanic refactor here is just *isolating the cache from the codec*.

---

## 5. Test structure (~333 `*.test.ts`, 229 in flat `__tests__/`)

- **Layout mismatch vs reorg + vs CLAUDE.md.** CLAUDE.md says "tests live beside source"; in fact
  hub centralises them in a **flat `__tests__/`** (229 top-level files). The `with-*` reorg will move
  source into 7 dimension folders, leaving a flat test dir that no longer mirrors structure. Decide
  now: mirror `__tests__/with-*/…` or co-locate. **Address WITH the reorg** (moving tests is cheapest
  in the same pass that moves source).
- **No shared fixtures.** **172 of 229 files call `createNoydb(` directly and 0 import a local
  test-helper** — every file re-inlines vault/collection setup (memory store + openVault + unlock).
  This is the brittleness source: a constructor/option change ripples across 170+ files. **Extract a
  `__tests__/helpers/` with `makeVault()`/`makeCollection()` fixtures.** High-value, independent of
  reorg, reduces churn *during* the reorg.
- **Large suites** (`bundle-auto-unlock` 782, `blob-set` 753, `refs` 724, `route-store` 637,
  `dictionary` 622): not flagged as wrong, but candidates to split per-behaviour when their source
  moves, so each dimension folder gets focused suites.

---

## Ranked actions (value/effort)

| # | Item | V/E | With reorg? | Where |
|---|---|---|---|---|
| 1 | Extract `record-codec.ts` (envelope build + encrypt/decrypt/CEK) out of `Collection` | High / Med | **Before** | collection.ts 4980–5160, 5485–5660 |
| 2 | Dedupe sealed-slot parse + #306 dual-read into `record-keys/sealing.ts` | High / Low | **Before** | collection.ts 5559–5579 ↔ sealing.ts 154–165 |
| 3 | `buildEnvelope()` helper to kill the ~30× envelope literal | High / Low | **Before** | vault/collection/blobs/+10 |
| 4 | Shared `__tests__/helpers/` fixtures (172 files inline `createNoydb`) | High / Low | Independent | `__tests__/` |
| 5 | Decompose `putInternal` (465 LOC) into an ordered write pipeline | High / Med | Independent | collection.ts 1746–2210 |
| 6 | Move `Vault` clusters (periods/attestation/backup/refs/`_init*`) to existing folders | Med / Med | **With** | vault.ts §1b |
| 7 | Move `noydb` auth/recovery 900 LOC into `team/`; snapshots/policy out | Med / Med | **With** | noydb.ts 1894–2802 |
| 8 | Lift `Collection` tiers/search/det into strategy handles | Med / Med | **With** | collection.ts 5132–5485, 3114–3420 |
| 9 | Split `errors.ts` (102 classes) by dimension, barrel-reexport | Med / Low | **With** | errors.ts |
| 10 | Split `types.ts` (89 types) by dimension; keep kernel/barrel stable | Med / Med | **With** | types.ts |
| 11 | Codify subsystem triplet template + collapse `_init*` quartet | Med / Med | **With** | 13 subsystem folders, vault.ts 2852–3010 |
| 12 | Mirror test layout to `with-*` dimensions | Low / Med | **With** | `__tests__/` |

**Sequencing:** land #1–#3 (crypto/envelope/sealed consolidation) **before** the reorg so the
edge-crypto redesign and the folder move both target one codec module, not scattered copies. #4–#5
are independent quick wins. #6–#12 are the reorg itself — fold the debt paydown into the move.
