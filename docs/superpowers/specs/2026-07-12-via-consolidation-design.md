# Via consolidation pass — formula-output taint, the key-resolution class, sync-delete freshness (#642, #651, #640, #654)

**Date:** 2026-07-12
**Issues:** [#642](https://github.com/vLannaAi/noy-db/issues/642) (security), [#651](https://github.com/vLannaAi/noy-db/issues/651) + [#654](https://github.com/vLannaAi/noy-db/issues/654) (the key-resolution class), [#640](https://github.com/vLannaAi/noy-db/issues/640) (freshness) · **Milestone:** #30 "Via follow-ups [api]" · Base: main `5f290e57` (v0.3.0-pre.9 published).
**Near-free riders:** #644 items 1+3 (stale-open batch on push-throw; structured wave-error surfacing rides #640's wave changes), #646's fixture mandate (same files).
**Surface:** `api` — additive (collection-level output postures, batch delete-kind); behavior change on #642 per the user's ratified call (**no consumers on formula outputs → no migration story**); `/adapter` and `/cargo` byte-untouched.
**Ground truth:** `.superpowers/sdd/seam-map-consolidation.md`. Behavior locks: the FULL derivations/MV/rollup, lookup (all tiers + aliases), sync, forget/erasure, classified suites pass unchanged except pins that pin the fixed defects (enumerated per task in the plan).

## Decision summary (user-ratified 2026-07-12)

1. **#642 goes DEEP: collection-level posture defaults.** Rollup targets (real fields) inherit via the existing taint overlay; derivation/MV **output collections** get a collection-level default posture — every field inherits the folded posture — flowing through the EXISTING phase-B/C consumers. No migration story (user: no consumers use formula outputs yet, pre-1.0).
2. **#654 policy (controller-ruled, T5-consistent):** an unresolvable key on a *restrict* edge REFUSES the delete/forget (fail closed); unresolvable keys on *propagation* paths (both remaining silent sites: `applyLookupRefsPropagation` ordinary-delete, and any residual) residue-report — never silent.
3. **#640 mechanics per the #621/D-4 precedents:** batched at pull end, deletes applied before the wave, delete-kind entries in the batch.

## Design

### 1. #642 — the '*'-posture fold, kind- and axis-scoped (the seam map's trap avoided)

`ViaGraph._contribution`'s `?? DEFAULT_POSTURE` for `'*'` nodes becomes a **lazy, kind-scoped fold**: for edges of kind `derivation | rollup | mv | overlay` (formula kinds ONLY — `'ref'` edges KEEP identity: lookup's documented reliance on `'*'` = identity stands, no lookup-referencing field seals because its dimension has a classified column), the `'*'` contribution = fold of the source collection's REGISTERED field postures on the **security axes only**: `encryptedAtRest` (sealed-wins) and `exportable` (AND). `queryable` is NOT folded directly — inheriting `sealed` triggers the phase-C honest clamp (`queryable: 'none'`, no digests exist), otherwise the output keeps its own grade; `forgettable` ORs. Computed lazily in `_contribution` — `_effectiveCache` already invalidates on every `registerField`, so registration ordering is free (seam map finding 3).

**Enforcement, both target shapes:**
- **Rollup targets** (real fields): the folded posture lands exactly like Task-C3's overlay — assigned at declare/reconcile, enforced by the existing query gate / exportRedact / at-rest sealing. Automatic.
- **Derivation/MV output collections** ('*' targets, fn-determined fields): a **collection-level default posture** on the output collection — carried in collection config, applied by `postureFor` as the fallback for ANY field of that collection (field-specific postures still win). Sealed-inherited outputs seal at rest via the existing `ctx.sealedSlots` path, redact on export, refuse queries per the clamp. The reconcile/two-phase machinery (D-2 wave-2) re-applies when output-opened-before-source ordering occurs — the cross-collection re-apply gap (seam map finding 4) closes via the same graph-memory pattern.
- The recompute writes themselves are unaffected mechanically (ordinary puts; the codec seals per the output collection's posture).

Behavior change framed in the changeset as the #636-principle completion: ALL formula outputs derived from classified-bearing collections are now sealed/non-exportable by default. An explicit per-declaration opt-out is NOT built (declassification remains phase-E). New pinned tests: the #642 repro flips (derive-copy of classified plaintext → sealed output, redacted export, refused query — all three surfaces, both target shapes).

### 2. #651 + #654 — ONE key-resolution core, the class ends

A canonical descriptor-keyed resolution core in `port/with/lookup-strategy.ts` (the kernel spine may import `port/with/*` freely — seam map corrected premise 7): `resolveBackingRowKey(descriptor, row)` + the **guarded coercion** (string|number → String, else undefined — the bare-`String()` `"undefined"`-key poisoning dies everywhere, dm12 closed). Consumers converge: `buildLookupSnapshotRows` (already canonical), `buildLookupAltIndex`, `checkLookupMembership`, `resolveLookupCompareKey`, the fanout inline twin, and **`getLookupBacking` — its closure signature gains the descriptor** (the T7 `snapshotFor` dispatch precedent), fixing #651's direct-read dressing for `key !== 'id'` (the cold-session/join-path caveat narrows accordingly; docs updated, #651's doc caveat retired). The with-shape I/O shells stay thin per the layering rule; only the pure core is shared.

**#654 policy wiring:** `checkLookupRefsRestrict`'s `compareKey === undefined → continue` becomes REFUSE (throw `DictKeyInUseError`-adjacent refusal naming the unresolvable edge — fail closed; corruption-class rarity makes this safe); `applyLookupRefsPropagation`'s ordinary-delete skip residue-reports (additive on the delete result path mirroring the forget residue channel). Pins: restrict-unresolvable refuses; propagation-unresolvable reports; direct-read matrix dressing with `key!=='id'` works (the #651 repro flips).

### 3. #640 — sync-applied deletes reach the wave (three coherent layers)

(a) The pull loop classifies tombstone applies (`isTombstoneShape` — the main loop already detects them) and the `cacheInvalidator` seam carries the action kind (signature widened — internal seam, not public); (b) `GraphBatch` entries gain a `kind: 'put' | 'delete'` (metadata-only pin respected — a kind IS metadata); (c) the wave routes delete-kind entries to the rollup-on-delete recompute path (`dispatchRollupsOnDelete` semantics), with the **deleted child's FK recovered pre-invalidation** (`_peekCached` before the cache entry dies, falling back to the classification carry — the plan pins the exact mechanism). Ordering: deletes applied before the wave flush (the D-4 vocabulary rule). Scope guards: sync delete ≠ forget (no shred, no residue channel — freshness only); reserved-tier delete-markers (D-4) already flow — this closes the ORDINARY-collection tier. Riders: #644's stale-open batch on push-throw (clear-on-error) and the structured `derivation:wave-error` event (#644 item 3, upgrading the console.warn) land in the same wave-touching diff; #646's fixture strengthening (db2-only registration) rides the new two-instance delete test.

### 4. Testing

The four repros become the pins (none exist today — seam map finding 10): formula-output posture (both shapes × three surfaces), matrix direct-read `key!=='id'` dressing, restrict-unresolvable refusal + propagation residue, pulled-delete-recomputes-parent (two-instance, count-asserted, db2-only registration per #646). Behavior locks as above. Ceilings: ALL THREE at +1 slack (4472/4473, 3939/3940, 2384/2385) — new logic in unguarded files (via-graph, via-dispatch, registry, lookup-strategy, collection-config); guarded files thin-touch, shrink-first, BLOCKED not bump.

## Out of scope

Declassification/opt-out (phase E); MV/derivation output *field-level* introspected postures (the introspection wall — the collection-level default IS the fix); #653 (partial-sync dictionary expansion — mechanism confirmed available, own cycle); #639 rollup cycles; marker GC (dm9); `@latest` promotion.
