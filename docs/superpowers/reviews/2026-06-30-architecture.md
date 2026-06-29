# `@noy-db/hub` — Architecture / Invariant-Discrepancy Review

Scope: where the code and its stated architecture have drifted apart.
Target: `/Users/vicio/lanna-db/noy-db/packages/hub`. Read-only.

## Executive summary

The hub is architecturally coherent in its *invariant that matters* (crypto happens in the
hub before any store; stores hold ciphertext) — that boundary is real and mechanically guarded.
But the **"minimalist core" story is no longer honest**: the three always-on orchestration files
(`collection.ts` 5,739 + `vault.ts` 4,676 + `noydb.ts` 3,110 = **13,525 LOC**) dwarf the
documented "~6,500 LOC core" and the "~3,000 LOC" Vault/Collection-model line in `SUBSYSTEMS.md`.
The subsystem catalog has drifted from the real export/folder layout (phantom subpaths, factories
with no subpath, subpaths with no factory, and a dozen feature folders inlined into the kernel).
The `kernel-surface` ratchet is the most honest guard in the repo — and it documents, bump by
bump, exactly how the "lean kernel" eroded. The cache/to-memory double-residency claim is
**confirmed**.

Finding counts: **High 4 · Medium 5 · Low 3**.

---

## HIGH

### H1 — "Minimalist ~6,500 LOC core" is aspirational, not load-bearing
- **Stated:** `noy-db/CLAUDE.md`: "always-on core is only ~6,500 LOC." `SUBSYSTEMS.md:34` (C1):
  "Vault & Collection model … ~3,000 LOC."
- **Actual:** `collection.ts` = 5,739 LOC, `vault.ts` = 4,676, `noydb.ts` = 3,110 — **13,525 LOC
  in the three always-on files alone**, before counting always-on `crypto.ts`, `store/`, `errors`,
  `schema`, `refs`, `query` basics, `record-keys/`, `money/`, `computed/`, `search/`, `embeddings/`
  (all of which are pulled in by the kernel hot path; see H3). Total `src` non-test = 65,308 LOC.
- **Implication:** The headline figure is off by ~2x against the three files and ~4x against the
  C1 line item. The minimalist-core claim is **aspirational**. The thing keeping the core honest
  today is not the LOC budget — it's tree-shaking of opt-in *strategy implementations*; the
  *orchestration* that decides whether to call them is fully resident and large.

### H2 — `kernel-surface` ceiling has functioned as a permission slip, not a cap
- **File:** `scripts/check-architecture.mjs:402-518` (`KERNEL_SURFACE_BUDGET`).
- `collection.ts` ceiling = **5,740** vs actual **5,739** (1-line headroom). The budget comment
  block records a continuous climb: `3950 → 3985 → 4010 → … → 5278 → 5285 → … → 5740` — roughly
  **+45%** over the tracked window, every step a "conscious reviewed bump." `vault.ts` ceiling 4,677
  (actual 4,676), `noydb.ts` 3,140 (actual 3,110).
- **Stated intent (line 645 message):** "The always-on kernel must stay lean — move new capability
  into a subsystem that registers on the SubsystemBus." **Actual:** capability keeps landing in the
  kernel and the ceiling is raised to match. The guard prevents *silent* regression (good) but has
  not kept the kernel lean — it has documented its growth.
- **Implication:** This is the single best evidence for H1. The ratchet is healthy as a tripwire;
  it is being used as an approval queue.

### H3 — A dozen real feature folders are baked into the always-on kernel with no `with*()` seam and no subpath
- **Stated:** `noy-db/CLAUDE.md`: "If you don't opt into a subsystem, its real implementation is
  replaced by a NO-OP … and tree-shaken out." Implies feature folders sit behind a `with*()` +
  subpath seam.
- **Actual:** these `src/` feature folders have **neither a subpath export nor a `with*()` factory**
  and their call-sites are inlined into `collection.ts` (per the budget comments): `money/`,
  `computed/`, `search/`, `embeddings/`, `links/`, `sequence/`, `record-keys/`, `persisted-schemas/`,
  `schema-update/`, `policy/`, `custody/`, `directory/`, `meta/`, `coordination/`, `introspection/`,
  `auth-introspection/`. The kernel-surface comments explicitly say money/computed/search/embeddings/
  densify/provenance "cannot move onto the SubsystemBus" and live as "thin call-sites" in the hot path.
- **Implication:** These are subsystems-in-spirit that are always-on. The product-surface claim
  ("subsystem catalog IS the product surface, each tree-shakeable behind `with*()`") does not hold
  for this whole class. Their *engines* may be in subfolders, but their dispatch is unconditional
  kernel weight and they cannot be opted out.

### H4 — Most subsystems are kernel-coupled via named strategy fields, not the `subsystem-bus`
- **Files:** `collection.ts:202-209` (`blobStrategy`, `aggregateStrategy`, `crdtStrategy`,
  `historyStrategy`, `i18nStrategy`, `syncStrategy`); `vault.ts:216-231` (10 named strategy fields:
  blob, archive, index, aggregate, crdt, consent, periods, shadow, history, forget…).
- **Stated:** `subsystem-bus.ts` exists (192 LOC) as the decoupling seam; its own header and
  `check-architecture.mjs:396-401` say write-gating subsystems were "moved off these files onto the
  SubsystemBus" and the ceiling "locks that in."
- **Actual:** the bus comment (`subsystem-bus.ts:3`) lists only "devtools inspector, audit,
  sync-dirty notification" as registrants, and the ceiling rationale names only **periods + guards**
  as having actually moved. The remaining ~13 strategies are still hard-wired as named `private
  readonly …Strategy` fields the kernel branches on directly.
- **Implication:** The bus is real but under-adopted; "subsystem awareness baked into the kernel" is
  the norm, not the exception. Adding a subsystem still means editing `collection.ts`/`vault.ts`,
  which is exactly what the bus + ratchet were meant to stop.

---

## MEDIUM

### M1 — Phantom subsystems: `joins` (#2) and `live` (#4) are documented with subpaths + LOC-saved but have no module and no export
- **Stated:** `SUBSYSTEMS.md:55,57` advertise `@noy-db/hub/joins` ("~470 LOC saved") and
  `@noy-db/hub/live` ("~210 LOC saved") as numbered, opt-in subsystems.
- **Actual:** no `src/joins/`, no `src/live/` directory; no `./joins` / `./live` in `package.json`
  exports; no `withJoins` / `withLive` factory; `index.ts` re-exports neither. Join logic lives in
  core `src/query/join.ts`; `.live()` resolves to 1 inlined call-site in `collection.ts`.
- **Implication:** Two of the 24 catalog rows describe seams that don't exist as documented. A
  consumer following the docs to `import … from '@noy-db/hub/joins'` gets a resolution failure.

### M2 — `routing` (#17) claimed as `@noy-db/hub/routing` but there is no such subpath
- **Stated:** `SUBSYSTEMS.md:116` — `@noy-db/hub/routing`, ~1,985 LOC (multi-store routing,
  middleware, sync-policy, LRU cache).
- **Actual:** no `./routing` export. The factories (`withCache`, `withMetrics`, `withRetry`,
  `withCircuitBreaker`, `withHealthCheck`, `withLogging`) live in `src/store/store-middleware.ts`
  and are re-exported through `./store` and top-level `src/index.ts`. `route-store.ts`,
  `sync-policy.ts` also under `src/store/`.
- **Implication:** The documented entry point is wrong; the capability is real but reached via
  `@noy-db/hub/store` / the root export. Subpath/catalog drift.

### M3 — `transactions` subsystem documented at the wrong subpath
- **Stated:** `SUBSYSTEMS.md:65` — `@noy-db/hub/transactions`.
- **Actual:** the export is `./tx` (`package.json` → `dist/tx/index.js`), factory `withTransactions`.
  No `./transactions` alias.
- **Implication:** Minor but real: docs name a subpath the package does not expose.

### M4 — Subpath exports with no `with*()` opt-in seam: `team`, `attestation`, `sealed-record`
- **Actual:** `./team`, `./attestation`, `./sealed-record` are exported, but there is no `withTeam`,
  `withAttestation`, or `withSealed*` factory anywhere in `src` (grep-verified). `team` (#15,
  "~1,000 LOC") and the sealed-record/attestation epics are reached via `vault.*` methods / direct
  import, not strategy injection.
- **Implication:** Inconsistent with the "every subsystem behind a `with*()` strategy factory"
  model. Either these are always-on (then the catalog should say so) or they lack the documented
  opt-in seam. `strategy-opt-in` guard cannot cover them because there is no factory to reference.

### M5 — `strategy-opt-in` guard is materially weaker than its description
- **Stated:** `noy-db/CLAUDE.md`: "strategy-opt-in — using a subsystem API requires referencing its
  `with*()` factory."
- **Actual:** `check-architecture.mjs:343-351` (`STRATEGY_GATED_APIS`) covers **5 of 12** seams
  (self-admitted at line 338: "Coverage today: 5 of the 12 strategy seams"): only `.dump()`,
  `.ledger()`, `.dictionary()`, `.lazyQuery()`, `.exportBlobs()`. It also only fires on files that
  inline `createNoydb(` (line ~382). So `crdt`, `sync`, `aggregate`, `guards`, `periods`, `session`,
  `transactions`, `shadow` etc. throw-at-runtime APIs are **unguarded**, and any consumer file that
  receives an injected `Vault` is out of scope.
- **Implication:** The guard's name promises a general invariant; it enforces 5 hand-picked cases.
  Reasonable as a tripwire, but the CLAUDE.md description overstates it.

---

## LOW

### L1 — `withArchive` and `withDeferredNumbering` are factories with no subpath and no catalog row
- **Actual:** `withArchive` (`src/archive/`) and `withDeferredNumbering` (`src/numbering/`) are
  exported `with*()` factories but have no `./archive` / `./numbering` subpath and don't appear as
  numbered subsystems in `SUBSYSTEMS.md`. They're reached via the root export.
- **Implication:** Two more catalog/export inconsistencies; low impact (they work, just undocumented
  as seams).

### L2 — `metrics` exists as a factory but is listed under "reserved/future" subsystems
- **Actual:** `SUBSYSTEMS.md:319` lists `@noy-db/hub/metrics` as a *reserved* name ("Today partial
  via to-meter"), yet `withMetrics` is already a shipped factory in `src/store/store-middleware.ts`.
- **Implication:** The roadmap section describes as future a thing that partially exists. Minor doc lag.

### L3 — TODO/FIXME density is low (not a finding cluster), and `lru` is eagerly imported even in eager mode
- **Actual:** only 2 TODO/FIXME in non-test `src` (`collection.ts`, `bundle/walk-closure.ts`) — no
  cluster. Separately, `collection.ts:225-231` notes the `Lru` class is imported even when
  `prefetch:false` is not set (eager mode never uses it) — a self-acknowledged, un-actioned
  tree-shaking miss. Low impact.
- (`pnpm knip` not run — would require a build; skipped to stay read-only/fast. Recommend running
  it for the dead-export sweep.)

---

## The cache / to-memory redundancy claim — **CONFIRMED**

Each sub-claim verified against current code:

1. **"Each record resident in RAM twice with `to-memory`."** CONFIRMED.
   - Built-in `src/store/memory-store.ts` (and `@noy-db/to-memory`) hold **ciphertext**
     `EncryptedEnvelope`s in nested `Map`s (`vault → collection → id → envelope`).
   - `collection.ts:214` `private readonly cache = new Map<string, { record: T; version }>()`
     holds the **decrypted plaintext** record. In the default eager mode both coexist for every
     live record.

2. **"`cache` is plaintext-inside-the-boundary; `to-memory` is ciphertext-outside."** CONFIRMED.
   - `ensureHydrated()` (`collection.ts:4151-4166`) and `hydrateFromSnapshot()` (4169-4179)
     `decryptRecord(...)` each envelope and store the cleartext in `this.cache`. The store side
     never sees plaintext (the architectural invariant holds); the duplication is plaintext-in-hub
     vs ciphertext-in-store.

3. **"Eager-default `loadAll`+decrypt-whole-collection is the real memory cost."** CONFIRMED.
   - `prefetch` defaults to `true`; lazy mode is strictly opt-in (`collection.ts:1204-1206`,
     `this.lazy = opts.prefetch === false`).
   - `ensureHydrated()` lists **all** ids and decrypts **all** non-tombstone envelopes into `cache`
     (4154-4162). The bounded `Lru` (`src/cache/lru.ts`) only exists in lazy mode (`lru` is `null`
     otherwise, 1218-1221). So by default the *entire* decrypted collection is held, on top of the
     store's full ciphertext copy.

**Nuance worth flagging in the morning writeup:** the duplication is intrinsic to the
zero-knowledge boundary, not a bug — the store *must* hold ciphertext and the query DSL *must* run
on plaintext inside the hub. The actionable part is the **eager default**: for large collections on
`to-memory` you pay 2x RAM unless you explicitly pass `prefetch:false` + a bounded `cache`. The
prior analysis is accurate on all three points.

---

## Verdict on the minimalist-core claim

**Aspirational, not load-bearing today.** What actually keeps a minimal build small is
tree-shaking of opt-in *strategy implementations* and the per-subpath split — that part works. But
the always-on *orchestration* (collection.ts + vault.ts + noydb.ts = 13.5K LOC, plus a dozen
inlined feature folders per H3) is far past the documented "~6,500 LOC core," and the
`kernel-surface` ratchet has been raised ~45% to accommodate continued growth rather than holding a
line. The documents (`CLAUDE.md` ~6,500; `SUBSYSTEMS.md` C1 ~3,000) should be reconciled to the
real numbers, and H3/H4 (inlined features + named-strategy coupling) are the structural reasons the
core can't currently be called minimalist.
