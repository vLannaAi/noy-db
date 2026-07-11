# Via port phase C — formula/graph: dependency graph, computed(virtual), taint, sync dispatch, forget fanout (#638)

**Date:** 2026-07-11
**Issue:** [#638](https://github.com/vLannaAi/noy-db/issues/638) · **Milestone:** #28 "Via port: unified field features [api]" · Phase A merged `f6d70de8` (#628), phase B merged `abd61fff` (#630).
**Fixes structurally:** [#621](https://github.com/vLannaAi/noy-db/issues/621) (sync-applied writes skip derivation dispatch), [#622](https://github.com/vLannaAi/noy-db/issues/622) (forget leaves derived residue), [#636](https://github.com/vLannaAi/noy-db/issues/636) (computed exfiltrates classified plaintext), [#637](https://github.com/vLannaAi/noy-db/issues/637) (derivation output write on closed period fails legal source write).
**Surface:** `api` — additive (computed `mode`, deps validation, dispatch/audit events); `/adapter` and `/cargo` byte-untouched.
**Ground truth:** `.superpowers/sdd/seam-map-formula-graph.md` (file:line anchors for every seam named here). Behavior lock: the FULL derivations (3210 LOC/23 files), MV (3252/15), overlay, computed, sync, forget/erasure suites pass **unchanged** — with ONE documented exception: the #621 parity pin (`__tests__/via/mutation-choke-point.test.ts:131-161`, self-commented "phase C changes this") flips from pinning the bug to pinning the fix.

## Reframing (from the seam map)

Phase C is **not** a phase-B-style retrofit. `with-formula` has zero via couplings today — no binding, no pipeline contact; this phase builds the bridge from scratch. Three premises corrected:

- `ViaBinding.deps` is **inert** (its doc comment claims phase-A validation — false; zero readers). The graph is greenfield.
- The choke point is **pre-plumbed**: `_onRecordMutated`'s `'sync-apply'`/`'cutover'` cases already carry `// #621: phase C plugs graph dispatch here` comments (`collection.ts:3835,3842`), and sync stores ciphertext as-is (`sync.ts:634-637`) — dispatch must decrypt (reusing `_invalidateCacheEntry`'s existing decrypt path).
- Two live defects were discovered and filed during mapping: the reproduced **#636 taint leak** (computed copies classified plaintext into an ordinary stored field — every phase-B posture enforcement bypassed because posture is field-name-keyed) and the **#637 period hazard** (derivation/MV output writes are unwrapped `put()` calls; a frozen output period throws `PeriodClosedError` through the legal source write).

## Decision summary (user-ratified 2026-07-11)

1. **One full spec cycle** — graph + all four issue fixes + computed(virtual). Everything needs the graph; it gets designed once.
2. **Taint = propagate strictest source posture** (not refuse, not opt-out downgrade). Masked projections stay on the existing sanctioned rider pattern. This CHANGES behavior for any existing computed-from-classified config — deliberate: it is the security fix; changeset carries the note (pre-1.0, `@next`).
3. **Frozen outputs = skip + audit event.** Frozen means final: the historical value stands, a structured event records the post-freeze source mutation, the source write proceeds. No `_ts` is ever stamped into a frozen window.
4. **Sync dispatch = batched at pull end** with per-target dedup: `applyRemote` collects touched ids; ONE wave at sync completion; N pulled children → one recompute per affected target.
5. **computed becomes a via-feature** (grammar-locked since phase A: `via(computed(fn, { deps, mode }), money('EUR'))`); `with-formula` machinery (derivations/rollups/MV/overlay) stays service-side and **consumes** the graph — the dictionary/blob precedent.

## Design

### 1. The dependency graph (kernel, ONE instance per vault)

Built at collection construction; nodes are `(collection, field)` plus artifact-grain nodes (rollup targets, MV rows-class, overlay outputs); edges declared by: (a) via bindings' `deps` (validation goes live — unknown source field = declare-time `ValidationError`), (b) `computed` registrations (their `deps` today feed only the eager recompute check), (c) with-formula registrations (derivations/rollups/MV/overlay — cross-collection edges included). The graph is metadata-only (field names, postures, grains — never values or key material) and serves exactly three consumers: **freshness** (dispatch targets), **taint** (posture propagation), **erasure** (forget fanout). Cycles: rejected at declare time (the `_derivedFrom` loop sentinel retires in favor of graph acyclicity).

### 2. Taint propagation (#636)

At declare time the graph computes each derived field's **effective posture** = most restrictive of its sources on every axis: `encryptedAtRest` (sealed > envelope), `queryable` (none < det-exact < ordered < full → min), `exportable` (AND), `forgettable` (source forgettable forces derived forgettable — erasure completeness). A computed-from-classified field therefore becomes sealed at rest, non-exportable, non-queryable — enforced by the SAME phase-B consumers (codec at-rest hooks, `exportRedact`, query posture gate) with zero new enforcement surface: the graph only *assigns* postures; phase B already enforces them. `describe()` exposes the effective posture and its provenance (which source forced it).

### 3. Dispatch (#621) — the origin-aware wave

`_onRecordMutated`'s `sync-apply`/`cutover`/`restore` cases feed a per-sync-session **collector** (collection → touched ids). At pull completion (`SyncEngine` batch end) one wave runs: decrypt touched records via the existing `_invalidateCacheEntry` decrypt path, resolve affected targets through the graph, dedup, recompute each once. `local-write` keeps today's inline dispatch (unchanged). The existing parity pin flips by design. Recompute writes go through ordinary `put()` — origin-tagged so a recompute never re-triggers itself (graph acyclicity + origin check double-lock).

### 4. Frozen-output rule (#637)

Before any dispatch-driven output write, the wave consults the output row's period against the vault's freeze/archive windows (retention arc: `vault.freezePeriod`/`archivePeriod`). Frozen → the write is **skipped**; a structured `derivation-skipped-frozen` event is emitted (event bus always; audit-trail entry when with-audit is active) carrying source ref, target ref, and period. Applies uniformly to live dispatch, `deriveAll()`, and `refreshView()` (today all three throw).

### 5. Forget fanout (#622)

`forget()` asks the graph for the forgotten record's derived artifacts, then: **record-grain** artifacts (MV rows keyed by the record, per-record derived copies, overlay outputs) are **erased** (tombstone/delete per artifact kind); **aggregate-grain** targets (rollups) are **recomputed without the forgotten contribution** in open periods and skip+audit in frozen ones (aggregates hold no personal data; copies must die). Fanout results join the existing forget report additively. The seam map's finding that NO test combines forget × derivation/MV becomes the new suite's first fixture.

### 6. computed(virtual)

`computed(fn, { deps, mode: 'materialized' | 'virtual' })` compiles to the via pipeline. **materialized** (default — today's semantics byte-for-byte): stage-5 write-time eager compute, stored; the behavior lock pins it. **virtual**: rides the `present` phase (the money-`Formatted`/i18n-`Label` precedent) — computed on read, never stored, `queryable: 'none'` unless the graph can prove a cheaper grade later (out of scope now), excluded from export unless sources permit (taint rule applies identically). Sugar: existing `computed` config keys keep working; `via(computed(...))` is the composed form.

### 7. Ceilings & guards

collection.ts sits AT its exact 4473 ceiling (phase-B end state, dense-style debt noted at m31): any phase-C addition there requires an equal same-task shrink OR an explicitly flagged ratchet decision with user sign-off — no silent bumps. vault.ts ceiling 4088; noydb.ts 2385. `via-enclave-isolation` stays EMPTY; `via-layering` stays exactly `[join.ts → #626]`; the graph and dispatch bus live in new kernel files (not ceiling-guarded) wherever possible.

### 8. Testing

Behavior locks as above (one documented pin-flip). New: graph unit suite (edge registration from all three sources, cycle rejection, effective-posture algebra table); #636 regression (the reproduced leak fixture becomes the taint test — derived field comes out sealed/redacted/refused); #621 end-to-end (pull N children → one parent recompute, batched, decrypted; cutover/restore origins too); #637 (frozen output skipped + event emitted + source write survives, for live/deriveAll/refreshView); #622 (forget × rollup recompute, forget × MV row erase, frozen interplay); computed(virtual) present-grain round-trip + not-stored + taint; sync-stack rule (#553) unchanged for money-only collections.

## Out of scope

Phase D (lookup/via-lookup — seed saved), phase E (external SPI); MV-as-collection-via (door stays open); `_det`/`_bidx` unification; #618 auto-sync gate; declassification escape hatch (the "propagate + downgrade" option was explicitly deferred); virtual-computed queryability upgrades; collection-scoped purge (#633); any `/adapter` or envelope-format change.
