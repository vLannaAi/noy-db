# Arc 9 — derived outputs follow their source's tier (#722)

**Issue:** [#722](https://github.com/vLannaAi/noy-db/issues/722) · recon: task a80b4684. **Owner decision (2026-07-17): RECOMPUTE** (drop the elevated source's contribution), uniform for record- and aggregate-grain.
**Predecessors:** the tier campaign through #729 + the Arc-7 guard. This is the third of three "full support" handlers.

## The problem (recon reshaped #722's framing)

Materialized-view rows, rollup contributions, and `withDerivation` outputs are computed from a source record and written to an **output collection** via a plain `put` — at **tier 0**, under the output collection's tier-0 DEK (`materialized-views/executor.ts:203-209`, `304-309`). `elevate()` rewraps only the *source* envelope; the derived row is a separate tier-0 record still holding the source's tier-0-era plaintext. So **elevating the source doesn't move the derived output** — any tier-0 caller reads the source-derived plaintext out of the output collection. No tier op recomputes (they `adapter.put` directly, never `_onRecordMutated('local-write')`, `tiers/index.ts`). `with-formula/` has zero tier awareness (grep-clean).

**Corrections to #722's framing (from recon):**
1. **The fix is RECOMPUTE, not purge** — `_materializedFrom` (`materialized-views/types.ts:28-46`) carries no source-record id, so output rows can't be targeted from a source id. `forget()`'s `forgetDerivedFanout` (#622, `via/dispatch.ts:305`) is already recompute-based — the analogue transplants.
2. **Scope is wider than "MV + rollup"** — record/array `withDerivation` outputs (`derivations/executor.ts:157-189`) leak identically and are a distinct forget edge. This arc covers ALL record-grain derived artifacts.
3. **Recompute is safe because the source scan is tier-aware:** MV/rollup recompute reads through the cache/`get()` which already exclude `_tier > 0` records (#701/#709/#712). So a recompute *after* elevate naturally omits the now-elevated source — it does not re-embed its plaintext (unlike the naive #721 search rebuild would have).

## Decision: recompute derived outputs on every tier move

**A derived output must reflect the source record's tier-0 visibility** — present when the source is at tier 0, absent (or contribution-dropped) when elevated. Because recompute reads the tier-aware cache, this is expressible as: *on any tier move, recompute the record's derived outputs from the current cache.* Unlike the ledger (#729, irreversible purge), this is **reversible** — the source's plaintext survives the elevate/demote rewrap round-trip, so demote re-adds it.

| Move | Source tier-0 visibility | Derived output |
|---|---|---|
| `elevate`, `putAtTier(>0)` | source leaves tier 0 | **recompute-as-remove**: record-grain rows vanish; aggregate/rollup drops the contribution; derivation outputs removed |
| `demote(→0)`, `putAtTier(0)` | source rejoins tier 0 | **recompute-as-add**: rows/contributions restored |
| `demote(→ intermediate >0)` | still elevated | recompute-as-remove (still absent) |

**Aggregate inference channel (owner-accepted):** for aggregate MV / rollups, recompute changes the aggregate value, so a tier-0 observer can infer "a record with ~this contribution was elevated" from the drop. Accepted as marginal (`_tier` changes are already store-visible metadata) — but **documented** in the changeset as a known property.

## Design

**Reuse the forget-fanout machinery** — no new engine. The remove path is exactly what `forgetDerivedFanout` runs per edge:
- MV: `dispatchMaterializedViewsOnDelete(id)` (`collection.ts:2935`) → `executor.refresh` (recompute from cache + diff, `onEmpty:'delete'`) — direction-agnostic (makes the MV match the current tier-aware cache).
- rollups: `dispatchRollupsOnDelete(id, priorRecord)` (`collection.ts:2287`) → recompute without the contribution.
- array/record derivations: `dispatchArrayDerivationsOnDelete(id, internal)` (`collection.ts:2888`).
The add path (demote) is the normal `dispatchMaterializedViews`/`dispatchDerivations`/`dispatchRollups` local-write dispatchers (`collection.ts:3866-3876`).

**The hook.** `TiersContext.syncDerived(id, record, tierIsElevated): Promise<void>` (doc-commented, sixth `sync*` beside `syncLedger`), wired in `collection.ts` `tiersContext()` to a helper that:
- `tierIsElevated` (landing tier > 0) → run the remove-dispatchers for `id` (reuse the onDelete fanout; `priorRecord` from the pre-move decode the tier op already has, for the rollup path);
- else (landing at tier 0) → run the add-dispatchers with the record.
Guarded by `this.materializedViewSource !== undefined || this.derivationSource !== undefined` (no-op when the collection has no derivations). Called by `elevate`/`demote`/`putAtTier` after the live `adapter.put`, in the same after-put block as the other sync hooks (ordering-independent w.r.t. them — it operates on OTHER collections' output rows, not this collection's cache/indexes).

**Why this composes with the merged campaign.** The derived-output rows live in *output* collections whose reads are already tier-gated; the leak was that the *content* was source-derived plaintext at tier 0. Recompute removes/updates that content. It reuses the same tier-aware cache the read gates established, so no new tier logic enters `with-formula/`.

## Constraints

- Ceiling: `collection.ts` **4548** exact — the one `syncDerived` wiring line needs a mechanical shrink-join. `tiers/index.ts` / `with-formula/` have no ceiling. `vault.ts`/`noydb.ts` untouched.
- Zero-knowledge: recompute reads through the enclave/cache path (already sanctioned); it resolves no tier DEK directly and writes output rows via the normal `put` (tier 0, as before — the point is they no longer contain elevated plaintext).
- Reuse the forget-fanout dispatchers — do NOT write a new recompute engine.
- **Coverage gap:** no test combines tiers with MV/rollup/derivation. Tests must cover: record-grain MV (elevate → the source's output row vanishes; the output collection holds no source plaintext; demote → row restored), aggregate MV (elevate → the group aggregate drops the elevated contribution; demote → restored), rollup (same), array/record derivation (output removed/restored), a sibling non-elevated source's outputs untouched, and a collection with NO derivations is unaffected (fast no-op).

## Tests reference

Grep existing MV/rollup/derivation tests (`__tests__/*materializ*`, `*rollup*`, `*deriv*`) for the real `withMaterializedView`/`withRollup`/`withDerivation` config + how to read an output collection + trigger a refresh, and `__tests__/hierarchical-tiers.test.ts` for tiers. Build a tiered SOURCE collection feeding each derivation kind; assert the OUTPUT collection's content before/after elevate + demote.
