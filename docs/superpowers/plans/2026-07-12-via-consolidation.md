# Via consolidation pass — formula-output taint, the key-resolution class, sync-delete freshness (#642, #651, #640, #654)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the four remaining Via structural defects on milestone #30 in ONE coherent pass: (#642) with-formula OUTPUTS bypass classified taint — go DEEP with collection-level output postures; (#651 + #654) the ONE key-resolution class — a canonical descriptor-keyed core ending the PUT-id-vs-`row[descriptor.key]` drift and the dm12 coercion split, plus the #654 fail-closed policy; (#640) sync-applied deletes never reach the rollup recompute wave — three coherent layers. Ride the near-free items #644 (items 1+3) and #646 (fixture mandate) that live in the same diffs.

**Issues:** [#642](https://github.com/vLannaAi/noy-db/issues/642) (security), [#651](https://github.com/vLannaAi/noy-db/issues/651) + [#654](https://github.com/vLannaAi/noy-db/issues/654) (key-resolution class), [#640](https://github.com/vLannaAi/noy-db/issues/640) (freshness) · **Milestone:** #30 "Via follow-ups [api]" · **Base:** `main 5f290e57` (v0.3.0-pre.9 published), working branch `fix/via-consolidation-m30` HEAD `c57879ac`.

**Surface:** `api` — additive (collection-level output postures, batch delete-kind, key-resolution core). Behavior change on #642 per the user-ratified call (no consumers use formula outputs yet → no migration story). `@noy-db/hub/adapter` and `@noy-db/hub/cargo` are **byte-untouched**.

**Tech Stack:** TypeScript, `@noy-db/hub` (tsup + vitest), turbo monorepo. Run from repo root: `pnpm vitest run <path>`; one package: `pnpm --filter @noy-db/hub <script>`; architecture guard: `node scripts/check-architecture.mjs`.

## REQUIRED READING (every task)

- **Spec (user-ratified):** `docs/superpowers/specs/2026-07-12-via-consolidation-design.md`
- **Seam map (GROUND TRUTH — AUTHORITATIVE over the spec where they conflict; conflicts flagged inline below):** `.superpowers/sdd/seam-map-consolidation.md` — Part-N references point into it. Line numbers were located at `main 5f290e57`; re-locate by symbol if drifted at `c57879ac`.
- **Format precedent (executed successfully):** `docs/superpowers/plans/2026-07-12-via-phase-d.md`.
- Current-code touchpoints (exact signatures verified at `c57879ac`): `kernel/via-graph.ts` (`_contribution`/`_declaredPosture`/`_computeEffective`/`_effectiveCache`/`foldPosture`/`taintedPostures`/`referencingEdgesOf`), `kernel/via-graph-wiring.ts` (`applyTaintOverlay`/two-phase `validateReconcileGraphEdges`/`commitReconcileGraphEdges`), `kernel/via-taint-binding.ts` (`buildTaintOverlay`/`taintBinding`), `kernel/via-pipeline.ts` (`postureFor`/`redactForExport`/`ViaTaintOverlay`), `kernel/via-dispatch.ts` (`GraphBatch`/`runGraphDispatchWave`/`putDerivedOutput`/`applyLookupRefsFanout`/`forgetDerivedFanout`), `with-party/team/sync.ts` (`pull`/`push` loops, `applyRemote`, `cacheInvalidator` seam), `kernel/vault.ts` (`_invalidateSyncApplied` ~1286, `getLookupBacking` closure :1134, `_collectGraphTouch`/`_flushGraphBatch`), `with-shape/links/vault-facade.ts` (`checkLookupRefsRestrict` :319, `applyLookupRefsPropagation` :342, `resolveLookupCompareKey` :286, `findLookupReferencingRecords` :267), `shape/via-lookup/registry.ts` (`buildLookupSnapshotRows`/`buildLookupAltIndex`/`checkLookupMembership`/`materializeBackingTable`), `shape/via-lookup/binding.ts` (`fetchLookupLabel` :84), `port/with/lookup-strategy.ts`, `kernel/collection.ts` (`dispatchRollupsOnDelete` :2255, `recomputeRollup` :2211, `_onRecordMutated` sync-apply :3833, `_peekCached` :3852, `_getStoredRecordForDispatch` :2164), `scripts/check-architecture.mjs` (ceilings + both via allowlists).

## SEAM-MAP-vs-SPEC CONFLICTS (resolved here; re-flag if execution reveals more)

1. **The fold operator (spec §1 vs seam-map finding 9).** The seam map frames the `'*'` fold through `foldPosture`, which folds ALL FOUR axes — the "naive fold over-restricts wildly" trap. The spec resolves the open design question: fold the **security axes ONLY** (`encryptedAtRest` sealed-wins, `exportable` AND, `forgettable` OR); do NOT fold `queryable`. **Resolution:** introduce a NEW `foldWildcardSecurity` helper — NOT `foldPosture` — that leaves `queryable` at `DEFAULT_POSTURE`'s `'full'`; the sealed→`'none'` clamp is left to `buildTaintOverlay`'s existing phase-C honest clamp. Verified at `c57879ac` (`grep -n posture` on every binding): money `{envelope,ordered,exp:T,forg:T}`, blob `{envelope,none,exp:T,forg:T}`, i18n `{envelope,full,exp:T,forg:T}`, classified `{sealed,det-exact,exp:F,forg:T}`, lookup `{envelope,full,exp:T,forg:F}` — so a security-axis fold makes ONLY a classified source seal/non-export an output; money/blob/i18n contribute at most `forgettable:true`. The blast radius the seam map feared (blob→unqueryable) is structurally avoided BECAUSE `queryable` is unfolded. This is the "blob-field-must-not-unqueryable-outputs pin".

2. **`'*'` contribution is kind-scoped by the CONSUMING edge (seam-map surprise 7 + finding 7).** `effectivePosture`/`_computeEffective` are kind-blind today; a `'*'` source folded unconditionally would seal every `lookup()` referencing field whose dimension holds a classified/blob/money column, breaking #650's DOCUMENTED reliance (`registry.ts:392-397`: "`DEFAULT_POSTURE` is the fold's identity element, so adding the wildcard alongside a real field source changes nothing"). **Resolution:** the `'*'` fold applies ONLY when the consuming edge kind ∈ `{derivation, rollup, mv, overlay}`; for `kind === 'ref'` the `'*'` source KEEPS identity (`DEFAULT_POSTURE`). Kind is threaded into `_contribution` from `_computeEffective`. Precedent: `dependentsOf` already excludes `'ref'` (`via-graph.ts:307-309`). This is the "ref-identity pin".

3. **"Collection-level default posture … carried in collection config" (spec §1) vs the enforcement wall (seam-map findings 8 + 10).** The output collection's default posture is NOT user config — it is GRAPH-derived (the `'*'` target edge's folded effective posture) and cannot land through `taintSealedFields`/`postureFor`/`taintBinding`/`redactForExport`, which all key by REAL field names (a `'*'` key matches nothing). **Resolution (ground truth wins):** carry the default posture in the `ViaTaintOverlay` (a new `defaultPosture?` field), extracted by `applyTaintOverlay` from the graph's `'*'` target entry, and add a whole-record-floor interpretation to `postureFor` (fallback for ANY field) + `redactForExport` (already walks all fields → falls back automatically) + a whole-record SEAL mode on `taintBinding`. "carried in collection config" is loose spec phrasing.

4. **#654's "three silent-skip sites" (seam-map surprise 3 / Part 2d).** The e1cbce3e residue fix already covered the FORGET-path twin (`applyLookupRefsFanout`, `via-dispatch.ts:284-286` — residue-reports today). The TWO REMAINING silent sites are both in `vault-facade.ts`: `checkLookupRefsRestrict:323` (`onDelete !== 'restrict' || compareKey === undefined → continue`) and `applyLookupRefsPropagation:349` (bare `if (compareKey === undefined) continue`). **Resolution:** the restrict site becomes fail-closed REFUSE; the propagation site residue-reports (its return shape gains `residue`). The via-dispatch twin is already correct — do NOT double-fix it.

5. **The kernel spine MAY import `port/with/*` freely (seam-map surprise 4).** `checkPortLayering` sanctions spine→`port/with/` (`check-architecture.mjs:1491-1492`). The pure key-resolution core (Task 3) lives in `shape/via-lookup/registry.ts`, re-exported through `port/with/lookup-strategy.ts`; `vault.ts` / `vault-facade.ts` / `via-dispatch.ts` all consume it via that seam. The `VaultLinks`/with-shape I/O SHELLS stay put (they use different collection accessors + residue plumbing — the T5 duplication is only PARTIALLY forced); only the pure core is shared. `via-dispatch.ts` MUST NOT gain a with-* import.

## Global Constraints (copied from spec + arc conventions)

- **Behavior locks:** the FULL derivations / MV / rollup, lookup (all tiers + aliases), sync, forget/erasure, and classified suites pass **UNCHANGED** except the enumerated defect-pin flips. Per the seam map (finding 10) the four repros DO NOT EXIST today — they are NEW pins, so the flip set is near-empty. **Defect-pin flips ENUMERATED PER FILE:** verified at `c57879ac`:
  - `__tests__/via/taint.test.ts:168-199` (KNOWN-LIMIT: a `computed` field naming a real-but-wrong dep) — **DOES NOT FLIP.** It uses a `computed:{…}` field (EdgeKind `'computed'`), which is NOT a folded formula kind (Task 1 folds only `derivation|rollup|mv|overlay`). Its `ssnLeak` still folds from the declared (wrong) `amount` dep. Leave byte-unchanged; add a one-line comment cross-referencing #642's kind-scoping so a future reader knows why it survived.
  - `__tests__/via/mutation-choke-point.test.ts:85-99` (LOCAL delete does NOT dispatch derivations) — **DOES NOT FLIP.** #640 routes SYNC-applied deletes to the rollup-on-delete trio, never `dispatchDerivations`; local-delete-vs-derivation is orthogonal. Preserve it exactly; it is the guard that the #640 wave doesn't over-dispatch.
  - No other existing test pins #642/#651/#640/#654 defect behavior (seam map §5 gaps confirmed: no formula-OUTPUT posture test; no direct-read matrix dressing with `key!=='id'`; no restrict-with-unresolvable-key test; no pulled-delete-recomputes-parent test). The four repros are ADDED as the new pins.
- **Zero-knowledge non-negotiable:** collection-level output posture is METADATA (a posture, no keys/values); at-rest sealing rides the EXISTING `ctx.sealedSlots` path (`taintBinding` — byte-for-byte the classified capability, no new crypto path). The key-resolution core (Task 3) is a PURE function — it takes a descriptor + a row and returns a coerced string; NO crypto, NO `Collection`/keyring/DEK/enclave handle. `GraphBatch` holds ids (collection names, record ids incl. resolved rollup PARENT ids) + field names ONLY — never record payload or key material. Grep every new `shape/via-lookup/**` and every guarded-file diff for `keyring`/`DEK`/`CEK`/`enclave` reach-arounds and confirm none.
- **Ceilings — ALL THREE at +1 slack, verified at `c57879ac`** (`wc -l` vs `scripts/check-architecture.mjs`):
  - `kernel/collection.ts` — actual **4472**, ceiling **4473** (`:728`), slack **+1**.
  - `kernel/vault.ts` — actual **3939**, ceiling **3940** (`:959`), slack **+1**.
  - `kernel/noydb.ts` — actual **2384**, ceiling **2385** (`:1067`), slack **+1**.
  New logic lands in UNGUARDED files (`via-graph.ts`, `via-taint-binding.ts`, `via-pipeline.ts`, `via-graph-wiring.ts`, `via-dispatch.ts`, `registry.ts`, `vault-facade.ts`, `errors.ts`, `sync.ts`). Guarded-file touches are thin and in-place (net-zero where possible). **A ceiling bump is BLOCKED — it requires explicit user sign-off, never a silent bump. Shrink-first if a guarded file must grow.** Report actual `wc -l` on every guarded file a task touches. The primary ceiling pressure is `collection.ts` in Task 5 (#640) — see that task's ceiling note.
- **Guards stay EMPTY + fire:** `VIA_SHAPE_ALLOWLIST` (`:1890`) and `VIA_ENCLAVE_ALLOWLIST` (`:1941`) both stay `new Map([])`. Do NOT add entries. `node scripts/check-architecture.mjs` must pass; the guards must still FIRE on a synthetic `kernel/** → shape/**` (resp. `shape/via-*/** → kernel/enclave`) import.
- **#553 discipline:** the `'*'` fold is LAZY (computed in `_contribution`, memoized in `_effectiveCache` which already clears on every `registerField`/`registerDerived`) and SYNC. QUERY-participation hooks (`buildClause`/`evaluateClause`/`compareForOrder`/`postureFor`/`resolveOrderLabel`) stay SYNC — no store read, no async in a query hook. `postureFor` is a HOT PATH: the collection-default fallback must be **O(1) per call — no fold-per-call**; cache the folded `defaultPosture` on the overlay (computed ONCE in `applyTaintOverlay`, read by reference in `postureFor`).
- **id-thread any decrypt:** every new `decryptRecord`/`_decodeEnvelope`/`_getStoredRecordForDispatch` path threads the record `id` (the phase-B at-rest contract).
- **The #644 / #646 riders land in the diffs they touch** (Task 5): #644 item 1 (stale-open `_graphBatch` cleared on push/pull throw) + item 3 (structured `derivation:wave-error` event upgrading the `console.warn`); #646's fixture mandate (db2-only registration) rides the new two-instance delete test. #644 item 2 (reentrancy) stays DEFERRED.
- **Never add Claude attribution** to commits/PRs/CHANGELOGs. **Grep every diff for `accounting-firm` before every commit** (`git diff | grep -n accounting-firm` → empty). Write the two-character escape `\0` in any code, never a raw NUL byte.

---

### Task 1: The kind- & axis-scoped `'*'` fold (#642 half 1 — the graph algebra)

**Rationale:** `_declaredPosture('*')` returns `DEFAULT_POSTURE` today (`'*'` nodes are never `registerField`ed), so a derivation/rollup/MV over an all-classified collection still folds to max-permissive — the #636 sibling leak at the graph layer. This task makes a `'*'` LEAF node's contribution a lazy, kind-scoped, security-axis fold of its collection's registered field postures. Pure graph algebra, unit-testable in isolation; enforcement is Task 2. UNGUARDED file only (`via-graph.ts`).

**Files:**
- Modify: `kernel/via-graph.ts` —
  - Add `foldWildcardSecurity(base, contributor)` (module function, exported for unit test): folds `encryptedAtRest` (sealed-wins), `exportable` (AND), `forgettable` (OR) ONLY — leaves `queryable` at `base.queryable`. Distinct from `foldPosture` (which folds all four axes); do NOT reuse `foldPosture` here.
  - Add a memoized private `_wildcardContribution(collection): ViaPosture` — folds every `_posture` entry whose node id is `${collection}${SEP}<field>` (any field EXCEPT the wildcard `'*'` itself) via `foldWildcardSecurity`, seeded at `DEFAULT_POSTURE`. Memoize in a new `_wildcardCache = new Map<string, ViaPosture>()`, cleared alongside `_effectiveCache` in `registerField`/`registerDerived` (add `this._wildcardCache.clear()` to the two existing `this._effectiveCache.clear()` sites).
  - Thread the consuming edge kind into `_contribution`: `_computeEffective` calls `this._contribution(nodeId(source), edge.kind)`; `_contribution(id, kind?)` — when the node is a LEAF (no in-edge) AND its field is `'*'` (`id.endsWith(`${SEP}*`)`) AND `kind` is a folded formula kind (`derivation|rollup|mv|overlay`), return `_wildcardContribution(collection)`; otherwise the current `_declaredPosture(id)`. `taintProvenance`'s `this._contribution(nodeId(source))` call keeps `kind` undefined (identity for `'*'` — provenance names only real declared sources, unchanged).
  - Promote the `'*'` literal to a `WHOLE_RECORD` const already partially duplicated (`with-formula/derivations/registry.ts:17`, `materialized-views/registry.ts:15`, and the `referencingEdgesOf` wildcard convention `:322-324`) — OPTIONAL cleanup; if promoted, keep the hand-duplication comment in `via-graph.ts:22-25`'s sibling style. Skip if it risks the ceiling on any consumer.

**Interfaces — Produces (Task 2 binds to these):**

```ts
// kernel/via-graph.ts
/** Security-axes-only fold for a wildcard collection node (#642): sealed-wins encryptedAtRest,
 *  AND exportable, OR forgettable — queryable is NOT folded (stays base.queryable; the sealed
 *  clamp to 'none' is buildTaintOverlay's job, so inheriting `sealed` never over-restricts a
 *  blob-adjacent output to unqueryable). Pure; exported for unit testing. */
export function foldWildcardSecurity(base: ViaPosture, contributor: ViaPosture): ViaPosture

// the folded formula kinds a '*' source contributes its collection-fold to (ref keeps identity):
type FoldedKind = 'derivation' | 'rollup' | 'mv' | 'overlay'
```

**Interfaces — Consumes:** `ViaPosture` (`via.ts`), `DEFAULT_POSTURE`/`EdgeKind`/`FieldRef` (this file).

**Design notes:**
- The fold is over the SOURCE collection's REGISTERED field postures only — a plain (unregistered) field contributes nothing (the identity), so the fold is strictly more conservative than deps-based taint and never hits the KNOWN-LIMIT wall (it names no fields; seam map §1d). Registration ordering is free: `_effectiveCache`/`_wildcardCache` clear on every `registerField`, so a later-registered classified field re-folds on next `effectivePosture` (seam map finding 3/10 — the GRAPH-level invalidation; the PIPELINE-level re-apply is Task 2).
- Kind-scoping is the ONE thing that keeps the countries recipe intact (conflict 2): a `ref` edge's `{backing,'*'}` source stays `DEFAULT_POSTURE`, so a `lookup('countries')` field referencing a matrix with a classified column does NOT seal.

- [ ] Step 1 (RED): `packages/hub/__tests__/via/wildcard-fold.test.ts` (new) — pure `ViaGraph` unit tests (no createNoydb):
  - `foldWildcardSecurity` folds security axes only: `foldWildcardSecurity(DEFAULT, {sealed,det-exact,exp:F,forg:T})` → `{encryptedAtRest:'sealed', queryable:'full', exportable:false, forgettable:true}` (queryable UNCHANGED at base `'full'`).
  - Build a graph: `g.registerField('src','ssn',{sealed,det-exact,exp:F,forg:T})`; `g.registerField('src','plain',DEFAULT)`; `g.registerDerived({collection:'out',field:'*'}, [{collection:'src',field:'*'}], 'derivation','record')`. Assert `g.effectivePosture({collection:'out',field:'*'})` → `{encryptedAtRest:'sealed', queryable:'full', exportable:false, forgettable:true}`.
  - **blob-field-must-not-unqueryable-outputs pin:** `g.registerField('src2','doc',{envelope,none,exp:T,forg:T})` (blob) + a derivation `'*'` edge from `src2`. Assert the output `'*'` posture's `queryable === 'full'` (NOT `'none'`) — blob does not clamp queryability of derived outputs; only `forgettable` ORs to `true`.
  - **ref-identity pin:** register a `'ref'` edge `{collection:'orders',field:'country'} ← [{collection:'countries',field:'*'}]` with `g.registerField('countries','iso2',{sealed,…})` present. Assert `g.effectivePosture({collection:'orders',field:'country'})` stays `DEFAULT_POSTURE` (identity — the `'*'` fold does NOT apply to `'ref'` kind). Also assert a rollup edge `{collection:'parent',field:'total'} ← [{collection:'src',field:'*'}]` DOES fold sealed (real-field target inherits).
  - Ordering-free assertion: register the classified `src` field AFTER the derivation edge; assert the fold still seals (cache cleared on the late `registerField`). RED (helper + kind-scoping absent).
- [ ] Step 2 (GREEN): implement `foldWildcardSecurity`, `_wildcardContribution` + `_wildcardCache`, the kind-threaded `_contribution`. Run RED → GREEN. Run the FULL via graph/taint/lookup-ref suites unchanged — `pnpm vitest run packages/hub/__tests__/via/graph.test.ts packages/hub/__tests__/via/graph-edges.test.ts packages/hub/__tests__/via/taint.test.ts packages/hub/__tests__/via/lookup-ref-semantics.test.ts packages/hub/__tests__/via/countries-matrix.test.ts` → GREEN (the ref-identity guarantee keeps lookup-ref/countries byte-identical; the taint KNOWN-LIMIT survives — `computed` isn't a folded kind).
- [ ] Step 3: `node scripts/check-architecture.mjs` (via-graph.ts is metadata-only + unguarded — no ceiling touch; confirm no new value/key storage). `pnpm --filter @noy-db/hub typecheck && pnpm --filter @noy-db/hub lint`. `git diff | grep -n accounting-firm` (empty). Commit — `feat(hub): kind- & axis-scoped '*' posture fold in ViaGraph — formula outputs inherit source taint (#642)`.

---

### Task 2: Enforcement — both target shapes (#642 half 2 — rollup auto + collection-default output posture)

**Rationale:** Task 1 makes the graph FOLD; this task makes it ENFORCE across the three surfaces (query refusal, export redaction, at-rest sealing) for BOTH target shapes: rollup targets (REAL fields — automatic via the existing Task-C3 overlay) and derivation/MV/overlay OUTPUTS (`'*'` targets — need the collection-level default posture, seam map finding 8). Closes the cross-collection re-apply gap (finding 10). All UNGUARDED files, except a possible one-line vault.ts re-apply call (net-zero target; shrink-first/BLOCK if not).

**Files:**
- Modify: `kernel/via-pipeline.ts` — `ViaTaintOverlay` gains `readonly defaultPosture?: ViaPosture` (the whole-record floor). `postureFor(field)`: taint field-specific (`this.taint?.postures.get(field)`) → binding `covers` → **`this.taint?.defaultPosture`** fallback (O(1) read — no fold). `redactForExport` already walks every own field via `postureFor` → picks up the default automatically (no change to its body — verify).
- Modify: `kernel/via-taint-binding.ts` — `taintBinding(sealFields, presentRedactFields, sealAllFields = false)`: when `sealAllFields`, `encodeAtRest` seals EVERY own field carrying a defined value EXCEPT reserved/internal keys (skip keys starting with `_`, e.g. `_derivedFrom`), `decodeAtRest` restores every key present in the record's `sealed` map, `covers` returns `true` for any non-`_` field. The `sealAll` seal loop mirrors `encodeTaintAtRest` but iterates `Object.keys(record)` instead of a fixed list. `buildTaintOverlay` is unchanged for field-specific entries; the `'*'` entry is handled in `applyTaintOverlay` (below), not here.
- Modify: `kernel/via-graph-wiring.ts` —
  - `applyTaintOverlay(coll, graph, name)`: read `graph.taintedPostures(name)`, split off the `'*'` entry (`raw.get('*')`) as the collection default; build the field-specific overlay from the remaining entries exactly as today. Compute `defaultPosture` = the `'*'` posture after the same sealed→`queryable:'none'` clamp `buildTaintOverlay` applies (reuse that clamp). When `defaultPosture?.encryptedAtRest === 'sealed'`, append `taintBinding(sealFields, virtualExportRedact, /*sealAllFields*/ true)`; thread `defaultPosture` into the `ViaTaintOverlay`. A collection with neither field taint nor a `'*'` default stays `this.via === undefined` (the #553 no-op-when-empty contract holds — only add the default branch when `raw.get('*')` is non-default).
  - Add `reapplyDependentOverlays(graph, name, getOpenCollection)` — after a SOURCE collection registers its fields, re-apply `applyTaintOverlay` for every OPEN output collection that depends on `name` (the cross-collection re-apply gap, finding 10). Uses `graph.dependentsOf(name)` (which already excludes `'ref'`) → the distinct target collections → for each currently-open one, re-run `applyTaintOverlay`. Pure wiring; no new graph state (reuses the graph-memory the lazy fold already invalidates).
- Modify: `kernel/vault.ts` — at the existing construction region (`:1172-1174`, right after `registerCollectionGraphSources` + `registerLookupRefEdges` + `applyTaintOverlay`) add ONE call `reapplyDependentOverlays(this.graph, collectionName, (n) => this._getCollection(n))` so opening a classified SOURCE after its derivation OUTPUT refreshes the output's stale overlay. **Net-zero target:** this is one added line — if `wc -l vault.ts` exceeds **3940**, shrink-first (collapse an adjacent dense declaration) or STOP and flag **BLOCKED** (never bump). Report the count.
- Modify: `kernel/via-graph.ts` — no change if `taintedPostures` already surfaces the `'*'` target (it iterates every `_in` edge for the collection, so the derivation/mv/overlay `'*'` target IS included). Verify; if a filter excludes `'*'`, remove it.

**Interfaces — Produces:**

```ts
// kernel/via-pipeline.ts
export interface ViaTaintOverlay {
  readonly postures: ReadonlyMap<string, ViaPosture>
  readonly sealFields: ReadonlySet<string>
  readonly provenance?: ReadonlyMap<string, readonly string[]>
  /** #642 — the whole-record floor for a derivation/MV/overlay OUTPUT collection (the '*' target's
   *  folded, clamped effective posture). postureFor falls back to it for ANY field; redactForExport
   *  picks it up per-field; a sealed default drives taintBinding's sealAllFields mode. O(1) read. */
  readonly defaultPosture?: ViaPosture
}

// kernel/via-taint-binding.ts
export function taintBinding(
  sealFields: ReadonlySet<string>,
  presentRedactFields?: ReadonlySet<string>,
  sealAllFields?: boolean,   // #642 — whole-record seal for a '*'-defaulted output collection
): ViaBinding

// kernel/via-graph-wiring.ts
export function reapplyDependentOverlays(
  graph: ViaGraph, name: string,
  getOpenCollection: (n: string) => unknown /* Collection | undefined */,
): void
```

**Interfaces — Consumes:** `ViaGraph.taintedPostures`/`dependentsOf` (`via-graph.ts`), `buildTaintOverlay`/`taintBinding` (`via-taint-binding.ts`), `ViaPipeline.build` (`via-pipeline.ts`), `ctx.sealedSlots` (the existing at-rest capability).

**Design notes:**
- **Rollups are automatic** — verify, don't build: the rollup edge's target is `{spec.source, rollup.field}` (a REAL field, `derivations/registry.ts:158`). Once Task 1 makes `{rollup.from,'*'}` fold sealed, `taintSealedFields(parentColl)` includes `rollup.field` and `applyTaintOverlay` seals/gates it with zero new consumer code. The only new work is the apply-ordering (the `reapplyDependentOverlays` hook) when the parent collection was opened before the child's classified field registered.
- **Derivation/MV/overlay outputs** land the fold under the literal `'*'` key in `taintedPostures(outputColl)` → the `defaultPosture` interpretation is the whole-record floor. Sealed-inherited outputs: `postureFor(anyField)`→sealed→query refused; `redactForExport`→`exportable:false`→`[sealed]`; `taintBinding(sealAllFields)`→every field sealed at rest via `ctx.sealedSlots`.
- **postureFor is HOT** — `defaultPosture` is precomputed once in `applyTaintOverlay` and read by reference; NEVER fold per `postureFor` call.
- **Reconcile re-apply respects at-most-once graph registration (D-2 wave-2 law):** `reapplyDependentOverlays` only re-runs `applyTaintOverlay` (a pipeline rebuild), it NEVER re-registers a graph edge — `registerDerived`'s at-most-once contract is untouched. The two-phase `commitReconcileGraphEdges` path already calls `applyTaintOverlay` for the reconciled collection; the new hook extends the SAME refresh to open DEPENDENTS.

- [ ] Step 1 (RED): `packages/hub/__tests__/via/formula-output-posture.test.ts` (new) — the #642 repro, both shapes × three surfaces, using `withClassified()` + a `classifiedFields` source and `derivationStrategies`/rollup. Structure per the countries-matrix inline-memory harness + `mutation-choke-point.test.ts`'s `makeDerivation()` pattern.
  - **Shape A — derivation OUTPUT collection (`'*'` target):** source `people` with `classifiedFields:{ ssn }`; a derivation copying `ssn` into an output collection `leaks`. Assert: (query) `leaks.query().where('ssnCopy','==', <x>)` refuses / matches nothing per the honest clamp; (export) the output record redacts to `[sealed]` through `exportStream`/`redactForExport`; (at-rest) reading the raw stored envelope shows the field in `_sealed`, and `leaks.get(id)` returns a `SealedHandle` for it.
  - **Shape B — rollup TARGET (real field):** children with a classified `amount`-adjacent field feeding a rollup `total` on a parent; assert the parent's `total` field seals/redacts/refuses identically.
  - **Ordering repro:** open the OUTPUT collection BEFORE the classified SOURCE; put a source row; assert the output STILL seals (the `reapplyDependentOverlays` hook fired). RED.
- [ ] Step 2 (GREEN): implement `defaultPosture` in `ViaTaintOverlay` + `postureFor`, `taintBinding` `sealAllFields`, `applyTaintOverlay`'s `'*'` split + default clamp + whole-record-seal binding, `reapplyDependentOverlays`, the vault.ts hook. Run RED → GREEN. Run the FULL behavior-lock suites — `pnpm vitest run packages/hub/__tests__/via packages/hub/__tests__/derivations packages/hub/__tests__/materialized-views packages/hub/__tests__/classified` → GREEN UNCHANGED (the taint KNOWN-LIMIT survives; `export-posture-b`/`query-posture-b` unchanged; countries/lookup-ref unchanged via ref-identity).
- [ ] Step 3: **ceilings** — `wc -l packages/hub/src/kernel/vault.ts` ≤ **3940** (report it; shrink-first or BLOCK if over). `node scripts/check-architecture.mjs` (guards EMPTY + fire; via-taint-binding/via-pipeline/via-graph-wiring unguarded). `pnpm --filter @noy-db/hub typecheck && lint`. `pnpm --filter @noy-db/hub build && pnpm --filter @noy-db/hub bundle-check` (taint machinery stays out of the floor for taint-free collections). `git diff | grep -n accounting-firm` (empty). Commit — `feat(hub): enforce folded '*' posture on formula outputs — rollup targets + collection-level default posture, three surfaces (#642)`.

---

### Task 3: The ONE key-resolution core (#651) — descriptor-keyed resolution + guarded coercion, six consumers converge

**Rationale:** A matrix lookup with `key !== 'id'` stores `row[descriptor.key]`; any resolution by the backing row's PUT-id is wrong when the two differ. `getLookupBacking`'s closure (`vault.ts:1134`) does a PUT-id `.get(key)` — the #651 direct-read leak. Five sites are already descriptor-keyed but split across a bare-`String()` vs guarded-coercion dialect (dm12). This task extracts ONE canonical core, converges all six consumers, and reshapes `getLookupBacking` to gain the descriptor. All UNGUARDED except the vault.ts:1134 closure REPLACED in place (net-zero, the Task-7 `snapshotFor` precedent).

**Files:**
- Modify: `shape/via-lookup/registry.ts` — add the pure core:
  - `coerceLookupKey(raw): string | undefined` — the ONE guarded coercion (`typeof raw === 'string' || typeof raw === 'number' ? String(raw) : undefined`). Kills the bare-`String()` `"undefined"`/`"null"` poisoning.
  - `resolveBackingRowKey(descriptor, row): string | undefined` — `coerceLookupKey(row[descriptor.key])` (the backing row's canonical key VALUE).
  - `matchesReferencingValue(rec, field, compareKey): boolean` — `coerceLookupKey(rec[field]) === compareKey` (the referencing-side match predicate; `compareKey` already coerced).
  - Converge `buildLookupSnapshotRows` matrix branch (`:482`) and `buildLookupAltIndex` matrix branch (`:369`) onto `resolveBackingRowKey` — SKIP rows whose key coerces to `undefined` (closes the poisoned-`"undefined"` vocabulary key, seam map surprise 6). `materializeBackingTable`'s row-keying and altKey loop keep their own coercion but route the value guard through `coerceLookupKey`.
- Modify: `port/with/lookup-strategy.ts` — re-export `coerceLookupKey`, `resolveBackingRowKey`, `matchesReferencingValue` (the seam every kernel-spine consumer imports; port/with is the sanctioned door — conflict 5).
- Modify: `kernel/vault.ts` — REPLACE the `:1134` `getLookupBacking` closure IN PLACE (net-zero) so it gains the descriptor and routes through the descriptor-keyed snapshot with a cold-session `key==='id'` fallback to the live `.get()`:
  ```ts
  collOpts.getLookupBacking = (desc: LookupDescriptor) => async (key: string) => {
    const rows = buildLookupSnapshotRows(desc, (n) => this.reservedLookupCollections.has(dictCollectionName(n)), (n) => this.dictionary(n), (n) => this.collection<Record<string, unknown>>(n))
    const hit = rows?.get(key)
    if (hit) return hit
    // cold-session fallback preserved ONLY for the id-keyed tier (construct+hydrate on demand);
    // for key !== 'id' the snapshot is the single source of key truth (#651).
    return desc.key === 'id' ? (await this.collection<Record<string, unknown>>(desc.dimension).get(key)) ?? undefined : undefined
  }
  ```
- Modify: `shape/via-lookup/binding.ts` — `fetchLookupLabel`'s matrix branch (`:91-101`) calls `cfg.getLookupBacking?.(desc)` (passing the whole descriptor, not `desc.dimension`); update the `LookupViaConfig.getLookupBacking` type to `(descriptor: LookupDescriptor) => (key: string) => Promise<Record<string, unknown> | undefined>`.
- Modify: `with-shape/links/vault-facade.ts` — `resolveLookupCompareKey` (`:296`) and `findLookupReferencingRecords` (`:273`) use `coerceLookupKey` / `matchesReferencingValue` via the port re-export.
- Modify: `kernel/via-dispatch.ts` — `applyLookupRefsFanout`'s inline twin match (`:290` `String(rec[referencing.field])`) uses `matchesReferencingValue` via the port re-export (NOT a with-* import — port/with only).
- Modify: `docs/subsystems/via-lookup.md` — RETIRE the #651 direct-read caveat (`:129-135` "currently resolve the backing row by the backing collection's own PUT-id … tracked as #651 … use the join path"); NARROW the cold-session caveat (`:113`) to note the hybrid preserves cold-session construct+hydrate ONLY for `key === 'id'`.

**Interfaces — Produces:**

```ts
// shape/via-lookup/registry.ts (re-exported via port/with/lookup-strategy.ts)
export function coerceLookupKey(raw: unknown): string | undefined
export function resolveBackingRowKey(descriptor: LookupDescriptor, row: Record<string, unknown>): string | undefined
export function matchesReferencingValue(rec: Record<string, unknown>, field: string, compareKey: string): boolean
```

**Interfaces — Consumes:** `LookupDescriptor` (`shape/via-lookup/descriptor.ts`), `buildLookupSnapshotRows` (`registry.ts`), `dictCollectionName` (`handle.ts`).

**Design notes:**
- **The six consumers (seam map §2a):** (1) `buildLookupSnapshotRows`, (2) `buildLookupAltIndex`, (3) `checkLookupMembership` (already delegates to #2), (4) `resolveLookupCompareKey`, (5) the `applyLookupRefsFanout` inline twin + `findLookupReferencingRecords`, (6) `getLookupBacking` — now descriptor-gaining. All route the coercion through `coerceLookupKey`; dm12 dies.
- **Cold-session caveat narrows, not vanishes** (seam map surprise 5): the snapshot route sees an empty cache until the dimension collection is opened/populated. The hybrid keeps the old construct+hydrate virtue ONLY for `key === 'id'` (where PUT-id == key by construction). For `key !== 'id'` the snapshot is the sole truth — populate the dimension first (already the documented matrix contract).
- **Zero-knowledge:** the core is pure (descriptor + row → string). No `Collection`/keyring/DEK.

- [ ] Step 1 (RED): `packages/hub/__tests__/via/lookup-direct-read-key.test.ts` (new) — the #651 repro (direct-read, NON-join dressing, `key !== 'id'`), reusing the countries-matrix inline harness:
  - Declare `orders` with `country: lookup('countries', { key:'iso2', altKeys:['iso3'], present:{label:'name', by:'locale'}, backing:'collection' })`; populate `countries` with a row whose PUT-id (`'row-US'`) DIFFERS from `iso2` (`'US'`) and `name:{en:'United States', th:'สหรัฐอเมริกา'}`; `orders.put('o1',{country:'US'})`.
  - **Repro flip:** `await orders.get('o1', { locale:'en' })` → `countryLabel === 'United States'` (was silently omitted pre-fix because `.get('US')` missed `row-US`). Assert at `th` too.
  - **Poisoned-key pin:** a `countries` row MISSING `iso2` does NOT enter the snapshot/altIndex as `"undefined"` — `orders.query().where('country','==','undefined')` matches nothing and membership rejects `'undefined'`.
  - Unit: `coerceLookupKey(5)==='5'`, `coerceLookupKey(null)===undefined`, `coerceLookupKey(undefined)===undefined`; `resolveBackingRowKey({key:'iso2',…}, {iso2:'US'})==='US'`. RED (closure PUT-id keyed; core absent).
- [ ] Step 2 (GREEN): implement the core + port re-exports, converge the six consumers, reshape `getLookupBacking` in place, update `fetchLookupLabel` + the `LookupViaConfig.getLookupBacking` type. Run RED → GREEN. Run the FULL lookup suites UNCHANGED — `pnpm vitest run packages/hub/__tests__/via/lookup-binding.test.ts packages/hub/__tests__/via/lookup-join-snapshot.test.ts packages/hub/__tests__/via/lookup-altkeys.test.ts packages/hub/__tests__/via/lookup-vocabulary.test.ts packages/hub/__tests__/via/lookup-alias-parity.test.ts packages/hub/__tests__/via/countries-matrix.test.ts packages/hub/__tests__/via/lookup-forget-ref.test.ts` → GREEN (the join path already used the descriptor-keyed snapshot, so alias/join parity is untouched; only the direct-read path newly works).
- [ ] Step 3: **ceilings** — `wc -l packages/hub/src/kernel/vault.ts` == **3939** (the `:1134` replacement is in-place; if it grew, collapse to a one-liner or shrink-first). `node scripts/check-architecture.mjs` (via-dispatch.ts gained NO with-* import — only the port re-export; VIA_SHAPE_ALLOWLIST stays EMPTY + fires). `pnpm --filter @noy-db/hub typecheck && lint`. `git diff | grep -n accounting-firm` (empty). Commit — `fix(hub): one descriptor-keyed lookup resolution core + guarded coercion; matrix direct-read dressing for key!=='id' (fixes #651)`.

---

### Task 4: #654 policy — restrict REFUSE (fail-closed) + propagation residue, both remaining vault-facade sites

**Rationale:** A `restrict` edge whose live compare-key resolve fails (matrix custom-key row unreadable — corruption class) is SILENTLY skipped today (`checkLookupRefsRestrict:323`), inverting restrict's promise; the ordinary-delete propagation path (`applyLookupRefsPropagation:349`) bare-`continue`s with no residue channel (seam map surprise 3). Controller-ruled, T5-consistent policy: restrict fails CLOSED (refuse); propagation residue-reports. The forget-path twin (`applyLookupRefsFanout`) already residue-reports — do NOT touch it. All UNGUARDED files.

**Files:**
- Modify: `kernel/errors.ts` — add `RestrictRefUnresolvableError extends NoydbError` (`code: 'RESTRICT_REF_UNRESOLVABLE'`, carries `{dimension, key, referencing: string /* "collection.field" */}`) — a `DictKeyInUseError`-adjacent refusal that names the unresolvable edge; "cannot prove no references ⇒ do not delete".
- Modify: `with-shape/links/vault-facade.ts` —
  - `checkLookupRefsRestrict` (`:319-331`): split the combined `onDelete !== 'restrict' || compareKey === undefined → continue`. For a `restrict` edge whose `compareKey === undefined`, THROW `RestrictRefUnresolvableError(dimension, key, `${referencing.collection}.${referencing.field}`)` (fail-closed) instead of skipping. Non-restrict edges still `continue` (their propagation is Task-2's/the fanout's concern). A resolvable restrict edge behaves exactly as today.
  - `applyLookupRefsPropagation` (`:342-365`): return shape gains `residue: string[]`; the bare `if (compareKey === undefined) continue` (`:349`) instead pushes `${backingCollection}:${key}:${referencing.collection}.${referencing.field}` to `residue` (mirrors the fanout channel's `backing:key:collection.field` format). Update `enforceLookupRefsOnDelete` (`:373-376`) to thread the residue out.
  - Surface the ordinary-delete propagation residue: `enforceLookupRefsOnDelete`'s residue is emitted as a structured `lookup:propagation-residue` event (`{vault, dimension, key, residue}`) at the ordinary-delete caller (`enforceRefsOnDelete`/`enforceLookupRefsOnDelete` region) so it is never silent (the delete return is `void` today — an event is the additive channel, matching the seam-map "additive on the delete result path mirroring the forget residue channel").
- Modify: `docs/subsystems/via-lookup.md` — document the fail-closed restrict policy on an unresolvable compare-key + the propagation residue event.

**Interfaces — Produces:**

```ts
// kernel/errors.ts
export class RestrictRefUnresolvableError extends NoydbError {
  constructor(readonly dimension: string, readonly key: string, readonly referencing: string)
  // code 'RESTRICT_REF_UNRESOLVABLE'
}
// with-shape/links/vault-facade.ts
applyLookupRefsPropagation(graph, backingCollection, key): Promise<{ cascaded: number; nullified: number; residue: string[] }>
enforceLookupRefsOnDelete(graph, dimension, backingCollection, key): Promise<{ cascaded: number; nullified: number; residue: string[] }>
```

**Interfaces — Consumes:** `graph.referencingEdgesOf` (`via-graph.ts`), `resolveLookupCompareKey`/`findLookupReferencingRecords` (Task 3-converged), `NoydbError` (`errors.ts`), the vault event emitter.

**Design notes:**
- The restrict REFUSE is safe precisely because the unresolvable-key case is corruption-class rarity (a matrix row missing/holding a non-string `descriptor.key`); the T5 precedent already says "restrict refuses before any shred". The forget path's restrict check runs BEFORE any shred (`checkLookupRefsRestrict` is `Vault.forget()`'s pre-shred pass) — a throw there aborts the forget cleanly, no partial shred.
- Do NOT add a fourth site: `applyLookupRefsFanout` (`via-dispatch.ts:284-286`) already residue-reports; leave it byte-identical.

- [ ] Step 1 (RED): `packages/hub/__tests__/via/lookup-restrict-unresolvable.test.ts` (new) — matrix `lookup('countries',{ key:'iso2', onDelete:'restrict' })` referenced by `orders`; corrupt the backing row so `iso2` is absent/non-string (unresolvable compare-key). Assert:
  - **restrict direction:** deleting/forgetting the corrupt backing row REFUSES with `RestrictRefUnresolvableError` naming `orders.country` (fail-closed — the referencer survives). A RESOLVABLE restrict edge still throws the existing `DictKeyInUseError` when a referencer exists, and still SUCCEEDS when none does (no regression).
  - **propagation direction:** the SAME dimension declared `onDelete:'cascade'` (or `'nullify'`) with an unresolvable compare-key — the ordinary `collection.delete()` proceeds but emits `lookup:propagation-residue` with the un-propagated edge (never silent); a resolvable cascade/nullify still propagates + counts. RED.
- [ ] Step 2 (GREEN): implement the error, the two vault-facade site changes, the residue event. Run RED → GREEN. Run the FULL ref/forget suites — `pnpm vitest run packages/hub/__tests__/via/lookup-ref-semantics.test.ts packages/hub/__tests__/via/lookup-forget-ref.test.ts packages/hub/__tests__/via/forget-fanout.test.ts` → GREEN UNCHANGED (resolvable edges are byte-identical; the fanout twin is untouched; `ForgetResult` byte-shape locked).
- [ ] Step 3: `node scripts/check-architecture.mjs`. `pnpm --filter @noy-db/hub typecheck && lint`. `git diff | grep -n accounting-firm` (empty). Commit — `fix(hub): restrict-edge unresolvable compare-key fails closed; ordinary-delete propagation residue-reports (fixes #654)`.

---

### Task 5: #640 — sync-applied deletes reach the rollup wave (three coherent layers) + #644/#646 riders

**Rationale:** A pulled tombstone/delete-marker never recomputes its rollup parent — three layers are double-guarded against the naive fix (seam map surprise 1): the `cacheInvalidator` seam drops the action kind (`sync.ts:65-70` is `(collection, id)`), `GraphBatch` carries no kind (`via-dispatch.ts:20`), and the wave independently drops tombstones/markers (`_getStoredRecordForDispatch → null → continue`). All three change coherently, mirroring the LOCAL delete path's `dispatchRollupsOnDelete` trio (NOT `dispatchDerivations` — the `mutation-choke-point.test.ts:85-99` pin). This is the pass's PRIMARY ceiling pressure on `collection.ts` (+1 slack) — see the ceiling note.

**Files:**
- Modify: `with-party/team/sync.ts` (UNGUARDED) —
  - `cacheInvalidator` signature widens to `(collection, id, action: 'put' | 'delete')` (`setCacheInvalidator` too). `applyRemote` classifies at the ONE choke point (it holds the envelope): `const action = isTombstoneShape(envelope) || isDeleteMarker(envelope) ? 'delete' : 'put'`; `await this.cacheInvalidator?.(collection, id, action)`. (`isTombstoneShape`/`isDeleteMarker` already imported at `:22`.)
  - **#644 item 1 rider:** ensure the open `_graphBatch` is cleared on a `pull()`/`push()` throw — wrap the batch-spanning region so `await this.graphBatchController?.flush()` runs in a `finally` (flush clears the batch unconditionally, `vault.ts:1316-1320`). Today `flush()` sits AFTER the try/catch (`:334`/`:534`), so a throw from `ensureLoaded()`/`persistMeta()` leaves a stale batch open for the next call. A `finally`-guarded flush closes it.
- Modify: `kernel/collection.ts` (**GUARDED — 4472/4473**) — keep touches thin; net-neutral via extract-to-reuse:
  - Extract `_rollupDeleteIntents(deleted: T): RollupDeleteIntent[]` FROM `dispatchRollupsOnDelete`'s resolution loop (`:2260-2265`) — sync, no I/O; reads the rollup registry, extracts `parentId = String(rec[spec.rollup.key])`, yields `{into: spec.source, parentId, field: spec.rollup.field}`. `dispatchRollupsOnDelete` now = `_rollupDeleteIntents` + a recompute per intent (REUSES the loop, no duplication → near line-neutral).
  - `dispatchRollupsOnDelete(id, deleted, wave?)` gains the optional `wave` param, threaded to `recomputeRollup` (per-target dedup for the wave path).
  - `_onRecordMutated` sync-apply case (`:3833-3837`): accept the `action`; for `action==='delete'`, `const prior = this._peekCached(id)` BEFORE `_invalidateCacheEntry(id)` runs; if `prior`, `this.graphDispatch?.collectDelete(this.name, id, this._rollupDeleteIntents(prior))`; then invalidate. For `action==='put'`, the existing `collect` path.
  - Widen the `graphDispatch` interface (`:571-572`) to add `collectDelete(collection, id, intents)`.
  - Add `_recomputeDeletedRollups(intents: readonly RollupDeleteIntent[], wave: WaveContext): Promise<void>` — the wave-facing driver: for each intent, dedup via `wave.seen('rollup\0${into}\0${parentId}\0${field}')`, find the matching spec in `derivationSource.registry().strategiesForSource(this.name)` (by `source===into && rollup.field===field && rollup.from===this.name`), and `recomputeRollup(spec, parentId, {collection:this.name, id:'<sync-delete>'}, wave)`.
- Modify: `kernel/via-dispatch.ts` (UNGUARDED — bulk of new logic) —
  - `GraphBatch` becomes `Map<string, GraphTouch>` where `GraphTouch = { puts: Set<string>; deletes: Map<string, RollupDeleteIntent[]> }`; `RollupDeleteIntent = { into: string; parentId: string; field: string }`. **Update the `:19` metadata-only pin comment HONESTLY:** "Metadata only — ids (collection names, record ids INCLUDING resolved rollup parent ids) and field names; NEVER record payload or key material. A resolved parentId is an id, same class as the touched ids — not a stored value."
  - `runGraphDispatchWave`: for each collection's `touch.puts` run the existing `dispatchDerivations` + `dispatchMaterializedViews` (per-id, id-threaded decrypt, unchanged); THEN for `touch.deletes` call `coll._recomputeDeletedRollups(intents, wave)` per deleted id — INSIDE the same per-id try/catch isolation.
  - **#644 item 3 rider:** `VaultLike` gains `emit(event: string, payload: unknown): void`; the wave's catch block emits a structured `derivation:wave-error` (`{collection, id, error}`) ADDITIVELY alongside the existing `console.warn` (upgrade, not replace — no listener-dependent silence).
- Modify: `kernel/vault.ts` (**GUARDED — 3939/3940**, net-zero target) —
  - `_invalidateSyncApplied(collection, id, action: 'put'|'delete')` — pass `action` to `coll._onRecordMutated(id, action, 'sync-apply')` (the `:1289` line changes `'put'` → `action`; signature gains a param — net-zero). Reserved-lookup branch (`:1292-1295`) ignores `action` (wave-inert, unchanged).
  - `_collectGraphTouch`/`_beginGraphBatch`/`_flushGraphBatch` adapt to the `GraphTouch` shape: `_collectGraphTouch(collection, id)` seeds/updates `touch.puts`; add `_collectGraphDelete(collection, id, intents)` for the delete socket (`collectDelete`). Keep these thin.
  - `VaultLike.emit` — Vault already owns an emitter; expose it to the wave (a one-line `emit` delegator or pass `this.emitter.emit`). Net-zero target.
- Modify: `kernel/noydb.ts` (**GUARDED — 2384/2385**, net-zero) — `:686` `engine.setCacheInvalidator((collection, id, action) => comp._invalidateSyncApplied(collection, id, action))` (in-place widening — net-zero).

**Interfaces — Produces:**

```ts
// kernel/via-dispatch.ts
export interface RollupDeleteIntent { readonly into: string; readonly parentId: string; readonly field: string }
export interface GraphTouch { readonly puts: Set<string>; readonly deletes: Map<string, RollupDeleteIntent[]> }
export type GraphBatch = Map<string, GraphTouch>
export interface VaultLike {
  readonly graph: ViaGraph
  _getCollection(name: string): Collection<Record<string, unknown>> | undefined
  emit(event: string, payload: unknown): void   // #644 item 3 — structured wave-error surfacing
}
// kernel/collection.ts
_rollupDeleteIntents(deleted: T): RollupDeleteIntent[]                                        // sync resolution
dispatchRollupsOnDelete(id: string, deleted: T, wave?: WaveContext): Promise<ReadonlyArray<…>>  // + wave param
_recomputeDeletedRollups(intents: readonly RollupDeleteIntent[], wave: WaveContext): Promise<void>
// with-party/team/sync.ts
setCacheInvalidator(fn: (collection: string, id: string, action: 'put' | 'delete') => Promise<void>): void
```

**Interfaces — Consumes:** `isTombstoneShape`/`isDeleteMarker` (`kernel/enclave`, already imported in sync.ts), `_peekCached`/`recomputeRollup`/`dispatchRollupsOnDelete` (`collection.ts`), `WaveContext` (`via-dispatch.ts`).

**Design notes:**
- **FK recovery — the pinned mechanism (seam map surprise 2):** the deleted child's FK is recoverable ONLY at apply time — `applyRemote` overwrites the store before invalidating, so at wave time the child is gone. The FK survives in the not-yet-invalidated collection cache: `_peekCached(id)` at the START of the sync-apply delete case (BEFORE `_invalidateCacheEntry`) returns the PRIOR record. We resolve the rollup parent INTENTS there (sync, `_rollupDeleteIntents`) and batch `{into, parentId, field}` — ids + names only (metadata; the parentId is a resolved id, NOT the raw stored record). The residual hole (a lazy-mode child evicted from the LRU pre-apply) is out of scope — `_peekCached` returns null and the recompute is skipped (freshness-only, no correctness break in the eager path the tests cover). Note this residual in the doc.
- **apply-before-wave ordering (the D-4 rule generalizes):** deletes are applied (via `local.put` in `applyRemote`) BEFORE `_flushGraphBatch`, so at wave time the store already EXCLUDES the deleted child — `recomputeRollup`'s "gather the REMAINING children" is correct by construction. The wave must NOT recompute at collect time (that would see an intermediate store state mid-pull). The intent-resolution at collect time is SYNC + I/O-free precisely so it doesn't observe the store.
- **The metadata-only GraphBatch pin (kind IS metadata):** update the `:19` comment honestly (above). A `kind`/`GraphTouch.deletes` partition and a resolved parentId are ids/names — not payload or keys.
- **Scope guards:** sync delete ≠ forget — NO shred, NO residue channel (freshness only; the origin device already ran `forgetDerivedFanout`). Reserved-tier `_dict_*` markers (D-4) already flow via their own registry loop + `_refreshSyncCache` and are wave-inert (`'ref'` edges excluded from `dependentsOf`; `_getCollection('_dict_x')` is undefined) — **#640 needs NO reserved-branch work** (seam map 3f). The `mutation-choke-point.test.ts:85-99` pin (local-delete does NOT dispatch derivations) is preserved: sync-applied deletes route to `_recomputeDeletedRollups` (rollup-on-delete), NEVER `dispatchDerivations`.

**Ceiling note (BLOCKING discipline):** `collection.ts` is at 4472/4473 (+1) — the tightest. The `_rollupDeleteIntents` extraction is near line-neutral (the loop MOVES from `dispatchRollupsOnDelete`, no duplication); `_recomputeDeletedRollups`, the `graphDispatch` interface widening, and the `_onRecordMutated` delete branch ADD lines. `vault.ts` (3939/3940) also grows: `_invalidateSyncApplied` + the `:1289` line are net-zero in-place, but the `GraphTouch` adaptation of `_collectGraphTouch`/`_flushGraphBatch` + the new `_collectGraphDelete` + the `emit` delegator ADD lines. `noydb.ts` (2384/2385) is net-zero in-place (the `:686` widening). Run `wc -l` on all three after each edit. If any exceeds its budget: SHRINK-FIRST (collapse a dense adjacent declaration — an over-long multi-line signature, a foldable guard) to reclaim room; if it still cannot fit, STOP and flag **BLOCKED — a ceiling bump requires explicit user sign-off**, never a silent bump. Prefer pushing logic into UNGUARDED `via-dispatch.ts` over the guarded spine wherever the seam allows.

- [ ] Step 1 (RED): `packages/hub/__tests__/via/sync-delete-rollup.test.ts` (new) — the #640 repro, two-instance, count-asserted, with **#646's db2-only registration**:
  - Two `createNoydb` instances (db1 writer, db2 puller) over a shared remote memory store. On db1: `orders` (children) with a rollup into `customers.orderCount` (parent); seed 3 orders for customer `c1`; `db1.sync()` (push).
  - **db2 registers the rollup ONLY on db2** (the #646 mandate — the derivation/rollup strategy is declared on the PULLING side, proving the wave fires on the receiver regardless of origin registration). `db2.pull()` → `customers.orderCount === 3`.
  - **The repro:** on db1 delete one order (a delete-marker) + push; `db2.pull()` → assert `customers.get('c1').orderCount === 2` (the pulled delete recomputed the parent). Assert a COUNT: exactly one parent recompute write for the pull (via the value-equality guard / a write spy), proving wave dedup when 2 children are deleted in one pull (`orderCount` goes 3→1, ONE recompute).
  - **Ordering pin:** a delete of one child + a `put` of a sibling order in the SAME pull → the parent count reflects the FINAL store state (both applied before the wave).
  - **Freshness-not-forget pin:** the pulled delete does NOT write a tombstone/residue on db2's side beyond the marker itself (no shred).
  - **#644 item 3 pin:** register a `derivation:wave-error` listener; force a recompute error (e.g. a frozen-period output is NOT this — use a genuine throw) and assert the structured event fires (additive to console.warn). RED (action dropped; batch has no kind; wave skips deletes).
- [ ] Step 2 (GREEN): implement the three layers + riders. Run RED → GREEN. Run the FULL sync/wave/derivation locks — `pnpm vitest run packages/hub/__tests__/via/sync-dispatch.test.ts packages/hub/__tests__/via/mutation-choke-point.test.ts packages/hub/__tests__/derivations/rollup.test.ts packages/hub/__tests__/via/lookup-reserved-sync.test.ts packages/hub/__tests__/via/forget-fanout.test.ts` → GREEN UNCHANGED (local-delete-not-dispatch pin preserved; reserved markers stay wave-inert; forget accounting not duplicated on the receiver). Strengthen the #646 fixtures in `sync-dispatch.test.ts` if the two vacuous socket-reachability pins are touched (db2-only registration).
- [ ] Step 3: **ceilings** — report `wc -l` for `collection.ts` (≤4473), `vault.ts` (≤3940), `noydb.ts` (≤2385); shrink-first or BLOCK per the ceiling note. `node scripts/check-architecture.mjs` (via-dispatch.ts gained NO with-* import; GraphBatch still metadata-only — grep for value/key storage → none; guards EMPTY + fire). `pnpm --filter @noy-db/hub typecheck && lint`. `pnpm --filter @noy-db/hub build && pnpm --filter @noy-db/hub bundle-check`. `git diff | grep -n accounting-firm` (empty). Commit — `fix(hub): sync-applied deletes recompute rollup parents via the dispatch wave; stale-batch clear + structured wave-error (fixes #640, #644 items 1+3, #646)`.

---

### Task 6: Docs + changeset + final gauntlet + milestone ledger

**Files:**
- Modify: `docs/subsystems/via-lookup.md` — the #651 caveat retirement + cold-session narrowing (Task 3) and the #654 fail-closed restrict + propagation-residue policy (Task 4), from SHIPPED TESTS ONLY.
- Create/modify: a `docs/subsystems/` note (or the derivations/taint subsystem page) — the #642 formula-output posture behavior: ALL formula outputs derived from classified-bearing collections are sealed/non-exportable/query-refused by default (rollup real-field targets + derivation/MV/overlay collection-level default posture); axis-scoped (a blob/money/i18n source does NOT clamp queryability, only ORs `forgettable`); explicit per-declaration declassification is phase-E, NOT built here. SHIPPED-TESTS-ONLY.
- Create: `.changeset/via-consolidation.md` — `@noy-db/hub: minor`.
- Modify: `scripts/check-architecture.mjs` — ONLY if a guarded file NET-SHRANK: re-ratchet its ceiling DOWN to the new actual (comment `#642/#651/#640/#654 consolidation`). NO bumps. If nothing shrank, leave the three ceilings untouched.

**Interfaces:** none (docs/changeset).

**Design notes:**
- **Changeset — minor** (additive API: collection-level output postures, batch delete-kind, the descriptor-keyed resolution core; per the #636-principle completion framing #642 is behavior-affecting → minor, matching prior via changesets). Body enumerates, per issue: #642 (formula-output taint — the security-correct default, no migration story since no consumers use formula outputs pre-1.0; axis-scoped so no unintended blob/money over-restriction; declassification deferred to phase E); #651 (one descriptor-keyed resolution core, matrix direct-read dressing for `key!=='id'`, cold-session caveat narrowed); #654 (restrict fails closed on an unresolvable compare-key; ordinary-delete propagation residue-reports); #640 (sync-applied deletes recompute rollup parents; #644 items 1+3 riders). DO NOT publish.

- [ ] Step 1: Docs from SHIPPED (green) TESTS ONLY — no speculative API. Cross-link the retired #651 caveat and the new #642/#654 behaviors to their pinning tests.
- [ ] Step 2: Full gauntlet — `pnpm --filter @noy-db/hub test` (whole hub suite green), `pnpm --filter @noy-db/hub typecheck` (all tsconfigs), `pnpm --filter @noy-db/hub lint`, `node scripts/check-architecture.mjs` (VIA_SHAPE_ALLOWLIST + VIA_ENCLAVE_ALLOWLIST both EMPTY and both FIRE on a synthetic import; ceilings at or below budget — none bumped; a bump anywhere ⇒ BLOCKED), `pnpm --filter @noy-db/hub build && pnpm --filter @noy-db/hub bundle-check`, `pnpm knip`, `pnpm validate:features` (if `features.yaml` gained a capability).
- [ ] Step 3: `.changeset/via-consolidation.md` (`@noy-db/hub: minor`) with the enumerated body. `git diff` the WHOLE branch and `grep -n accounting-firm` (empty). **Milestone-#30 ledger — which issues this pass CLOSES:** #642, #651, #640, #654 (the four); #644 items 1+3 (item 2 reentrancy stays open — partial); #646 fixture mandate (partial — the two-instance delete test lands the db2-only registration). Note in the PR body that #644/#646 are partially addressed (not fully closed). Commit — `docs(hub): via consolidation — formula-output taint, key-resolution core, sync-delete freshness + changeset (#642, #651, #640, #654)`.

---

## Final steps (execution skill handles)

Full hub suite green; whole-branch review on the most capable model (focus: the axis-scoped fold's blast radius — confirm ONLY classified sources seal/non-export outputs and blob/money/i18n never clamp queryability or seal; the ref-identity guarantee keeps the countries recipe byte-identical; `postureFor`'s O(1) `defaultPosture` fallback — no fold-per-call; the whole-record `taintBinding.sealAllFields` mode excludes `_`-prefixed internal keys; the #640 FK-recovery ordering — `_peekCached` BEFORE invalidation, recompute deferred to the wave AFTER all applies; the GraphBatch stays metadata-only — grep for value/key storage; the #654 restrict fail-closed aborts forget cleanly with no partial shred; every new `decryptRecord`/`_decodeEnvelope` threads the record id; both via allowlists EMPTY and fire on synthetics; every guarded file at or below its +1 ceiling — a bump is BLOCKED). PR against `main` (do NOT merge — human gate). Fixes #642/#651/#640/#654; partially addresses #644/#646.
