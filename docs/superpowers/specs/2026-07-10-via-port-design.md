# The Via port — unified field features (sub-project A) — design (#623)

**Date:** 2026-07-10
**Issue:** [#623](https://github.com/vLannaAi/noy-db/issues/623) · **Milestone:** #28 "Via port: unified field features [api]"
**Surface:** `api` — a new, additive `via(...)` declaration surface; existing spellings preserved as sugar. The `/adapter` and `/cargo` seams are byte-untouched.
**Empirical motivation:** #621 (sync-applied writes skip derivation dispatch), #622 (forget() leaves derived residue), #612 (money type-inversion), plus the hand-wired pairwise integrations catalogued in §"Why now".

---

## The story

The noy-db kernel is a pure encrypted document store: documents, envelopes, a query executor — and **one port**. Everything a field can *be* — indexed, a reference, computed, money, translated, classified, a blob — is a **via-feature**: a declaration on the field that plugs behavior into one phased pipeline. You start with plain JSON and adopt one feature at a time; each is a separately tree-shaken chunk; anything you don't declare doesn't exist in your bundle. Underneath, every feature's promises — freshness, referential integrity, security posture, erasure — are enforced through one dependency graph and one mutation choke point, so a stale rollup, a dangling reference, a leaked derivative, or an unforgotten residue is a *kernel-refused state*, not a bug found in production.

**The architecture in one sentence:** *via-features declare, services provide engines, the kernel runs pipelines, the graph connects them.*

```ts
// rung 0 — kernel only: plain encrypted documents. No features, no chunks.
title:    {}

// each rung is one declaration + one tree-shaken chunk:
number:   via(indexed())                                   // fast lookup            (phase D)
customer: via(ref('customers', { onDelete: 'restrict' }))  // FK integrity           (phase D)
summary:  via(searchable())                                // full-text              (phase D)
subtotal: via(money('EUR'))                                // exact arithmetic       (phase A)
label:    via(i18nText())                                  // locale fills + Label   (phase A)
total:    via(computed(r => r.subtotal * (1 + r.vat), { deps: ['subtotal','vat'] }),
              money('EUR'))                                // derived + stacked      (phase C + A)
iban:     via(classified())                                // sealed at rest         (phase B)
contract: via(blob())                                      // externalized binary    (phase B)
```

## The grammar (the naming system this arc completes)

noy-db speaks **prepositions**; the grain is the tier. `for` and `with` are JS reserved words — `via` is legal, pipeline-true ("the value passes via the seal, via the formula, via the index"), the sibling of `by-` ("by way of"), and security-honest where `like` would read as simulation.

| Prefix | Tier | Reads as | Examples |
|---|---|---|---|
| **2-letter** `to- in- on- as- by- at-` | family packages (where noy-db meets the world) | data goes *to*, runs *in*, unlock *on*, export *as*, sync *by*, sealed *at* | `to-postgres`, `in-react`, `as-csv` |
| **3-letter** `via-` | **field grain** (how a value flows) | the value passes *via* these features | `via(money('EUR'), indexed())` |
| **4-letter** `with-` | vault grain (what the vault is equipped with) | the vault comes *with* these services | `withSync()`, `with-periods` |

**Collection = the meeting point, not a tier.** Everything collection-level decomposes: per-collection *configuration* of `with-` services (conflictPolicy, crdt, lazy), kernel-fixed validation (schema), aggregated field declarations (sugar for per-field `via(...)`), and collection *topology* already defined by `with-` factories (`withMaterializedView`, `withOverlayedView`, `satelliteOf`). No third preposition.

**Layers group both tiers by domain** (cohesion follows domain — same-layer features share engines):

```
src/
  kernel/            # essential core + the Via port (contract, registry, pipeline, choke point)
  shape/             #   representation        → via-money  via-i18n  via-classified  via-blob
  formula/           #   derivation            → via-computed · with-derivation  with-materialized-view  with-overlay-view
  lookup/            #   access paths (NEW)    → via-indexed  via-searchable  via-ref
  party/             #   multi-party           → with-sync  with-team
  commit/            #   durability            → with-history  with-tx
  audit/             #   compliance            → with-periods  with-attestation
  store/             #   storage orchestration → with-route  with-lazy
```

The tell that this layout is a *correction*, not taste: `with-shape/money` is already mislabeled — there is no `withMoney()`; money is a field feature squatting in a `with-` folder. Folder moves ride the retrofits incrementally (each phase moves only the features it rewrites); subpath exports stay short (`@noy-db/hub/money`); the prefixes live in folders, docs, and the catalog. Correctly-tiered `with-*` folders migrate to layer folders only when touched.

**The kernel ships zero via-features.** A vault with no via declarations pays nothing: the pipeline degrades to identity and today's fast paths are untouched.

## Why now — the empirical record

These are shipping facts, not aesthetics:

1. **#621 — sync-applied writes skip derivation dispatch.** `_applyRemoteChange` invalidates caches (the #598 fix), emits `change`, marks search dirty — and never calls `dispatchDerivations`/`markStale`. A pulled child edit leaves the parent's materialized rollup silently stale. The #598 class again: a mutation path bypassing a maintenance hook.
2. **#622 — forget() leaves derived residue.** No forget/erasure code anywhere in `with-formula/`. `forget(X)` shreds X while rollups and MV rows *derived from* X survive — erasure incompleteness in a zero-knowledge product.
3. **Pairwise hand-wirings already exist** and each new pair is another: `dispatchDerivations` manually decodes money (`moneyRuntime().canonicalizeStoredMoney(...)`); i18n carries an explicit `mv` policy layer for materialized-view input; a `_derivedFrom` sentinel guards derivation loops ad-hoc.
4. **#612 + ~31 value imports.** The kernel imports values from with-shape at ~31 sites (classified 8, i18n 8, satellites 4, blobs 3, links 3, schema-update 3, introspection 1, persisted-schemas 1) plus the with-formula couplings (registries, `markStale`/`resolveStaleOnRead`). Money — the cleanest — still leaks type-only imports (#612). This arc eliminates the money/i18n/classified/blobs/computed/formula couplings; links partially via `ref()` (D); satellites/schema-update are structural and out of scope.
5. **Money and i18n already hand-roll "virtual fields"** (`<field>Formatted`/`<field>Number`, `<field>Label`) — per-feature implementations of what `computed(virtual)` generalizes (C).

The taxonomy underneath: **{virtual, materialized} × {attribute, collection}** — `computed(virtual)` *(new, C)* / `computed(materialized)` + cross-record derivations / `overlay-views` / `materialized-views`. One dependency graph serves all of it, plus taint and erasure.

## Decision summary

1. **One unified port (`Via`), ordered per-field stacks** — not two composable ports. All hook groups live on one contract; unused hooks are no-op passthrough. Composition = the declared order, visible and printable (debuggability: `describe()`/devtools print each field's stack, pipeline order, dep edges, staleness state).
2. **Phased pipeline, not a naive onion.** Write: `derive → normalize → validate (kernel-fixed) → encode → store`; read: `load → decode → present`. Phases guarantee cross-feature ordering a flat wrap cannot (all derives before any encode; computed-before-validation is an existing contract). Stack order applies within each phase.
3. **Sync iff sync.** A field's pipeline is synchronous iff every used hook of every feature in its stack is synchronous. Money/computed stay on the #553 sync path; classified/blobs (B) go async per-field.
4. **Mandatory declared deps for anything derived.** The dependency graph is one substrate for three guarantees: freshness (eager/lazy/virtual), taint/posture propagation (declaration-time check: "derived-from-classified stored plaintext" is an error absent an explicit, audited downgrade), erasure completeness (forget traverses the graph — fixes #622 structurally). Contract in A; engine lands in C.
5. **Security posture is a declared property the kernel enforces**: `{ encryptedAtRest, queryable, exportable, forgettable }`. Query capability is graded, not boolean: `none / det-exact / ordered / full` (det-encrypted lookups already exist). Declared in A; enforcement activates in B (posture) and C (taint).
6. **One mutation choke point.** All record mutations — local put/delete, sync-apply, CRDT merge, conflict-resolver output, schema-cutover transform, restore — flow through one dispatch. A builds the socket with behavior parity; C plugs the graph in (fixing #621 by construction; #621 may be hotfixed standalone earlier).
7. **Kernel holds the port only** (contract + registry + pipeline runner + choke point). Zero via-features in the kernel. Tree-shaking via the #553 pattern generalized: the declaration statically links the engine and installs it into the registry (money's null-holder, made generic).
8. **Back-compat as sugar.** Existing spellings (`money()` descriptors, `i18nText()`/dict descriptors, `computed:` maps, `classified:`/blob configs, `refs:`) compile to `via(...)` internally. Zero migration for current consumers; kernel-api golden grows additively.
9. **Phase order: A (port + money/i18n) → B (classified/blobs + posture) → C (formula/graph + virtual) → D (lookup) → E (external SPI, deferred).** Internal unification now; the contract is shaped so the external SPI is "publish the contract" (capability-scoped ctx, postures a plugin cannot forge), not a redesign.

## Design — sub-project A

### 1. The `Via` contract (`kernel/via.ts`)

```ts
/** Declared security posture — a property the kernel enforces, not behavior. */
export interface ViaPosture {
  /** 'envelope' = the vault's normal whole-record encryption; 'sealed' = additional field-level sealing (classified, B). */
  readonly encryptedAtRest: 'envelope' | 'sealed'
  /** Graded query participation — the kernel consults THIS for whether/how the field queries. */
  readonly queryable: 'none' | 'det-exact' | 'ordered' | 'full'
  readonly exportable: boolean
  readonly forgettable: boolean
}

/**
 * The kernel-owned field-feature port. All hooks optional; absent = passthrough.
 * Type parameters (pinned precisely in the plan): T = decoded value, P = persisted
 * form, R = the record shape a derive hook sees.
 */
export interface Via<T = unknown, P = T, R = Record<string, unknown>> {
  /** Stable brand, e.g. 'money', 'i18n'. Keys the registry and describe(). */
  readonly brand: string
  /** Declared security posture; kernel-enforced (B activates enforcement). */
  readonly posture: ViaPosture
  /** Declared dependencies — MANDATORY if `derive` is present (C activates the graph). */
  readonly deps?: ViaDeps

  // ── declaration time ──
  declare?(ctx: ViaDeclareCtx): void            // validate paths/config; throw = refuse declaration

  // ── write pipeline (phase order fixed by the kernel) ──
  derive?(record: R, ctx: ViaCtx): R | Promise<R>          // C: computed/derivations
  normalize?(value: T, ctx: ViaCtx): T                     // A: money quantize, i18n fill (sync)
  encode?(value: T, ctx: ViaCryptoCtx): P | Promise<P>     // B: classified seal, blob externalize
  // (kernel-fixed schema validation runs between normalize and encode)

  // ── read pipeline ──
  decode?(stored: P, ctx: ViaCryptoCtx): T | Promise<T>    // B
  present?(value: T, ctx: ViaReadCtx): Record<string, unknown>  // A: Formatted/Number/Label virtuals

  // ── participation ──
  query?: ViaQuerySpec        // operand transform + match semantics (money quantize-at-build); the participation GRADE lives in posture.queryable
  aggregate?: ViaReducer      // money's exact reducer
  erase?(ctx: ViaEraseCtx): Promise<ViaEraseReport>        // B/C: forget participation
  describe?(): ViaDescriptor  // introspection fragment → collection.describe() → UI
}
```

Exact TS shapes (ctx types, generics over stored/decoded forms, sync/async unions) are pinned in the implementation plan; the spec fixes the hook set, the phase mapping, and these rules:

- **`ViaCtx` is capability-scoped.** A feature receives exactly what it needs: record snapshot, field path, declared config, locale (read), a scoped store handle where justified. `ViaCryptoCtx` (B) carries a narrow sealed-slot capability — never the keyring, never the enclave. This is the boundary a future external SPI hardens; internal features respect it from day one so E is publication, not redesign.
- **Sync detection is static.** At declaration time the kernel inspects the stack's used hooks and marks the field's pipeline sync or async. `where()` operand transforms are always synchronous build-time functions (#553 preserved by construction).
- **In A, active hooks are:** `declare`, `normalize`, `present`, `query`, `aggregate`, `describe` (what money + i18n use). `derive`/`encode`/`decode`/`erase` are defined by the contract, exercised by contract-level unit tests with fixture features, and first consumed by B/C. Posture and `deps` are declared and validated for well-formedness; enforcement is staged (B: posture; C: graph).

### 2. The phased pipeline (kernel runner)

```
WRITE: [declare-time already done] → derive* → normalize → validate (zod, kernel) → encode* → store
READ:  load → decode* → present                                  (* = pass-through in A)
```

For each phase, features run in **declared stack order**. The runner lives in `kernel/via.ts` (or `kernel/via/` if it outgrows one file — plan decides); collection.ts calls the runner at the existing call sites where money/i18n branches live today, replacing the hand-wired gates. Zero-via fields skip the runner entirely (identity fast path — no regression for plain documents).

### 3. Registry & tree-shaking

`kernel/via.ts` generalizes `kernel/money-runtime.ts`'s null-holder: a `Map<brand, Via>` registry with `installVia(feature)` / `viaFor(brand)`. A `via(...)` declaration (or sugar) statically imports the feature's engine chunk, which self-installs — the #553 declaration-links-engine pattern, now uniform. Consumers that never declare a feature never load its chunk; the bundle-size CI gate keeps floor and per-feature chunks honest (via-money chunk ≈ current money chunk; floor unchanged).

### 4. The mutation choke point (socket in A, graph plug in C)

A introduces `Collection._onRecordMutated(id, action, origin)` where `origin ∈ local-write | sync-apply | crdt-merge | cutover | restore`, and routes the existing per-path behaviors through it: cache invalidation, `change` emission, search-index dirty-marking. **Behavior parity in A** — derivation dispatch stays where it is (local write path) until C moves it into the choke point, which fixes #621 by construction. (#621 may be hotfixed standalone before that; the hotfix is then absorbed.) The choke point is the load-bearing socket: it is *the* reason the freshness guarantee can be a guarantee.

### 5. Retrofit: `shape/via-money`

- Move `with-shape/money/` → `shape/via-money/`; the engine is unchanged; it gains a `Via` implementation object (brand `'money'`) mapping: path validation → `declare`; quantize → `normalize`; `Formatted`/`Number` virtuals → `present`; operand quantization → `query`; exact reducer → `aggregate`; describe fragment → `describe`. Posture: `{ encryptedAtRest: 'envelope', queryable: 'ordered', exportable: true, forgettable: true }`.
- Delete `kernel/money-runtime.ts` (the generic registry replaces it) and the 5 gated `moneyRuntime()` call sites (the pipeline runner replaces them). All kernel `import type ... from with-shape/money` lines die — **#612 closes as a by-product**, the arrow now points feature → kernel-port.
- Invariants pinned by tests: #553 sync semantics (build-time quantization, sync `toArray()/first()/count()`), aggregate exactness, `dispatchDerivations`'s money-decode preamble keeps working (it may temporarily call the feature through the registry; C absorbs it into phases), the entire existing money suite green unchanged, bundle chunk parity.

### 6. Retrofit: `shape/via-i18n`

- Move `with-shape/i18n/` → `shape/via-i18n/` with a `Via` implementation (brand `'i18n'`): fill-missing-translations → `normalize`; `Label`/locale-resolved virtuals → `present`; locale-aware matching → `query`; declaration checks → `declare`; describe fragment → `describe`. Posture: `{ encryptedAtRest: 'envelope', queryable: 'full', exportable: true, forgettable: true }`.
- **Stays service-side in A:** the dictionary machinery (`_dicts` storage, `vault.dictionary()`, static-dict descriptors) — vault-grain concerns the via-feature consumes; and the `mv` policy layer stays hand-wired until C absorbs it into the graph.
- i18n is the bigger move (~8 kernel value-import sites). Same acceptance: existing i18n suites green unchanged, kernel imports from the feature = zero.

### 7. Back-compat sugar

Existing public spellings are re-expressed as thin compilers to `via(...)`: the `money()`/`i18nText()`/dict descriptors and their config keys produce the same stacks. No public API is removed; `via` is additive on the kernel-api golden. Docs teach `via(...)` as the canonical spelling; sugar is documented as equivalent.

### 8. Architecture guards & ceilings

- New `check-architecture` rules: **kernel imports nothing from `*/via-*`** (glob, replaces the per-path money exception hunting); **`via-*` never imports the enclave directly** (crypto arrives only through `ViaCryptoCtx` — enforced from A even though A features don't use it); existing guards (stores-ciphertext-only, hub-portable, strategy-opt-in) unchanged.
- Ceilings: collection.ts (4,705) and collection-config.ts shed the money/i18n hand-wiring; kernel gains `via.ts` (~400–600 LOC estimate). Expectation: collection.ts ratchets **down** for the first time since the Phase-5 extractions; the plan records exact numbers.
- `features.yaml` gains via-money/via-i18n entries; SERVICES.md gains the via concept + pointer (full catalog unification is a later docs pass, not A).

### 9. Testing (A acceptance)

1. **Behavior lock:** the complete existing money and i18n suites pass unchanged (they are the retrofit's spec).
2. **Port unit tests:** registry install/lookup; phase ordering with a 2-feature fixture stack (order within phase, phases across features); sync-stack detection (all-sync → sync pipeline; one async fixture → async), `where()` transforms stay build-time-sync.
3. **Zero-via parity:** a plain collection's read/write/query paths are byte-equivalent to pre-arc behavior (fast-path benchmark unchanged within noise).
4. **Choke-point parity:** put/sync-apply/CRDT-origin mutations produce today's exact side-effect set (cache, events, search dirty) — including the #598 regression tests.
5. **Guards:** `grep -rn "shape/via-money\|shape/via-i18n" packages/hub/src/kernel` → nothing; new glob rules green; kernel-api golden additive-only; bundle gate green (floor + chunk parity).
6. **Sugar equivalence:** old-spelling declarations and `via(...)` produce identical stored envelopes and identical `describe()` output.

## Phases B–E (scoped, each its own spec + plan)

- **B — security shapes:** `shape/via-classified`, `shape/via-blob`; the async pipeline in anger; `ViaCryptoCtx` (scoped sealed-slot capability); posture *enforcement* (queryable/exportable/forgettable consulted by query DSL, `as-*` export path, forget); `erase` hooks carry the existing classified/blob forget participation.
- **C — formula & the graph:** `formula/via-computed` with **`virtual` mode** (generalizing money/i18n's hand-rolled virtuals via `present`); the dependency+invalidation engine unifying derivations' `eager/lazy/stale` with MV's analyzer; choke point gains graph dispatch on every origin (**fixes #621 structurally**); forget traverses the graph (**fixes #622**); taint/posture propagation checks at declaration time; money-decode and i18n-`mv` hand-wirings absorbed into phases. **Open constraints logged for C:** the sealed-period rule (a recompute targeting a period-sealed record: recommended rule — derived writes respect the seal; compensate in the new period) and the `_ts` hazard (maintenance rewrites must not yank records across freeze/archive windows); MV-as-collection-scale-`via` unification is an open door, not committed.
- **D — lookup layer:** `lookup/via-ref` (FK = a dependency edge with `cascade|restrict|nullify` invalidation policy — same graph), `lookup/via-indexed`, `lookup/via-searchable` (index/search maintenance re-homed onto the choke point, where search's dirty-marking already lives).
- **E — external SPI (deferred):** publish the contract; plugin sandboxing; posture non-forgeability audit. The internal phases keep the boundary honest so E is publication, not redesign.

## Out of scope (all phases)

- **Satellites, schema-update, links-beyond-`ref()`** — structural/lifecycle, not field features; their kernel couplings are acknowledged and unresolved by this arc.
- **Vault-grain (`with-`) service mechanics** — untouched except the catalog vocabulary.
- **`/adapter`, `/cargo`, envelope format, `to-*` stores** — byte-untouched; ciphertext-only invariant unchanged.
- **klum-db / fleet anything** — via-features are single-vault.
- **Renaming the external package families** — the 2-letter preposition grammar is the product's asset; untouched.

## Impact map (reference)

| Who | Impact |
|---|---|
| Kernel | field knowledge collapses to one port; collection.ts/config shed hand-wiring; ceilings expected down |
| `shape/` `formula/` `lookup/` services | become via-features / graph consumers per phase |
| `to-*` (both repos) | none — envelopes + `/adapter` unchanged |
| `noy-db-ui` | `describe()` gains one uniform via vocabulary — schema-driven UI renders any feature |
| `as-*` exporters | consult declared `exportable` posture centrally (B) |
| `in-*` bindings | types flow; no structural change |
| klum-db / `cargo` | none |
| nit-db | parity surface eventually mirrors the port; clean-room benefits from the smaller kernel |
