# Tier-invisibility campaign — endgame plan (consolidate + refuse)

**Status:** decision doc, written 2026-07-16 after 6 merged arcs, at the request to stop expanding and converge.
**Context:** the campaign closed the tier-0 leak surface subsystem-by-subsystem (reads #700/#710/#714/#717, write-ring #719, indexing #723, search #727; history at-rest #712 in flight on `fix/712-history-at-rest`). The remaining open items are a **bounded, enumerated** tail — not an open frontier. This plan converts "N more per-subsystem arcs" into **one seam + one guard + a short finish list**, and makes an explicit keep/refuse/park decision for every open issue.

## The root finding (why this converges)

Every leak has one shape: **a derived artifact is encrypted under the collection tier-0 DEK and does not move when its source record's tier moves.** `forget()` was hardened against this per-artifact over time (`purgePersistedIndexes`, `_purgeVector`, `_purgeSearchIndex`, `forgetDerivedFanout`, `tombstoneHistory`); `elevate()`/`demote()`/`putAtTier()` were not. The complete artifact inventory (from the #712 recon):

| Artifact | forget() site | tier-move analogue | Status |
|---|---|---|---|
| record body | `_writeTombstone` | `rewrapBodyToDek` | ✅ pre-existing |
| `_idx` field sidecars | `purgePersistedIndexes` | `syncIndexes` | ✅ #709/#723 |
| `_vec` embeddings | `_purgeVector` | `syncSearch` | ✅ #721/#727 |
| `_ftindex` lexical blob | `_purgeSearchIndex` | `syncSearch` | ✅ #721/#727 |
| `_history` snapshots | `tombstoneHistory` | `syncHistory` (rewrap) | ~ #712 in flight |
| MV / rollup outputs | `forgetDerivedFanout` (#622) | — none | ❌ #722 |
| blob content | `shredAllForRecord` | — none | ❌ #724 (unverified) |
| sealed-field CEKs | shred | `rewrapBodyToDek` passenger | ✅ pre-existing |
| subject-ref index | `_removeSubjectRef` | n/a (not plaintext-derived) | ✅ n/a |

**The list is complete.** Nothing outside it persists record-derived plaintext under the tier-0 DEK (verified by the #721 whole-branch `adapter.put` sweep — no third search artifact; and by this inventory being the full `forget()` purge set). That is the convergence proof: the endgame is finite and named.

## The missing seam (the real architectural signal)

Today each tier op (`elevate`/`demote`/`putAtTier`, `with-audit/tiers/index.ts`) calls each derived-artifact hook **separately** — `await ctx.syncCache(...)`, `await ctx.syncIndexes(...)`, `await ctx.syncSearch(...)`, and (pending) `await ctx.syncHistory(...)`, repeated at every op (lines 185-196, 364-368, 445-454). Adding the next artifact means adding another `ctx.syncX` at every call site — the repetition this campaign has been paying. The fix is **one dispatch** every subsystem registers with, mirroring the existing `forgetDerivedFanout` on the erasure side.

## Decision per open issue

| # | Item | Disposition | Rationale |
|---|---|---|---|
| **#712** | history at-rest | **FINISH** (in flight) | Closes cleanly; T1 approved; the last confirmed at-rest leak. |
| **#722** | MV/rollup outputs survive elevation | **CONSOLIDATE** | Register the MV/rollup subsystem on the new `onTierMove` seam; `forget()` already has `forgetDerivedFanout` to mirror. Real leak, but design-flavored (aggregate rows mix tiers) → gets a per-derivation-kind decision *inside* the seam. |
| **#724** | blob content survives elevation | **VERIFY → then CONSOLIDATE or REFUSE** | Unverified lead. Step 1 is a repro. If real: the blob CEKs re-key on the seam (like history); if the blob read path is already tier-gated, it's moot. |
| **#708** | sync/tabs/migration internal-write ring | **PARK behind the read-gate** (+ REFUSE the sharp edge) | The read spine is already law-compliant; these are *internal* write paths. The one sharp item — coordinated-cutover silent demotion (`collection.ts:2590`) — should **refuse-loudly** now; the rest (sync-apply, `_invalidateCacheEntry`) is documented known-limitation, deferred until sync+tiers is actually used. |
| **#718** | internal deletes bypass write-ring | **CONSOLIDATE with #708** | Same internal-write-path family; carries the coverage-gap regression tests for the two #707 masks. |
| **#720** | lazy `putAtTier(0)` dropped-field sidecar | **FOLD into the seam** | The seam's re-key path resolves the prior via a tier-gated decode (the fix #720 asks for), covering it for free. |
| **#725** | debounced flush re-persists stale `_ftindex` | **REFUSE-adjacent / SERIALIZE** | Pre-existing, affects `forget()` too. Fix is the epoch-counter serialization in `PersistedIndexStore` (bounded, its own small PR); not tier-specific. |
| **#726** | `_vec` vault-global namespace | **BACKLOG** (storage-layout + migration) | Pre-existing wart, capped by `EmbeddingModelMismatchError`; a namespacing change with a migration, orthogonal to tiers. |
| **#728** | elevate/demote don't snapshot pre-move version | **BACKLOG** (completeness, no leak) | Decide whether a tier move belongs in the version chain at all. Low priority. |

**The registration guard (the "refuse" half).** Add to `vault.collection()` config validation: **any collection declaring `tiers` together with a derived-artifact feature that has NOT registered on the `onTierMove` seam is refused at registration** — exactly as `unique + tiers` is already refused (`unique-constraints.ts:158-163`). This makes "tiers doesn't compose with X yet" a loud, honest error instead of a silent leak, and it means no *future* derived artifact can reintroduce this class without either registering or being refused. This is the durable fix that ends the campaign as a *closed* class rather than an ongoing audit.

## Sequencing (bounded — 3 steps, not N arcs)

**Step 1 — Finish #712** (current branch `fix/712-history-at-rest`). Complete Task 2 (wire `syncHistory` into elevate/demote/putAtTier + the at-rest key-inspection tests), fable whole-branch, PR, `Closes #712`. Leaves the per-op `ctx.syncHistory` call in place for now — Step 2 consolidates it.

**Step 2 — The `onTierMove` seam + registration guard** (one arc, closes #722, #720, folds the existing hooks):
- Introduce `TierMoveDispatch`: subsystems register `{ name, onTierMove(ctx, id, record|null, fromDek, toDek, version) }`. The tier ops call `ctx.dispatchTierMove(id, record, fromDek, toDek, version)` **once** instead of four separate `ctx.syncX`.
- Retrofit the existing `syncCache`/`syncIndexes`/`syncSearch`/`syncHistory` as registered handlers (behavior-preserving — the whole-branch review verifies identical effects).
- Register the MV/rollup handler (#722) — per-derivation-kind purge/recompute decision lives here.
- The seam's re-key path resolves priors via a tier-gated decode → closes #720.
- Add the **registration guard**: `tiers` + an unregistered derived feature → `UnsupportedTierCompositionError` at `vault.collection()`.
- Ceiling: the tier ops *shrink* (four calls → one) — net-negative on `tiers/index.ts`; `collection.ts` wiring is one dispatch line funded by removing the four.

**Step 3 — The sharp internal-write edges + verification** (small, bounded):
- #724: repro the blob leak; if real, register a blob handler on the seam or refuse `tiers + blobs`.
- #708: refuse-loudly on coordinated-cutover silent demotion (`collection.ts:2590`); document the rest as known-limitation behind the read-gate; #718 folds in with its regression tests.
- #725: the `PersistedIndexStore` epoch-counter serialization — its own small PR (not tier-specific; also fixes `forget()`).
- #726, #728: backlog (labeled, not this campaign).

**After Step 3 the class is closed:** every derived artifact either re-keys on the seam or is refused at registration; no silent tier×feature leak can exist. The campaign ends as a *guarded invariant*, not an open audit.

## Why not restart / rebuild the foundation

The enclave/DEK core is sound and was *stress-tested* by this campaign (team-DEK rotation fails closed; the archive engine is protected by the read gates). Every bug is in **composition**, not the crypto foundation. A rebuild discards 8 merged review-hardened PRs closing proven leaks **and** the enumeration itself — the campaign's most valuable artifact. Step 2's seam *is* the foundation improvement the repetition was pointing at, and it is only designable now that the enumeration is complete.

## Open question for the owner

Is **tiers × {search, history, blobs, MV}** a supported product combination, or a niche with ~zero current usage (evidenced by zero pre-campaign coverage)?
- **If supported:** do Steps 2–3 in full (consolidate + register every handler).
- **If niche:** Step 2's guard can **refuse** most combinations instead of registering handlers — collapsing Steps 2–3 to "one seam for the common cases (indexes), refuse the rest," which is cheaper and ends sooner. This is the single decision that sizes the remaining work.
