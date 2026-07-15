# #691 — Tier-unaware classify/det read paths (design)

**Issue:** [#691](https://github.com/vLannaAi/noy-db/issues/691) · Milestone 25 (Road to 1.0: crypto audit) · exposed by #662's (correct) slot carry.

## Problem

Since #662 carries `_det`/`_vdig`/`_bidx`/`_cek` through tier moves, several **tier-0 kernel
enclave read paths** now encounter valid-but-tier-wrapped key material on elevated records and
resolve it under the **collection (tier-0) DEK unconditionally**:

1. `kernel/enclave/record-keys/deterministic.ts` — `findByDet` (:94) / `queryByDet` (:114):
   `_det` is tier-independent, so an elevated record **matches** the scan; the bare
   `codec.decryptRecord(env, {id})` then throws (`TamperedError`/`InvalidKeyError`) and
   **aborts the whole scan**, losing tier-0 matches already collected.
2. `kernel/enclave/classify/verify.ts` — `verifyDigestField` (:69), `verifyTextField` (:111),
   `matchGroupFields` (:159): `await ctx.resolveCek(env)` sits **outside** the padded
   try/catch; the throw escapes the module's own verdict-only-egress contract (header lines
   2–11) and is an **existence/elevation oracle**. `findByDigest`'s confirm loop routes
   through `verifyDigestField` (collection.ts ~1196–1213), so it inherits the same throw.
3. **Cache asymmetry (the audit bypass):** `resolveEnvelopeCek` consults the shared
   `cekCache`; the *elevating* session has the CEK cached, so `findByDet` there **succeeds**
   and returns tier-1 plaintext through a path that emits **no `CrossTierAccessEvent`** —
   behavior is cache-state-dependent (cold throws; warm leaks past the tier audit).

Two adjacent #662 leftovers (issue fold-ins): **(a)** `elevate`/`demote` write via
`adapter.put` but never evict the collection's eager record cache → in-session `get()` after
a tier move returns stale pre-move data; **(b)** `elevate`/`demote` on a delete-marker /
tombstone throw `TamperedError` from `rewrapBodyToDek` (empty `_data`) instead of a domain
not-found error.

## Decision (user-approved 2026-07-15): elevated records are INVISIBLE on tier-0 enclave paths

The sanctioned tier-aware read surfaces are `getAtTier`/`listAtTier` (with-audit). The kernel
enclave stays tier-unaware; an elevated record on a tier-0 path behaves **exactly like a
missing record**. Rejected alternative (matchable-with-clearance det scans): pulls tier
machinery into the kernel enclave (layering inversion — with-audit is opt-in), must dodge
`getDEK`'s DEK auto-mint, and verify can never take it anyway (any tier-distinguishable
verify behavior is an existence oracle under C4). A tier-aware det query, if ever wanted,
is a future `with-audit` feature.

**The gate is an explicit `(env._tier ?? 0) > 0` check placed BEFORE any key resolution** —
never a try/catch around resolution. Only the explicit gate is deterministic regardless of
`cekCache` state; a catch-based fix would leave the warm-session audit-bypass leak open.

### Per-path behavior

| Path | Elevated record → | Notes |
|---|---|---|
| `verifyDigestField` | `padFalse()` | Fold into the `env === null` branch — identical pad path as missing (C4 preserved), and **before** the R6 `refuseSealedResidue` check (an elevated record must not trip a tier-0 config-bug throw). |
| `verifyTextField` | forced `{ok:false}` via the existing single padded path | Extend the unseal precondition (`env !== null && blob !== undefined`) with the tier check so `stored` stays `undefined`; the unconditional pad + blindedEqual tail is untouched. |
| `matchGroupFields` | all members pad-false | Null-out the envelope view at one gate point before the R6 residue loop AND the `resolveCek` — elevated ≡ missing for the residue check too. |
| `findByDet` / `queryByDet` | skip-and-continue | Scan keeps collecting tier-0 matches. |
| `findByDigest` confirm loop | inherited from `verifyDigestField` | No collection.ts change; regression test still required. |
| Ghost mode | no special handling (documented) | Ghost semantics live on get/list surfaces; verify must never advertise existence, and det scans return decoded `T` so they cannot carry a `GhostRecord`. |

### Fold-ins (with-audit/tiers/index.ts)

- **Cache eviction on tier moves:** `TiersContext` gains `evictCache(id: string): void`;
  `elevate`/`demote` call it after their `adapter.put`. Wiring in `collection.ts`'s
  `tiersContext()`: `evictCache: (id) => { this.cache.delete(id) }` (mirrors the delete
  path's `this.cache.delete(id)`, collection.ts:2872). The existing `cekCache.set` stays.
- **Tombstone guard:** extend the `!envelope` branch in both `elevate` and `demote` to
  `!envelope || isDeleteMarker(envelope) || isTombstoneShape(envelope)`, throwing the **same**
  `Record "<id>" not found in collection "<name>"` error — deleted ≡ missing, no oracle
  distinguishing them. Predicates come from the already-imported `enclave/index.js` barrel.

## Constraints

- **Ceilings (exact-zero-slack):** collection.ts 4549, vault.ts 3959, noydb.ts 2396
  (checker metric = `split('\n').length` = wc-l + 1). The single `evictCache` wiring line in
  collection.ts requires removing one line elsewhere in the same file first (shrink-first;
  do NOT bump the ceiling). vault.ts / noydb.ts are not touched.
- **Zero-knowledge invariant untouched** — no new key material flows anywhere; the change
  only *refuses* resolution earlier.
- **Pad discipline (C4):** the elevated branch must be byte-identical in cost to the
  missing-record branch in every verify door. No new timing oracle.
- Behavior lock: full existing suite green unchanged; tiers/classified/det suites in
  particular.

## Tests (each RED first where the bug reproduces)

All exercised against a real elevated record (put tier-0 with classified/det fields, then
`elevate`), in **both** sessions:

- **Cold session** (reopen `createNoydb` over the same store — empty `cekCache`): today
  throws; after: verify → `{ok:false}`, det scans → skip, `findByDigest` → elevated hit
  dropped.
- **Warm (elevating) session** (CEK in cache): today `findByDet` LEAKS tier-1 plaintext with
  no `CrossTierAccessEvent`; after: skipped identically to cold. This test pins the audit
  bypass closed.
- det scans: sibling tier-0 records with the same det value are still found (scan-abort
  regression).
- Fold-ins: `get()` after `elevate`/`demote` returns fresh state (stale-cache RED);
  `elevate`/`demote` on a deleted id throws the not-found error, not `TamperedError`.

Fixture: extend/copy `__tests__/hierarchical-tiers.test.ts` (store spy + keyring access +
audit opt-in already right there).
