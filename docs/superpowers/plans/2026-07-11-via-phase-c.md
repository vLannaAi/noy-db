# Via Phase C Implementation Plan (#638) — formula/graph

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the per-vault dependency graph that `with-formula` (derivations/rollups/MV/overlay) and `computed` consume, and use it to land four structural fixes — sync-applied writes now dispatch derivations (#621), taint propagates the strictest source posture onto derived fields (#636), frozen-period output writes skip instead of failing the source write (#637), and `forget()` fans out to derived residue (#622) — plus a `computed(virtual)` read-time mode.

**Architecture:** A new kernel-resident `ViaGraph` (one instance per vault, metadata-only: field names, postures, grains — never values or key material) is built at collection-declare time from three edge sources (via bindings' `deps`, `computed` registrations, `with-formula` registrations incl. cross-collection). It serves exactly three consumers: **freshness** (a batched sync-dispatch wave at pull/push end, `via-dispatch.ts`), **taint** (an effective-posture overlay the existing phase-B `postureFor` consults, so query-refusal + export-redaction enforce it with zero new surface, plus at-rest sealing of materialized tainted fields through the phase-B `ViaCryptoCtx.sealedSlots` capability), and **erasure** (a forget fanout that recomputes aggregate-grain and erases record-grain artifacts). `computed` becomes a via-feature via a `computed()` descriptor consumed through `via(...)`; `with-formula` stays service-side and consumes the graph — the dictionary/blob precedent. The graph and dispatch bus live in NEW kernel files (not ceiling-guarded); collection.ts/vault.ts changes are param-threading + call-site swaps only.

**Tech Stack:** TypeScript, `@noy-db/hub` (tsup + vitest), turbo monorepo. Run from repo root: `pnpm vitest run <path>`; one package: `pnpm --filter @noy-db/hub <script>`.

## REQUIRED READING (every task)

- Spec: `docs/superpowers/specs/2026-07-11-via-phase-c-design.md`
- **Seam map (ground truth, exact anchors + verbatim excerpts):** `.superpowers/sdd/seam-map-formula-graph.md` — Part-N references below point into it. Line numbers were re-verified on `feat/638-via-phase-c` (HEAD `e86e1ae8`); re-locate by symbol if drifted.
- Phase-A/B conventions: `kernel/via.ts` (ViaBinding/ViaPosture/ViaCryptoCtx/SealedSlotRef), `kernel/via-pipeline.ts` (`postureFor`/`redactForExport`/`encodeAtRest`/`decodeAtRest`), `kernel/via-compose.ts` (`via()`/`mergeViaFields`), `port/with/i18n-strategy.ts` (port-move precedent), the two via guard rules + allowlists in `scripts/check-architecture.mjs`.

## Global Constraints

- **Behavior lock:** the FULL derivations (3210 LOC / 23 files), materialized-views (3252 / 15), overlay-views (606-LOC single file), computed (529 / 4 files), sync, and forget/erasure suites pass **UNCHANGED**, with **ONE documented exception**: the #621 parity pin at `__tests__/via/mutation-choke-point.test.ts:131-161` (self-commented "phase C changes this" at lines 154/157/158) flips from pinning the bug to pinning the fix. Any test edit other than ADDING tests, or that one pin-flip, is a deviation to flag. In particular: the runtime `_derivedFrom`/`_materializedFrom` recursion sentinels (`collection.ts:2270`/`2081`) STAY — only the DECLARE-TIME cycle DFS moves into the graph (Task 2); the local-write dispatch path stays byte-identical (the wave param defaults `undefined`).
- **Zero-knowledge non-negotiable:** the graph holds field names, postures, grains ONLY — never record values, never key material. A via feature (incl. the new `computed`/`taint` bindings) never receives the keyring, raw DEKs/CEKs, or the enclave barrel — only the two `ViaCryptoCtx` capabilities, pre-bound and scope-checked (phase-B seam). Sealing of materialized tainted fields (Task 3) reuses `ctx.sealedSlots` exactly as classified does — no new crypto path.
- **Ceilings are EXACT-LOCKED:** `collection.ts` **4473**, `vault.ts` **4088**, `noydb.ts` **2385** (`scripts/check-architecture.mjs` `LINE_CEILINGS`). collection.ts is AT its exact ceiling with dense-style debt at lines 360-361/384/406/405-411 — **any task adding lines to a ceiling-guarded file must plan its equal same-task shrink FIRST (collapse the flagged dense decls) OR route the logic into a new kernel file.** No silent bumps. A genuine ratchet-up is a BLOCKED decision requiring explicit user sign-off with a flagged deviation, not a bump. Report final counts every task that touches a guarded file.
- **Guards end-state:** `VIA_ENCLAVE_ALLOWLIST` stays **EMPTY** (`new Map([])`) and still fires on synthetics; `VIA_SHAPE_ALLOWLIST` (`via-layering`) stays **exactly** `[join.ts → '../../shape/via-i18n/core.js']` (#626). New kernel files must not import `src/shape/**`; the new `shape/via-computed/**` must not import `kernel/enclave/**`.
- **New kernel files preferred over ceiling-guarded files:** `kernel/via-graph.ts` and `kernel/via-dispatch.ts` are new and unguarded — put logic there; leave collection.ts/vault.ts to thin call-site swaps + param threading.
- Run `pnpm --filter @noy-db/hub bundle-check` at the tasks that change compiled surface (Tasks 4, 7; build first — `NODE_OPTIONS=--max-old-space-size=8192` if DTS OOMs). The graph/dispatch modules must stay out of the floor bundle for collections that declare no derivation/computed feature (same lazy-import discipline as `dispatchDerivations`).
- **Never add Claude attribution** to commits/PRs/CHANGELOGs. **Grep every diff for "accounting-firm" before every commit.**

---

### Task 1: Graph core — the `ViaGraph` kernel model + taint algebra (new file)

**Files:**
- Create: `packages/hub/src/kernel/via-graph.ts` — the node/edge model, registration API, cycle rejection (throws the existing `DerivationCycleError`/`MaterializedViewCycleError`), and the pure effective-posture (taint) algebra.
- Test: `packages/hub/__tests__/via/graph.test.ts`

**Interfaces — Produces (later tasks rely on these EXACT names):**

```ts
// kernel/via-graph.ts
import { DerivationCycleError, MaterializedViewCycleError } from './errors.js'
import type { ViaPosture } from './via.js'

/** A (collection, field) node. Artifact-grain targets (rollup field, MV row-class,
 *  overlay output) are modelled as a field node whose `field` is the artifact key. */
export interface FieldRef { readonly collection: string; readonly field: string }

export type EdgeKind = 'computed' | 'derivation' | 'rollup' | 'mv' | 'overlay'
export type Grain = 'record' | 'aggregate'

/** Metadata-only dependency graph, ONE per vault. Never stores values or key material. */
export class ViaGraph {
  /** Declare a source field's posture (money/i18n/classified/plain). Plain fields
   *  default to `DEFAULT_POSTURE`; a later declaration for the same node wins-first (idempotent). */
  registerField(collection: string, field: string, posture: ViaPosture): void

  /** A derived target depends on `sources` (may be cross-collection). `kind`/`grain`
   *  drive dispatch + erasure semantics; sources drive taint. */
  registerDerived(target: FieldRef, sources: readonly FieldRef[], kind: EdgeKind, grain: Grain): void

  /** Reject cycles at declare time (vault open). Throws `DerivationCycleError` for a
   *  derivation/rollup/computed cycle, `MaterializedViewCycleError` for an MV cycle —
   *  same classes + message shape the registries throw today (behavior lock). */
  assertAcyclic(): void

  /** Strictest source posture on every axis, per §2. `undefined` when `target` has no
   *  in-edges (not a derived field). Transitive: folds through chained derivations. */
  effectivePosture(target: FieldRef): ViaPosture | undefined

  /** Per-collection { field → effectivePosture } overlay the pipeline consumes (Task 3). */
  taintedPostures(collection: string): ReadonlyMap<string, ViaPosture>

  /** Materialized (grain !== virtual-only) derived fields on `collection` whose effective
   *  encryptedAtRest resolves to 'sealed' — the taint-seal set (Task 3). */
  taintSealedFields(collection: string): ReadonlySet<string>

  /** Dispatch (Task 4): every derived target triggered by a write to `collection`. */
  dependentsOf(collection: string): ReadonlyArray<{ readonly target: FieldRef; readonly kind: EdgeKind; readonly grain: Grain }>

  /** Erasure (Task 6): derived artifacts of a forgotten record whose source is `collection`. */
  derivedArtifactsOf(collection: string): ReadonlyArray<{ readonly target: FieldRef; readonly kind: EdgeKind; readonly grain: Grain }>
}

/** Plain (non-via) field baseline — max-permissive; taint only ever tightens. */
export const DEFAULT_POSTURE: ViaPosture =
  { encryptedAtRest: 'envelope', queryable: 'full', exportable: true, forgettable: false }

/** The per-axis "most restrictive" fold — pure, exported for direct unit testing. */
export function foldPosture(a: ViaPosture, b: ViaPosture): ViaPosture
```

**Interfaces — Consumes:** `ViaPosture` (`kernel/via.ts:9-14`), `DerivationCycleError` (`kernel/errors.ts:2093`), `MaterializedViewCycleError` (`kernel/errors.ts:2199`).

The algebra (`foldPosture`, per §2 — implement EXACTLY this table):
- `encryptedAtRest`: `'sealed'` wins over `'envelope'` (sealed > envelope).
- `queryable`: minimum on the ladder `none < det-exact < ordered < full` (take the LEAST capable).
- `exportable`: logical AND (`a.exportable && b.exportable`).
- `forgettable`: logical OR (`a.forgettable || b.forgettable`) — a forgettable source FORCES the derived field forgettable (erasure completeness).

`effectivePosture(target)` = fold `DEFAULT_POSTURE` with each in-edge source's own effective posture (recurse for chained derivations; the acyclicity guarantee makes this terminating), memoized per node.

- [ ] Step 1 (RED): write `graph.test.ts` — a fixture graph. Assert: (a) `foldPosture(classified, money)` = `{ encryptedAtRest:'sealed', queryable:'det-exact', exportable:false, forgettable:true }` (classified `queryable:'det-exact'` < money `'ordered'`; `false && true`; `true || false`); (b) `registerDerived({c,'total'}, [{c,'ssn'}], 'computed','record')` then `effectivePosture({c,'total'})` inherits ssn's classified sealed/non-export/non-query posture; (c) a self-referential `registerDerived` cycle → `assertAcyclic()` throws `DerivationCycleError`; an MV-kind cycle → `MaterializedViewCycleError`; (d) transitive taint (a→b→c) propagates sealed to c; (e) `taintSealedFields` includes a materialized computed field with a sealed source, excludes a plain-source one; (f) `dependentsOf`/`derivedArtifactsOf` enumerate the right targets+grains. Run `pnpm vitest run packages/hub/__tests__/via/graph.test.ts` → RED (module absent).
- [ ] Step 2 (GREEN): implement `via-graph.ts` (adjacency maps `_out: Map<nodeId, Edge[]>`, `_in: Map<nodeId, Edge[]>`, `_posture: Map<nodeId, ViaPosture>`, nodeId = `${collection}\0${field}`; DFS with a `visiting` set for `assertAcyclic`; memoized `effectivePosture`). Run RED test → GREEN. `pnpm --filter @noy-db/hub typecheck`.
- [ ] Step 3: commit — `feat(hub): add per-vault ViaGraph model + taint algebra (#638)`.

---

### Task 2: Edge sources go live — build the graph at declare time from all three sources

**Files:**
- Modify: `kernel/via.ts` — fix `ViaBinding.deps`'s lying doc comment (lines 79-81: "phase C consumes; A only validates" — no reader/validator exists; make the comment truthful: "phase C: validated + graph-registered at declare time").
- Modify: `kernel/vault.ts` — own the single `ViaGraph` instance; build+register edges when collections/registries are wired; call `graph.assertAcyclic()` at the point the registries call `validate()` today.
- Modify: `with-formula/derivations/registry.ts` — `validate()` delegates cycle detection to the graph (retire the local DFS; keep the SAME throw site/timing/error class). Add a metadata accessor for edge extraction (source/sources/triggerBy/rollup + outputs, per `registry.ts:23-72`).
- Modify: `with-formula/materialized-views/registry.ts` — `validate()` delegates MV cycle detection to the graph; expose dependency sets (`analyzeDependencies` result + `outputCollection`) for edge extraction.
- Modify: `kernel/collection-config.ts` — validate `computed` deps well-formedness (Task 7 adds the deps-bearing form; here: strings, non-empty, reference declared fields) and surface computed edge metadata.
- Test: `packages/hub/__tests__/via/graph-edges.test.ts`

**Interfaces — Consumes:** `ViaGraph` (Task 1). **Produces:** `vault.graph: ViaGraph` (per-vault, reachable by the pipeline builder for Task 3 and the dispatch wave for Task 4). Edge-extraction helpers on each registry, e.g. `DerivationRegistry.edges(): ReadonlyArray<{ target: FieldRef; sources: FieldRef[]; kind: EdgeKind; grain: Grain }>` and `MaterializedViewRegistry.edges(): ...`.

Edge sources (per §1):
- **via bindings' `deps`** — `ViaBinding.deps` goes from inert to validated. At `compileViaBindings` time, for any binding declaring `deps`, register a derived edge `target=(collection, coveredField)`, `sources=deps.map(f => (collection, f))`. Unknown source field ⇒ declare-time `ValidationError` ("deps references undeclared field"). (Today no shipped binding declares `deps`; the `computed` binding from Task 7 is the first — but wire the general path here.)
- **computed** — each `computed` entry with declared `deps` (Task 7 form) registers `registerDerived({c, field}, deps, 'computed', 'record')`. Plain depsless `computed` entries register the field node only (no in-edges → no taint) — UNLESS the collection also declares classified fields, in which case a depsless computed entry that could read a classified field is a declare-time `ValidationError` requiring explicit `deps` (closes the §6 opaque-function hole; the reproduced leak's `computed: { ssnLeak: r => r.ssn }` form is exactly this).
- **with-formula** — from the registries' edge metadata: derivations `registerDerived(output, [source...], 'derivation', 'record')`; rollups `registerDerived({into, field}, [{from, ...}], 'rollup', 'aggregate')`; MV `registerDerived(mvRowClass, deps, 'mv', <grain>)`; overlay `registerDerived(overlayOutput, [base], 'overlay', 'record')`. Cross-collection edges included (triggerBy, sources[], rollup from/into).

- [ ] Step 1 (RED): `graph-edges.test.ts` — register a derivation (`pdfs → pdf-meta`), a rollup (`items → orders.total`), an MV, and a `via(computed(fn, { deps: ['ssn'] }))` field; assert `vault.graph.dependentsOf('pdfs')` includes `pdf-meta`, `dependentsOf('items')` includes the `orders.total` aggregate edge, and effective posture of the ssn-derived field is sealed. Assert a rollup cycle still throws `DerivationCycleError` at vault open, an MV cycle `MaterializedViewCycleError` (re-run the existing cycle fixtures through the new path). Assert a `deps:['nope']` referencing an undeclared field throws `ValidationError`. Assert a depsless computed on a classified collection throws. RED.
- [ ] Step 2 (GREEN): thread the graph — `Vault` constructs `this.graph = new ViaGraph()`, registers field postures from each collection's compiled bindings (`binding.posture` + `covers`), registers edges from the registries + computed at the existing `validate()` call sites, and calls `graph.assertAcyclic()` there. Registries' `validate()` bodies delegate (move the DFS out). Keep `strategiesForSource`/`mvsForSource` UNTOUCHED (dispatch still uses them). Run the FULL derivations + MV suites → GREEN unchanged (cycle tests especially). New test GREEN.
- [ ] Step 3: `pnpm --filter @noy-db/hub typecheck && pnpm --filter @noy-db/hub lint`; `pnpm check:architecture` (via guards untouched). If any collection.ts/vault.ts lines were added, confirm net ceiling-neutral (edge extraction lives in the registries + graph; vault.ts gains the graph field + a build loop — shrink an equal count from a dense vault.ts decl or flag). Commit — `feat(hub): register derivation/MV/computed/deps edges into ViaGraph; delegate cycle detection (#638)`.

---

### Task 3: Taint propagation (#636) — effective posture feeds the phase-B consumers

**Files:**
- Modify: `kernel/via-pipeline.ts` — `postureFor` consults a per-collection tainted-posture overlay FIRST (the single assignment→enforcement bridge); add the taint at-rest sealing hook set.
- Modify: `kernel/collection-config.ts` / `kernel/vault.ts` — inject `graph.taintedPostures(name)` + `graph.taintSealedFields(name)` into each collection's `ViaPipeline` at build.
- Create: `packages/hub/src/kernel/via-taint-binding.ts` — a kernel-resident `taint` binding that seals `taintSealedFields` at rest via `ctx.sealedSlots` (reusing the phase-B capability) and presents them as sealed handles.
- Modify: `with-shape/introspection/describe.ts` — expose each derived field's effective posture + provenance (which source forced it).
- Test: `packages/hub/__tests__/via/taint.test.ts` (the reproduced-leak fixture becomes this regression test).

**Interfaces — Consumes:** `ViaGraph.taintedPostures`/`taintSealedFields`/`effectivePosture` (Task 1/2), `ViaCryptoCtx`/`SealedSlotRef` (`kernel/via.ts:47-57`), `EXPORT_REDACTION_MARKER` (`via-pipeline.ts:260`). **Produces:** `ViaPipeline.build(bindings, taint?)` extended signature; `postureFor` overlay-aware.

```ts
// kernel/via-pipeline.ts — additive, minimal
static build(
  bindings: readonly ViaBinding[],
  taint?: { readonly postures: ReadonlyMap<string, ViaPosture>; readonly sealFields: ReadonlySet<string> },
): ViaPipeline | undefined

postureFor(field: string): ViaPosture | undefined {
  const t = this.taint?.postures.get(field)     // NEW: overlay wins — the assignment bridge
  if (t) return t
  for (const b of this.bindings) if (b.covers?.(field)) return b.posture
  return undefined
}
```

Because `redactForExport` (`via-pipeline.ts:186-195`) and the query gate (`.where()`/`.orderBy()`/`.aggregate()` → `postureFor(field)?.queryable`) BOTH already route through `postureFor`, this one overlay change makes them enforce the tainted posture with **zero new query/export surface** (spec §2). The get()/list() plaintext leak on the SAME record is closed by the two grain-specific mechanisms:
- **materialized** tainted field with effective `encryptedAtRest:'sealed'` → the `taint` binding's `encodeAtRest` seals it into `_sealed` via `ctx.sealedSlots` (the exact phase-B path classified uses); read decodes it as a `SealedHandle` → `toJSON()` `'[sealed]'` (reuses classified present). This is "propagate", not "refuse" (decision 2) — the posture propagates all the way to actual sealing.
- **virtual** tainted field → never stored; its redaction-on-read is the computed binding's own `present` responsibility (Task 7), emitting `EXPORT_REDACTION_MARKER` when its `postureFor` is `exportable:false`.

`via-taint-binding.ts` (brand `'taint'`, `encodeAtRest`/`decodeAtRest` over `sealFields` only, `covers` = membership in the overlay, nominal `posture`; `postureFor` never uses this binding's `.posture` — the overlay short-circuits): body mirrors classified's sealed-slot loop but keyed on the graph-computed `sealFields` set instead of classified config.

- [ ] Step 1 (RED): `taint.test.ts` — port the seam-map §6 reproduction: a classified `ssn` field + `via(computed((r) => r.ssn, { deps: ['ssn'], mode: 'virtual' }))` → `ssnLeak`, and a materialized `via(computed((r) => String(r.ssn).slice(-4), { deps: ['ssn'], mode: 'materialized' }))` → `ssnLast4`. Assert after `put`: (a) `get()`/`list()` return `ssnLeak === '[sealed]'` (virtual redacted on read) and `ssnLast4 === '[sealed]'` (materialized sealed at rest, presented as handle); (b) the raw envelope's `_data` does NOT contain the plaintext of `ssnLast4` (sealed) — decrypt-and-inspect via `_getStoredRecord` shows a sealed slot, not inline plaintext; (c) `.where('ssnLeak', ...)` / `.aggregate({ x: sum('ssnLast4') })` throw `FieldNotQueryableError`; (d) export redacts both; (e) `describe()` reports `ssnLeak`/`ssnLast4` effectivePosture sealed with provenance `{ forcedBy: 'ssn' }`. RED.
- [ ] Step 2 (GREEN): implement the overlay in `postureFor`, the `taint` binding, the pipeline+describe injection, and the describe provenance. Run `taint.test.ts` → GREEN. Run the FULL classified + money + i18n + export + query-refusal suites → GREEN unchanged (no existing test combines computed+classified — seam map §6/§9 — so the new sealing behavior is pure new coverage). `pnpm --filter @noy-db/hub typecheck`.
- [ ] Step 3: ceilings — the pipeline/describe deltas are small; the sealing lives in the new `via-taint-binding.ts`. Confirm collection.ts unchanged; if collection-config.ts/vault.ts grew, shrink-first or flag. `grep -n accounting-firm` the diff. Commit — `fix(hub): propagate strictest source posture to derived fields — closes the computed→classified leak (#636, #638)`.

---

### Task 4: Sync dispatch (#621) — the origin-aware batched wave

**Files:**
- Create: `packages/hub/src/kernel/via-dispatch.ts` — the per-sync-session collector + the batched wave (decrypt → resolve targets via graph → dedup → recompute once).
- Modify: `kernel/collection.ts` — the `sync-apply`/`cutover`/`restore` cases of `_onRecordMutated` (lines 3834-3847) feed the collector; `dispatchDerivations`/`dispatchMaterializedViews`/`recomputeRollup` accept an optional `wave?` context (defaults `undefined` = today's byte-identical local-write path).
- Modify: `kernel/vault.ts` — own the open batch (`_graphBatch`), `_beginGraphBatch()`/`_flushGraphBatch()`, `_collectGraphTouch(collection, id)`; `_applyCutoverTransform` opens+flushes its own batch.
- Modify: `with-party/team/sync.ts` — `pull()`/`push()` begin a batch at entry and `await`-flush it at end (via a wired controller); `applyRemote` unchanged (still routes through `cacheInvalidator`).
- Modify: `kernel/noydb.ts` — wire the flush controller next to `setCacheInvalidator` (`noydb.ts:686`).
- Test: `packages/hub/__tests__/via/mutation-choke-point.test.ts` (the ONE pin-flip) + `packages/hub/__tests__/via/sync-dispatch.test.ts` (new).

**Interfaces — Consumes:** `ViaGraph.dependentsOf` (Task 1), `_invalidateCacheEntry`'s decrypt (`collection.ts:3761` — `codec.decryptRecord(envelope, { id, ... })`, threads id), `_getStoredRecord` (`collection.ts:2133`). **Produces:**

```ts
// kernel/via-dispatch.ts
/** Per-session touched set — collection → ids. Metadata only. */
export type GraphBatch = Map<string, Set<string>>

/** One dedup ledger for a single wave — a target is recomputed at most once. */
export class WaveContext {
  seen(targetKey: string): boolean   // true if already recomputed this wave (mark-on-check)
}

/** Run ONE dispatch wave for a completed batch: for each touched (collection,id),
 *  decrypt the applied envelope (threading id), then run the SAME dispatchDerivations
 *  + dispatchMaterializedViews the local-write path uses — but with a shared WaveContext
 *  so N pulled children → one recompute per affected target (per-target dedup). Origin-tagged:
 *  recompute writes go through the frozen-gated put (Task 5) with `{ source: 'derived' }`,
 *  which the runtime `_derivedFrom`/`_materializedFrom` sentinels already stop from re-triggering. */
export async function runGraphDispatchWave(vault: VaultLike, batch: GraphBatch): Promise<void>
```

Wiring (per §3):
- `_onRecordMutated` `sync-apply` (collection.ts:3834): keep `_invalidateCekCacheEntry(id)` + `await _invalidateCacheEntry(id)` (decrypt happens here, id threaded), THEN `this.graphDispatch?.collect(this.name, id)`. `cutover` (3839) + `restore` (3845): same `collect` call after the existing cache work. `graphDispatch` is a thin `{ collect(c,id): void }` threaded in `collOpts` (mirrors `derivationSource`, `vault.ts:1093`) → `vault._collectGraphTouch`, a no-op when no batch is open.
- The wave decrypts each touched record from the adapter (`envelope = adapter.get(...)`, `record = codec.decryptRecord(envelope, { id })`, `version = envelope._v`) — the phase-B Critical class: **id must reach every decryptRecord call** (it does, via the `{ id }` option). Classified/sealed collections apply ciphertext as-is under sync (sync.ts:634-637, phase-B at-rest hooks); the wave NEVER re-encrypts/re-writes the SOURCE record — only OUTPUT writes (different collections/records) flow.
- Money-only collections stay sync end-to-end (#553): the wave only runs for collections with graph out-edges; a money-only source has none, so no async is forced onto the sync stack.
- `recomputeRollup(spec, parentId, wave?)`: when `wave` present, `if (wave.seen('rollup\0'+into+'\0'+parentId+'\0'+field)) return` before recomputing — this is the N→1 dedup. MV union aggregates dedup identically on their row-class key.

- [ ] Step 1 (RED): FLIP the pin in `mutation-choke-point.test.ts:131-161` — the test now drives a real sync wave: after `v2._invalidateSyncApplied('pdfs','doc1')` inside a batch (open/flush), assert `changed2 === 1` and `calls() === beforeSyncApply + 1` (was `=== beforeSyncApply`); update the two `// parity-pin: #621 — phase C changes this` comments to record the flip. Add the MV-side assertion the file lacks (a materialized-view fixture whose sync-apply now dispatches). Add `sync-dispatch.test.ts`: pull N children of one rollup parent → assert exactly ONE parent recompute (dedup); cutover + restore origins also dispatch; the decrypted source is correct (id threaded). Run → RED (no wave yet).
- [ ] Step 2 (GREEN): implement `via-dispatch.ts`, the collector on `Vault`, the `pull()/push()` batch begin/flush, the `_applyCutoverTransform` batch, the noydb wiring, and the `wave?` threading. Run the flipped pin + new suite → GREEN. Run the FULL sync + derivations + MV suites → GREEN unchanged (local-write path untouched: `wave` undefined).
- [ ] Step 3: **ceiling — collection.ts is AT 4473.** The wave lives in `via-dispatch.ts`; collection.ts gains only the 3 `collect` calls + the `wave?` params. Shrink an equal number FIRST by collapsing the dense-style debt (lines 360-361, 405-411 multi-line field decls/comments) — do this shrink in THIS commit. Re-run `node -e` line count / rely on `pnpm check:architecture` to confirm collection.ts ≤ 4473. If it cannot net to ≤ 4473, STOP and flag a ratchet decision for user sign-off (BLOCKED, not bump). `pnpm --filter @noy-db/hub build && pnpm --filter @noy-db/hub bundle-check`. Commit — `fix(hub): dispatch derivations on sync-applied/cutover/restore writes via batched wave (#621, #638)`.

---

### Task 5: Frozen-output rule (#637) — skip + structured event, source write survives

**Files:**
- Modify: `kernel/via-dispatch.ts` — a `putDerivedOutput(...)` helper that all dispatch-driven output writes route through; it catches `PeriodClosedError` (the closed-period gate is the period consult), skips the write, and emits the event.
- Modify: `kernel/collection.ts` — the derivation output writes (`collection.ts:2409`, `2463`, `2480`) and `recomputeRollup`'s `intoColl.put` (`2244`) route through `putDerivedOutput`; `dispatchMaterializedViews`'s executor writes likewise.
- Modify: `kernel/vault.ts` — `deriveAll()` (`vault.ts:2986`/`2965`) + `refreshView()` (`refreshView` → executor) route their output writes through the same helper (per-record isolation replaces the current abort-on-first-throw).
- Test: `packages/hub/__tests__/derivations/frozen-output.test.ts`

**Interfaces — Consumes:** `PeriodClosedError` (`kernel/errors.ts`), the collection/vault `emitter` (`emitter.emit`), the with-audit ledger append seam (present only when with-audit active). **Produces:**

```ts
// kernel/via-dispatch.ts
export interface DerivationSkippedFrozen {
  readonly source: { readonly collection: string; readonly id: string }
  readonly target: { readonly collection: string; readonly id: string }
  readonly period: string          // PeriodClosedError.periodName
  readonly endDate: string
}

/** Attempt a dispatch-driven output write. On PeriodClosedError: SKIP (no _ts stamped —
 *  the beforePut gate throws before any write), emit 'derivation:skipped-frozen' on the
 *  event bus (ALWAYS), and append an audit-trail entry when with-audit is active. Returns
 *  'written' | 'skipped-frozen'. The SOURCE write is never wrapped — only outputs (§7). */
export async function putDerivedOutput(
  outColl: CollectionLike, id: string, value: unknown,
  ctx: { readonly emit: (ev: string, p: unknown) => void; readonly source: { collection: string; id: string }; readonly audit?: (e: DerivationSkippedFrozen) => Promise<void> },
): Promise<'written' | 'skipped-frozen'>
```

Design notes (per §4 + seam map Part 7): "frozen" for #637 = the output row falls in a **closed** period — the exact state that makes `assertTsWritable` (`periods.ts:442`) throw `PeriodClosedError` inside `_putInternal` stage 3. `freezePeriod`/`archivePeriod` add no NEW gate (Part 7 net finding), so catching `PeriodClosedError` from the gated `put()` IS the period consult and stamps no `_ts` (the gate is beforePut). Applies UNIFORMLY to live dispatch, `deriveAll()`, and `refreshView()` (today all three throw and — for deriveAll — abort the whole bulk op). `PeriodClosedError` semantics preserved: the SOURCE write proceeds — only the recompute OUTPUT write is wrapped.

- [ ] Step 1 (RED): `frozen-output.test.ts` — a rollup whose parent collection has a CLOSED period covering the parent; write a NEW, legal child (dated outside any closed period) that triggers a parent recompute. Assert: (a) the child write SUCCEEDS (source write survives — today it throws `PeriodClosedError`); (b) a `derivation:skipped-frozen` event fired with `source`/`target`/`period`/`endDate`; (c) the parent aggregate is UNCHANGED (recompute skipped, historical value stands); (d) with with-audit active, one audit entry recorded; (e) same three assertions for `deriveAll()` and `refreshView()` targeting a closed period (deriveAll no longer aborts — other records still process). RED.
- [ ] Step 2 (GREEN): implement `putDerivedOutput`, route the six output-write call sites + deriveAll/refreshView through it, wire the event + optional audit. Run RED → GREEN. Run the FULL periods + derivations + MV + deriveAll suites → GREEN unchanged (no existing test combines a closed period with a recompute target — seam map Part 7).
- [ ] Step 3: ceiling — call-site swaps are net-neutral (replace `outputCollection.put(...)` with `putDerivedOutput(...)`); confirm collection.ts ≤ 4473 and vault.ts ≤ 4088. `grep accounting-firm`. Commit — `fix(hub): skip derivation output writes into frozen periods instead of failing the source write (#637, #638)`.

---

### Task 6: Forget fanout (#622) — derived residue erased/recomputed

**Files:**
- Modify: `kernel/via-dispatch.ts` — a `forgetDerivedFanout(vault, ref)` helper: graph enumeration → record-grain erase, aggregate-grain recompute-in-open / skip+audit-in-frozen.
- Modify: `kernel/vault.ts` — `forget()`'s per-ref loop (`vault.ts:2444+`) calls the fanout after `_writeTombstone`; the `ForgetResult` gains additive fields.
- Modify: `with-audit/forget/strategy.ts` — `ForgetResult` additive extension (byte-shape of existing fields LOCKED).
- Test: `packages/hub/__tests__/via/forget-fanout.test.ts` (first-ever forget × derivation/MV coverage).

**Interfaces — Consumes:** `ViaGraph.derivedArtifactsOf` (Task 1), `recomputeRollup`/`dispatchArrayDerivationsOnDelete`/`dispatchMaterializedViewsOnDelete` (`collection.ts:2212`/`2846`/`2888` — the existing `!internal` housekeeping-bypass path, per §5), `putDerivedOutput` (Task 5, for the frozen-aggregate case), `_writeTombstone`/`_internalDelete`. **Produces:** additive `ForgetResult` fields:

```ts
// with-audit/forget/strategy.ts — APPEND to ForgetResult (existing fields byte-unchanged):
/** #622 — record-grain derived artifacts (MV rows, per-record derived copies, overlay
 *  outputs) erased because their source subject was forgotten. */
readonly derivedRecordsErased: number
/** #622 — aggregate-grain targets (rollups) recomputed without the forgotten contribution. */
readonly derivedAggregatesRecomputed: number
/** #622 — `collection:id` derived writes SKIPPED because the target period is frozen
 *  (recompute deferred; the aggregate retains the forgotten contribution — audited). */
readonly derivedResidueFrozen: readonly string[]
```

Design (per §5): after `_writeTombstone(ref.id, actor)` erases the subject record, `forgetDerivedFanout` asks `graph.derivedArtifactsOf(ref.collection)` for consumers, then per artifact:
- **record-grain** (MV rows keyed by the record, per-record derived copies, overlay outputs) → ERASE (route through `_internalDelete`/tombstone — the `!internal` bypass so no user `onDelete` re-fires, preserving the §5/Part-10 "shred is not a domain delete" property the original `_writeTombstone` decision protected).
- **aggregate-grain** (rollups) → RECOMPUTE without the forgotten contribution in OPEN periods (reuse `recomputeRollup` — the child is already tombstoned, so re-aggregation excludes it); in a FROZEN (closed) period → skip + audit via `putDerivedOutput` (aggregates hold no personal data — the copy dying matters, the historical aggregate staying is acceptable and audited).
- Results join the forget report ADDITIVELY (existing field byte-shape locked; new fields appended).

The array-shape fanout sidecar cleanup (`dispatchArrayDerivationsOnDelete`, `collection.ts:2846`) — currently reached only from the ordinary delete path — must run for the forgotten source too (§5 item 4).

- [ ] Step 1 (RED): `forget-fanout.test.ts` — three fixtures (NONE exist today, seam map §9): (a) forget × rollup — a forgotten child's contribution is recomputed out of the parent aggregate (parent value drops), report `derivedAggregatesRecomputed === 1`; (b) forget × MV row — an MV row keyed by the forgotten subject is erased (`get` → null), `derivedRecordsErased >= 1`; (c) forget × frozen aggregate — the parent is in a closed period → recompute skipped, `derivedResidueFrozen` lists it, audit entry present, subject record still fully shredded. Assert the existing `ForgetResult` fields are byte-unchanged (snapshot the pre-existing keys). RED.
- [ ] Step 2 (GREEN): implement `forgetDerivedFanout`, wire it into `forget()`'s loop, extend `ForgetResult`. Run RED → GREEN. Run the FULL forget/erasure + tiers suites → GREEN unchanged; erasure reports for non-derived subjects byte-identical (additive fields default to `0`/`[]`).
- [ ] Step 3: ceiling — fanout lives in `via-dispatch.ts`; vault.ts gains a thin call + 3 result-field assignments. vault.ts is AT 4088 — shrink an equal count FIRST (a dense vault.ts decl) or flag BLOCKED. `grep accounting-firm`. Commit — `fix(hub): forget() fans out to derived residue — recompute aggregates, erase record-grain copies (#622, #638)`.

---

### Task 7: `computed(virtual)` — the mode option + computed-as-via-feature

**Files:**
- Create: `packages/hub/src/shape/via-computed/descriptor.ts` — the `computed(fn, opts?)` descriptor factory (`_viaBrand: 'computed'`).
- Create: `packages/hub/src/shape/via-computed/binding.ts` — the computed via binding: `present` hook for virtual mode (+ taint redaction), `installViaBinder('computed', ...)`.
- Modify: `kernel/via-compose.ts` — `via()`/`mergeViaFields` accept the `'computed'` brand (today they THROW for any non-money/i18n brand — `via-compose.ts:106`).
- Modify: `kernel/collection-config.ts` — split computed entries by mode: materialized → `mergedComputed` (the existing stage-5 `evalComputedFields` path, byte-for-byte); virtual → the computed binding.
- Modify: `with-formula/computed/index.ts` — extend `ComputedFields` to carry the optional `{ deps?, mode? }` (the plain `Record<string, ComputedFn>` sugar keeps working).
- Test: `packages/hub/__tests__/computed/virtual.test.ts`

**Interfaces — Consumes:** `via()`/`ViaFieldSpec`/`mergeViaFields` (`kernel/via-compose.ts`), `ViaBinding.present`/`covers`/`posture` (`kernel/via.ts`), the taint overlay `postureFor` (Task 3), `installViaBinder` (`kernel/via.ts:141`). **Produces:**

```ts
// shape/via-computed/descriptor.ts
export interface ComputedDescriptor {
  readonly _viaBrand: 'computed'
  readonly fn: (record: Record<string, unknown>) => unknown
  readonly deps?: readonly string[]
  readonly mode: 'materialized' | 'virtual'      // default 'materialized'
}
export function computed(
  fn: (record: Record<string, unknown>) => unknown,
  opts?: { readonly deps?: readonly string[]; readonly mode?: 'materialized' | 'virtual' },
): ComputedDescriptor
```

Design (per §6 + decision 5):
- **materialized** (default): compiles to the EXISTING stage-5 write-time eager compute (`collection.ts:1771-1773` → `evalComputedFields`, `computed/index.ts:47-61`), stored — **byte-for-byte today's semantics** (the behavior lock pins it; existing computed suites must stay green). The descriptor's `fn` is merged into `mergedComputed` (`collection-config.ts:582-589`) exactly like a sugar `computed:` entry. Its `deps` feed the graph (Task 2) → taint applies (Task 3): a materialized computed reading a classified source becomes sealed-at-rest.
- **virtual**: rides the `present` phase (the money-`Formatted` / i18n-`Label` precedent, seam map Part 4) — computed on READ, NEVER stored, `queryable: 'none'` (posture), excluded from export unless sources permit (taint applies identically). The computed binding's `present(record, ctx)` sets `record[field] = fn(record)` for each virtual field, THEN — if `postureFor(field)?.exportable === false` (tainted from classified) — overwrites with `EXPORT_REDACTION_MARKER` (the read-redaction that closes the virtual leak, kept inside the feature).
- **Sugar preserved:** the plain `computed: { field: fn }` config key keeps working (materialized, no deps); `via(computed(fn, { deps, mode }))` is the composed form. `mergeViaFields` groups a `'computed'`-branded descriptor into a new `computedFields` output map (materialized → into `mergedComputed`; virtual → into the binding config).

- [ ] Step 1 (RED): `virtual.test.ts` — `via(computed((r) => (r.amount as number) * 2, { deps: ['amount'], mode: 'virtual' }))` → `doubled`. Assert: (a) `get()`/`list()` return `doubled`; (b) the raw envelope (`_getStoredRecord`) does NOT contain `doubled` (never stored); (c) `.where('doubled', ...)` throws `FieldNotQueryableError` (queryable 'none'); (d) a money-only collection with a virtual computed field stays a SYNC stack (#553) — no async forced; (e) `via(computed(fn, { mode: 'materialized' }))` stores byte-identically to the plain `computed:` sugar form (parity assertion). Also assert `via(computed(...))` no longer throws in `mergeViaFields`. RED (via-compose throws + no binding).
- [ ] Step 2 (GREEN): implement the descriptor, the binding + `installViaBinder('computed', ...)`, the via-compose brand acceptance, and the collection-config mode split. Run RED → GREEN. Run the FULL computed suites (529 LOC / 4 files) → GREEN unchanged (materialized path byte-for-byte). `pnpm --filter @noy-db/hub typecheck`.
- [ ] Step 3: `pnpm check:architecture` (new `shape/via-computed/**` must not import `kernel/enclave/**` — via-enclave-isolation stays EMPTY and must not need an entry; the binding reaches crypto only via `ctx`, and virtual never seals). `pnpm --filter @noy-db/hub build && bundle-check` (computed binding stays out of the floor bundle for collections without it). `grep accounting-firm`. Commit — `feat(hub): computed(virtual) read-time mode + computed as a via-feature (#638)`.

---

### Task 8: Guards, ceilings, docs, changeset

**Files:** `scripts/check-architecture.mjs` (ceiling comment history only — no bumps), `docs/subsystems/via.md` + `docs/subsystems/formula.md` (or the relevant subsystem page), `.changeset/<name>.md`, `SERVICES.md` (line if the service surface changed).

- [ ] Step 1: Verify guards — `VIA_ENCLAVE_ALLOWLIST` still `new Map([])` and fires on a synthetic `shape/via-*/** → kernel/enclave` import; `VIA_SHAPE_ALLOWLIST` still exactly `[join.ts → '../../shape/via-i18n/core.js']`; `grep -rn "kernel/enclave" packages/hub/src/shape` → only what phase B already allowed (nothing new). New kernel files import no `src/shape/**`.
- [ ] Step 2: Ceilings — confirm `collection.ts ≤ 4473`, `vault.ts ≤ 4088`, `noydb.ts ≤ 2385` via `pnpm check:architecture`. If any task legitimately net-shrank a guarded file, re-ratchet the ceiling DOWN to the new actual with a `#638` comment (a lower ceiling is always allowed; a HIGHER one is the BLOCKED case that never reached here).
- [ ] Step 3: Full gauntlet — `pnpm --filter @noy-db/hub test` (whole hub suite green, incl. the one flipped pin), `pnpm --filter @noy-db/hub typecheck` (×3 tsconfigs), `pnpm --filter @noy-db/hub lint`, `pnpm check:architecture`, `pnpm --filter @noy-db/hub build && bundle-check`, `pnpm knip`.
- [ ] Step 4: Docs — from **SHIPPED TESTS ONLY** (the phase-A/B lesson is binding: read the real green tests, document only what they prove). Cover: the dependency graph + taint algebra, `computed(virtual)`, the `derivation:skipped-frozen` event, the forget-fanout report fields, and the #621 sync-dispatch behavior. NO speculative API.
- [ ] Step 5: Changeset — `.changeset/<name>.md`, `@noy-db/hub: minor` (additive api surface: `computed` `mode`/`deps`, dispatch/audit events, `ForgetResult` fields, `via(computed(...))`). **Explicitly note the #636 posture-propagation BEHAVIOR CHANGE**: any existing `computed`-from-classified config now inherits the classified posture (sealed/non-export/non-query) — deliberate security fix, pre-1.0 `@next`. Do NOT publish. `grep -rn accounting-firm` the whole diff. Commit — `docs(hub): via phase C — graph/taint/dispatch/forget/computed(virtual) + changeset (#638)`.

---

## Final steps (execution skill handles)

Full hub suite green; whole-branch review on the most capable model (mutation-test focus: the taint algebra `foldPosture` table, the `postureFor` overlay bridge, the wave per-target dedup, the frozen-output skip vs source-write survival, the forget aggregate-recompute-vs-erase split; verify zero-knowledge — grep the new graph/dispatch/computed code for keyring/DEK/CEK access, confirm the graph stores no values). PR against `main` (do NOT merge — human gate). Fixes #621/#622/#636/#637; closes milestone #28's phase-C scope.
