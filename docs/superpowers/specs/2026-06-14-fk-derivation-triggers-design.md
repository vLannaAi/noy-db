# FK-keyed derivation triggers — rollups & reverse-denormalization (#376)

> **Status:** DESIGN — awaiting maintainer decisions (see § Decisions needed).
> **Pilot:** Speedex refoundation. Highest-impact pilot-2 request.
> **Depends on:** nothing new ships first; builds on Dim 14 derivations + indexing + refs.

## Problem

`withDerivation` (Dim 14) re-fires for the **primary `source` record at the SAME
id** as the written sibling (`derivations/types.ts` SAME-ID contract;
`collection.ts:1700-1714`). That blocks the two most common parent/child
maintenance patterns, both keyed by a **foreign key**, not a shared id:

1. **Rollup / reverse-aggregation** — maintain `buyer.revenueByYear` /
   `buyer.toPayAmount` from many child `sales` (keyed by `sale.buyerId`).
2. **Reverse denormalization** — a `buyer.companyName` change must refresh a
   denormalized `buyerName` on **all** `sales` where `sale.buyerId === buyer.id`.

Both fall to userland today → the "stats computed two divergent ways" and "stale
denormalized name" bug classes the pilot keeps hitting.

## Why not the tools we already have

- **`withMaterializedView` + aggregate** produces a *parallel grouped collection*
  (`buyer-totals.get(buyerId)` → an aggregate row). It **cannot write an
  aggregate onto a field of the parent `buyers` record**, and it **cannot fan a
  parent change down to child records**. (Confirmed against
  `materialized-views/types.ts`.) The rollup-onto-parent-field and the
  reverse-denorm fan-out are genuinely outside MV scope.
- **`sources[]` sibling triggers (#344)** re-fire at the *same id* — the exact
  assumption #376 must relax.
- **`refArray` (#377-A)** is M:N *integrity*, not derived-value maintenance.

## Key facts the design leans on (grounded)

- **No record-level reverse index exists.** `RefRegistry.getInbound(target)` is
  schema-level only (which collections reference a target), not
  `(targetId) → [referrer ids]`.
- **The indexing subsystem already gives O(children) fan-out** *when the child
  collection opts into `withIndexing()` and declares the FK field*:
  `CollectionIndexes.lookupEqual(field, value)` (eager) /
  `PersistedCollectionIndex` (lazy) return the exact id set.
- **That index is already reachable from `derive()`** via the read-only facade:
  `ctx.vault.collection('sales').query().where('buyerId','==',id).toArray()`
  dispatches through the index (`query/lazy-builder.ts`). Without an index it is
  an O(N) `list()` scan.
- **Eager derivation dispatch is tx-atomic** (`dispatchDerivations` registers
  output pre-images on `txCtx._executed`; `collection.ts:1729-1736`).
- **`forget()` bypasses `Collection.put` → does NOT trigger derivations**, and
  there is **no existing cleanup of derived outputs on source delete/forget**
  (a pre-existing gap, relevant to rollup-on-delete below).

## Proposed design

Two complementary surfaces — one extends `withDerivation`, one is dedicated sugar.

### A. `triggerBy` — FK-keyed re-fire (reverse-denormalization)

Extend `DerivationStrategy` with an FK trigger that fans out to **every source
record whose FK matches the written trigger record**:

```ts
withDerivation<Sale, { self: Sale }>({
  source: 'sales',
  triggerBy: [{ collection: 'buyers', on: 'buyerId' }], // on = FK field ON the source
  outputs: { self: { shape: 'record', collection: 'sales' } }, // writes back to the source
  derive: async (sale, ctx) => {
    const b = await ctx.vault.collection<Buyer>('buyers').get(sale.buyerId)
    return { self: { ...sale, buyerName: b?.companyName ?? sale.buyerName } }
  },
  lifecycle: 'eager',
})
```

Semantics: a write to `buyers/X` resolves all `sales` where `sale.buyerId === X`
(via `query().where('buyerId','==','X')`), and re-fires the derivation **once per
matched source record** (the source record is the matched *sale*, not the buyer).
Contrast with `sources[]`, which re-fires once at the same id.

`on` is the FK field **on the source** (`sales.buyerId`). The trigger collection
(`buyers`) is the parent. Self-output (`collection === source`) is the
reverse-denorm "patch the source record in place" case — see Decision 1.

### B. `withRollup` — aggregate onto a parent field

Dedicated sugar for "fold children into one field on the parent":

```ts
withRollup<Sale, Buyer>({
  from: 'sales',          // child collection (trigger)
  key: 'buyerId',         // FK on the child → parent id
  into: 'buyers',         // parent collection
  field: 'revenueByYear', // field on the parent to write
  compute: (sales) => groupSumByYear(sales, 'total'),
})
```

Semantics: on any write **or delete** of a `sales` record, recompute
`compute(allSalesWhere buyerId === sale.buyerId)` and write it to
`buyers/<buyerId>.revenueByYear`. Desugars to a derivation whose source is the
**parent** keyed off child writes, fanning *in* (aggregate) rather than *out*.

`withRollup` is a thin builder over the same engine as `triggerBy`; it exists
because the aggregate-onto-parent shape is common enough to deserve a 5-line
declaration instead of a hand-written `derive`.

### Fan-out & performance

- Both use `ctx.vault.collection(child).query().where(key,'==',parentId)` →
  O(children) when the child declares `withIndexing()` on the FK, O(N) scan
  otherwise.
- Reuse the existing `maxFanout` / `DerivationCapExceededError` budget (default
  64; surfaced before any write so no partial fan-out persists). **`log()` /
  warn when a fan-out runs unindexed** so silent O(N) scans are visible.

### Cycle detection

Extend the vault-open DFS (`registry.validate()`) to add edges:
`triggerBy.collection → source` and `withRollup.from → into`. A reverse-denorm
that writes back to its own source (`self`) is guarded at runtime by the existing
`_derivedFrom` short-circuit (`collection.ts:1684`) — but a self-write that is
*not* tagged `_derivedFrom` (reverse-denorm patches a real user record) needs the
guard from Decision 1.

### Lifecycle

- **eager** — recompute inside the trigger write's tx (atomic, via the existing
  `_executed` pre-image registration). Recommended default for rollups (stats
  must not lag).
- **lazy** — mark affected parents/children stale; resolve on read. Reuse
  `markStale` / `resolveStaleOnRead`. The stale key must be the *affected target
  id(s)*, not the trigger id — a fan-out marks N targets stale.

## Decisions needed (maintainer's call)

1. **In-place source write vs separate output (the crux).** Reverse-denorm
   patches a **real user record** (`sales`), not a separate derived output
   collection — a first for Dim 14, which has only ever written to *output*
   collections it owns. Options:
   - **(1a) Allow `self` output = write back to the source record**, tagging only
     the derived fields' provenance. Pro: matches the use case directly. Con:
     blurs "derived output" vs "user data"; the `_derivedFrom` whole-record
     cycle guard no longer fits (the record is mostly user-owned). Needs a
     **field-level** provenance + cycle guard instead of the record-level one.
   - **(1b) Forbid self-output; reverse-denorm writes a sibling shadow collection**
     (`sales-denorm`) joined at read. Pro: keeps the "derivations own their
     outputs" invariant intact. Con: callers must join; doesn't match the
     "stamp `buyerName` onto the sale" ask.
   - **Recommendation: 1a**, with a field-level cycle guard (only the
     `compute`d fields carry provenance; a re-fire that would produce identical
     field values is a no-op, breaking the cycle). This is the higher-value, riskier path.

2. **Rollup-on-delete + forget.** A rollup MUST recompute when a child is
   **deleted** (else `revenueByYear` overcounts forever). Today derivation
   dispatch fires on `put` but the delete path and `forget()` do **not** trigger
   derivations. Options: hook `withRollup` into the delete path
   (`enforceRefsOnDelete`-adjacent) and document that `forget()` does not
   auto-recompute (a separate, tracked gap). **Recommendation: hook delete;
   document forget as out-of-scope for v1 with a `vault.recomputeRollups()` escape hatch.**

3. **Require an FK index?** Hard-require `withIndexing()` on the FK (throw at
   registration if absent) vs allow the O(N) scan with a loud warn.
   **Recommendation: warn, don't require** — small child sets are fine; requiring
   indexing couples two subsystems and surprises small-data users. Re-evaluate if
   pilots hit scans on large sets.

4. **`withRollup` vs `triggerBy` only.** Ship both, or only `triggerBy` (rollup
   as a documented recipe)? **Recommendation: ship both** — rollup is the more
   common ask and the dedicated builder removes a sharp-edged hand-written derive.

## Build plan (sketch, after decisions)

1. `triggerBy` on `DerivationStrategy` + `with-derivation` validation; registry
   dual-keys trigger collections; `dispatchDerivations` adds the FK-fan-out branch.
2. Field-level provenance + cycle guard (Decision 1a).
3. `withRollup` builder desugaring to the engine + delete-path hook (Decision 2).
4. Extend `registry.validate()` cycle DFS.
5. Tests: reverse-denorm fan-out (indexed + unindexed), rollup on insert/update/delete,
   cycle rejection, cap, lazy fan-out, tx-atomic rollback. Showcases: buyer rename →
   sales.buyerName; sale insert/delete → buyer.revenueByYear.
6. `features.yaml` + `docs/subsystems/derivations.md`.

Suggested slicing: **Slice 1** = `triggerBy` reverse-denorm (Decisions 1+3);
**Slice 2** = `withRollup` + delete hook (Decision 2). Each is an independent PR.
