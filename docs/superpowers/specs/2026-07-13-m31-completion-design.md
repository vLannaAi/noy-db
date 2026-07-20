# Milestone #31 completion — via backlog closure (#625, #639, #661, #664, #665, #666)

**Date:** 2026-07-13
**Issues:** [#625](https://github.com/vLannaAi/noy-db/issues/625) indexProbe, [#639](https://github.com/vLannaAi/noy-db/issues/639) rollup cycles, [#661](https://github.com/vLannaAi/noy-db/issues/661) bare arrays, [#664](https://github.com/vLannaAi/noy-db/issues/664) late-attach, [#665](https://github.com/vLannaAi/noy-db/issues/665) present order, [#666](https://github.com/vLannaAi/noy-db/issues/666) writer seam · **Milestone:** #31 "Via features backlog [api]" (directive: complete before publish; publish itself gated on user check-in).
**Base:** main `b5088dda`. **Surface:** `api` — additive (`indexProbe` hook, late-attach reconcile coverage); `/adapter` + `/cargo` byte-untouched.
**Ground truth:** `.superpowers/sdd/seam-map-m31.md` (probe-proven; file:line anchors). Behavior locks: full money/i18n/dict/lookup/MV/derivations/computed/query/classified suites pass unchanged except pins that pin the fixed defects (enumerated per task in the plan).

## Decision summary (user-ratified 2026-07-13)

1. **#639 = sentinel rework only** — declare-time refusal; no runtime depth guard.
2. **#665 = topological present order** — computed-first present phase.
3. **#661 = element-wise array support** in BOTH ingest and enforceWrite.
4. **Publish gate:** after #31 merges, STOP and present release contents; no publish-adjacent command without explicit go.

## Design

### 1. #666 → the writer seam (lands first — #664's enabler)

`Collection._setVia(pipeline)` — assigns the private `via` and calls the internal `codec.setVia` (the two things `applyTaintOverlay`'s cast does today at via-graph-wiring.ts:319/337). `via` is private, so no structural interface can replace the write (TS2540 on the getter proved the read/write asymmetry). collection.ts is at zero slack: pair with a named shrink (`get _ramCiphertext` :1371-1372 collapse, or `_applyClassifiedFields` comment compaction). `applyTaintOverlay`'s param types against the getter+setter pair; the cast dies.

### 2. #664 — late-attach parity: collision guard + i18n/dict/lookup reconcile

- **Guard (both recipes), in via-compose.ts:** (a) incoming×incoming — re-run the existing pure `guardCrossBindingFieldCollisions` on the late-attach path's merged view; (b) existing×incoming — read the live collection's compiled families via `coll._via` bindings' `covers()` + `brand` → `VIA_FIELD_MAP_FAMILY`, refuse `ValidationError` naming field + both families. No new Collection surface.
- **Machinery, in a NEW `kernel/via-reconcile.ts` (unguarded):** free functions `reconcileI18nFields`/`reconcileDictKeyFields`/`reconcileLookupFields` that rebuild the pipeline through `ViaPipeline.build` + `_setVia`, plus the vault-registry wiring lookup needs (reserved prefixes, snapshot, graph ref edges, membership closures). vault.ts's 5-branch `_apply*` ladder (852-869) collapses into ONE dispatch call into via-reconcile — net-NEGATIVE in vault.ts, funding the guard call.
- **Lookup tier scoping (honest limits):** enum/static tiers attach cleanly; reserved tier attaches with vault-registry updates; **matrix tier late-attach REFUSES with a clear `ValidationError` unless its backing collection is already open prefetch-enabled** (lazy backing throws at binding.ts:252-264 — a clear refusal beats a deferred crash; documented, pinned).
- Blob late-attach stays out of scope (unchanged silent-ignore is #664's text; blob is vault-grain machinery — note in docs).

### 3. #639 — cycle visibility without taint bleed

`assertAcyclic`'s DFS gains a **traversal-local containment expansion**: when visiting a real field node `(C,f)`, also expand the edges sourced at `(C,'*')` (probe-proven to detect the mutual-rollup cycle). Explicitly NOT a `registerDerived` edge — putting `(C,'*')` into `_in` would flip `_contribution` onto the `foldWildcardSecurity` path and bleed taint (#642 interaction; posture folding never reads `_out`, so a traversal-only change is provably separate). Mutual rollups now `ValidationError` at declare time; the existing rollup suites lock registration shapes.

### 4. #665 — computed-first present order

`present()` is a flat fold over `this.bindings` in global compile order (money→…→computed last; via-pipeline.ts:109-113). Fix: a present-phase-local `_presentOrder` (computed bindings first, others in existing relative order) — NOT a global bindings reorder (write phases need money-first). Flips the i18n (`statusLabel`) and lookup pins in `computed/virtual.test.ts:258,302` to positive. **Money virtual dressing is OUT OF SCOPE** (seam-map premise correction: `decodeMoneyFields` expects stored scaled-int; a virtual field emits a major-unit number — a value-shape question, not ordering; its pin stays KNOWN LIMITATION and a follow-up issue is filed at wrap-up to the successor bucket).

### 5. #661 — bare-array element-wise, both hooks together

`Array.isArray` branches in ingest (binding.ts:317-322) and enforceWrite (:345-348), mirroring the `[].`-wildcard branches (:296-315), sharing `backing.altIndex`/`cfg.membership`. Pins: closed-vocab refusal per element, altKey normalization per element, mixed/empty arrays, scalar byte-parity.

### 6. #625 — indexProbe (reviewer-spec'd; drift-checked)

As the issue pins: optional `ViaBinding.indexProbe?(op, payload)`; `ViaPipeline.indexProbe` brand dispatch mirroring `evaluateClause`; via-money fixed-mode `==` → `entries[0].scaled`, `in` → `entries.map(e => e.scaled)`, else undefined; builder.ts:1129's `if (clause.via) continue` becomes a probe (`clause.via.indexValue !== undefined` → `lookupEqual`/`lookupIn`, else scan). MUST verify the probe's stored-form byte-matches the index's `stringifyKey` (the seam map's one dependency flag). Harden the still-fake `__tests__/money/where-comparison.test.ts:184-203` with real `withIndexing()` + a lookupEqual spy. No posture-gate drift (money is `ordered`).

## Testing

New pins per issue (each red→green): mutual-rollup declare refusal + acyclic-still-passes control (#639); i18n+lookup virtual dressing positive + money limitation still pinned (#665); late-attach collision recipes (a)+(b) + i18n/dict/lookup reconcile end-to-end + matrix-tier refusal (#664); bare-array quartet (#661); index fast-path spy proof + probe/stringifyKey parity (#625); cast-gone typecheck + `_setVia` contract (#666). Ceilings: collection.ts 4472 (+`_setVia` −named shrink), vault.ts 3939 (ladder collapse = net-negative), noydb.ts 2385 untouched.

## Out of scope

Money virtual-dressing quantize decision (follow-up at wrap); blob late-attach; runtime depth guard (#639 ratification); range-op index acceleration (never existed); `@latest` promotion; publish (gated).
