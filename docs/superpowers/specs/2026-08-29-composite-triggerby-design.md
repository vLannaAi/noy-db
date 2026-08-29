# Composite `triggerBy` — multi-field match for derivation fan-out (#1249)

**Status:** approved design, pre-implementation
**Issue:** #1249 (pilot-1, via niwat) · **Service:** `with-formula/derivations` (`withDerivation`)
**Date:** 2026-08-29

## 1. Problem

`triggerBy: { collection, on }` fans a write to a parent collection out to every
source record where `source[on] === writtenParent.id`. That reaches exactly one
relationship shape: a single FK on the source pointing at the trigger
collection's **primary key**.

The pilot has derivations whose staleness relationships are not that shape:

1. **Composite key** — a `disbursements` write affects the bills for that
   `(clientId, cycle)` pair. Two fields, neither of which is the written
   record's id.
2. **Shared key (reverse match)** — a `clients` write affects bills where
   `client.entityId === bill.entityId`: both sides carry the same foreign
   field; neither side's *id* participates.

Today these need either an app-level poke (`touchAffected(clientId, cycle)` — a
convention a future caller silently forgets) or denormalising the composite
into one string field that doubles as another collection's primary key (works,
verified on the issue, but forces the key shape onto the data model and needs
the denormalised field kept in sync with its parts).

The pilot confirmed the ask is the **without-denormalising** form and named
five distinct `(entity, period)` surfaces across unrelated statutory
obligations (payroll WHT, self-WHT, statutory close, coverage, billing) — this
is an addressing scheme common to financial consumers, not one feature's quirk.

## 2. Verified code facts the design rests on

Checked against `packages/hub/src/with-formula/derivations/` and
`packages/hub/src/kernel/collection.ts` at `main` @ `45d3286f`:

- `dispatch.ts:192-224` — the trigger path calls
  `srcColl._findMatchingIds(trigger.on, id)` where `id` is the **written
  parent's id**; caps at `maxFanout`; re-derives each matched source record.
- `collection.ts:2206` `_findMatchingIds(field, value)` — equality-index hit
  (`withIndexing`) or scan; **scalar-only** comparison
  (`String(fv) === String(value)`; object/array fields never match).
- `dispatchDerivations(ctx, id, record, version)` receives only the **new**
  record. No prior record is threaded in — but the put path already reads the
  prior envelope (`trackPut(txCtx, …, priorEnvelope)`), so prior plaintext is
  one cache read (non-lazy) or one decrypt (lazy) away.
- **Parent deletes never fire `triggerBy` today.** The delete path
  (`collection.ts:2658`) runs only `dispatchArrayDerivationsOnDelete` (array-
  output sidecar cleanup). A deleted parent leaves matched sources stale even
  under the existing single-key form — a pre-existing gap this design closes
  for both forms.
- `triggerBy` collections register in the registry's `_bySource` and
  participate in cycle detection (`types.ts` JSDoc, confirmed in registry).

## 3. Decisions (user-approved 2026-08-29)

1. **Keep `on` alongside `match`.** `on` is the ergonomic FK case, not a
   legacy wart. Internally it normalises to `match: [{ from: 'id', to: on }]`
   so dispatch has ONE code path.
2. **Union fan-out on update.** When an update to a trigger collection changes
   a matched `from` field, fan out on old-match ∪ new-match. Without this the
   feature ships a silent-staleness hole of exactly the class the pilot filed.
3. **Delete fan-out, both forms.** Fires field-match AND id-match triggers on
   parent delete, using the tombstoned record's values. Fixing it only for the
   new form would leave the old form as the documented-but-wrong half.

## 4. API surface

`packages/hub/src/with-formula/derivations/types.ts`:

```ts
triggerBy?: ReadonlyArray<
  | { collection: string; on: string; maxFanout?: number }        // unchanged
  | {
      collection: string
      /**
       * Conjunction of equality pairs: a source record matches when EVERY
       * pair satisfies String(source[to]) === String(written[from]).
       * `from: 'id'` reads the written record's id; any other `from` reads
       * the written record's field. `to` always names a source field.
       */
      match: ReadonlyArray<{ from: string; to: string }>
      maxFanout?: number
    }
>
```

Construction-time validation in `with-derivation.ts` (extending the existing
checks):

- exactly one of `on` | `match` per entry — both or neither throws;
- `match` non-empty; every `from`/`to` a non-empty string;
- no duplicate `to` within one entry (two pairs writing the same source field
  is a contradiction, not a wider match);
- `collection` non-empty and `!== source` (existing rule, unchanged).

**Normalisation:** immediately after validation, every entry is stored
internally in `match` form (`on` → `[{ from: 'id', to: on }]`). All dispatch,
registry, and cycle-detection code operates on the normalised form only. The
public type keeps both shapes; nothing downstream ever branches on which the
author wrote.

## 5. Match semantics

- A source record matches an entry when **all** pairs hold, using the exact
  scalar coercion `_findMatchingIds` uses today: both sides must be
  `string | number`, compared as `String(a) === String(b)`. A missing or
  non-scalar value on either side fails that pair (and so the conjunction).
- `from: 'id'`: the written record's id (the dispatch `id` parameter — which
  wins over any stored field named `id`, matching the `{ ...incoming, id }`
  convention already used on the source path).
- A written record whose `from` fields are all absent matches nothing. This is
  a legitimate query result, not an error — but see the typo guard.

### The typo guard (the #1220 / #1253 lesson)

A misspelt `to` or `from` field silently matches nothing forever — the exact
phantom-config class #1253 just fixed for `fieldMeta`. Same remedy, same
posture:

- **When:** at strategy **registration** — the earliest point where both the
  source and trigger collections exist (construction is pure config; the
  collections are not in hand).
- **What:** every `to` is checked against the source collection's enumerable
  field set; every `from` (≠ `'id'`) against the trigger collection's. The
  field set comes from the same capability probe #1253 shipped
  (`schemaFieldKeys` — `schema.shape`, Zod 3 and 4) union the collection's
  config-declared fields.
- **Outcome:** provably-unknown field → throw at registration (fail-loud,
  before any write can go stale). Field set not enumerable (TS-generic
  collection, unreadable validator) → **deliberately silent** — the case
  #1253 proved must not be guarded, because those fields are real and
  unenumerable.

## 6. Fan-out query

New internal on `Collection`:

```ts
_findMatchingCompositeIds(pairs: ReadonlyArray<{ field: string; value: unknown }>): Promise<string[]>
```

- If any pair's field has an equality index (`withIndexing`), take that pair's
  candidate id set from the index, then filter candidates by reading each
  record and evaluating the remaining pairs. (First indexed pair wins;
  selectivity is unknowable without statistics, and one index probe plus a
  filter is already O(candidates).)
- Otherwise: **one** scan — hydrated-cache iteration (non-lazy) or
  adapter-list + `_getStoredRecord` (lazy) — evaluating the full conjunction
  per record. Never one scan per pair.
- `_findMatchingIds(field, value)` remains and delegates to the composite form
  with one pair (single implementation; existing callers untouched).

## 7. Union fan-out on update

- `DerivationDispatchCtx` gains `getPrior?: () => Promise<Record<string, unknown> | null>`
  — a **lazy thunk** built at the put call site: non-lazy collections snapshot
  the cached plaintext before the write; lazy collections decrypt the prior
  envelope already read for CAS. The thunk is invoked at most once per
  dispatch and **only** when a registered trigger on the written collection
  has a pair with `from !== 'id'`.
- Trigger path per entry: compute the new value tuple from the written record.
  If any `from !== 'id'`, resolve the prior record. On a create (prior
  `null`) only the new tuple exists — no union. On an update, compute the old
  tuple; when it differs from the new one, evaluate the match for both tuples
  and union the matched id sets, deduped (a tuple with a missing/non-scalar
  value simply matches nothing, per §5). `from: 'id'`-only entries never
  resolve the prior (ids are stable).
- Each matched source record re-derives once per event even when matched by
  both tuples.

## 8. Delete fan-out

New dispatch entry invoked from the delete path beside
`dispatchArrayDerivationsOnDelete` (`collection.ts:2658`):

```ts
dispatchTriggerDerivationsOnDelete(ctx, id, priorRecord)
```

- Runs every strategy whose normalised `triggerBy` names the deleted
  collection: pairs evaluate against the **tombstoned record's** values
  (`from: 'id'` → the deleted id; field pairs → the prior record's fields).
- Matched sources re-derive through the normal executor: their `derive` reads
  the now-absent parent via `ctx.vault` and computes whatever that means for
  them (the engine re-fires; it never cascades deletes — what a missing parent
  means is the derivation's business).
- `lifecycle: 'lazy'` marks stale, exactly like the write path. `maxFanout`
  applies. Wave/cycle context is threaded the same way as the write path.
- **No new read — verified:** the delete path already holds the deleted
  plaintext and passes it to `dispatchRollupsOnDelete(id, existing.record)`
  (`collection.ts:2664`); the new hook takes the same argument, beside it.
- **Distinct from the existing "not dispatched on delete" rule:** the comment
  at `collection.ts:2651` says record-shape derivations are intentionally NOT
  dispatched when a **source** record is deleted (the user deletes the
  same-id output directly). This design fires when a **trigger parent** is
  deleted, re-deriving source records that still exist — a different event.
  The comment stays true; the implementation must not "unify" the two.

## 9. Caps, errors, cycles

- `maxFanout` caps the **unioned** matched set per written event.
  `DerivationCapExceededError` is reused; its label names the pairs
  (`triggerBy disbursements→bills [clientId,cycle]`).
- Cycle detection: normalised entries register in `_bySource` identically to
  today — the collection name is what cycles are detected on; the match shape
  is irrelevant to reachability. No changes needed beyond registering the new
  form.

## 10. Considered and rejected

| candidate | why not |
|---|---|
| Arbitrary-predicate `triggerByQuery` | Unbounded, unindexable, invites scan-by-default; equality conjunction covers every case presented |
| OR-of-conjunctions within one entry | The `triggerBy` array is already an OR of entries |
| Inequality / range pairs | No use case presented; equality is the FK grammar |
| Automatic reverse-relationship detection | Magic; the author states the pairs |
| Engine-side cascade on parent delete | What a missing parent means belongs to `derive()` |
| Folding in the **rollup re-parent gap** (a child whose `key` field changes strands the old parent's aggregate — same class, different dispatch branch) | Doubles this design's surface; gets its own issue filed during implementation |
| Denormalised-key pattern as the answer | Works (verified on the issue) but forces key shape onto the data model; kept documented as the zero-upgrade workaround |

## 11. Testing

Vitest, beside the existing derivation suites. Every test that proves a fire
also has a non-fire control in the same file.

1. **The pilot's three cases** as integration tests: composite
   `(clientId, cycle)` disbursements→bills; shared-key `entityId`
   clients→bills; `on` sugar unchanged (a buyer rename refreshing sales).
2. **Normalisation equivalence:** `on: 'buyerId'` and
   `match: [{from:'id',to:'buyerId'}]` produce identical fan-out for the same
   writes.
3. **Union on update:** a disbursement moving Q1→Q2 re-fires BOTH the old and
   new bill sets — **mutation-checked**: disabling the prior-tuple branch must
   fail this test and leave the others green.
4. **Delete fan-out, both forms:** deleting a disbursement re-fires matched
   bills; deleting a buyer re-fires their sales (the pre-existing gap's
   regression test).
5. **`maxFanout` on the union:** old set + new set crossing the cap throws
   before any write; either set alone under the cap passes.
6. **Typo guard:** unknown `to` on a schema'd source → registration error;
   the same config on a TS-generic (unenumerable) source → silent (control).
7. **Index vs scan equivalence:** same matched set with and without
   `withIndexing` on a pair field.
8. **Lazy lifecycle:** the `markStale` set equals the eager-mode fan-out set
   for the same event.
9. **Cycle detection** through a `match` entry (a source that is also a
   trigger output is detected exactly as with `on`).
10. **Scalar coercion edges:** number/string cross-matching; absent field
    matches nothing; object-valued field matches nothing.

## 12. Documentation obligations

- `types.ts` JSDoc (ships in the `.d.ts`) — full semantics: conjunction,
  `from: 'id'`, coercion, union-on-update, delete fan-out, the typo guard's
  silent-when-unenumerable posture, and the denormalised-key pattern as the
  still-valid alternative.
- The derivations subsystem doc (`docs/subsystems/`) gains the three
  relationship shapes with the pilot's (anonymised) cases.
- `check:prose-examples` covers any fenced example added.
- Answer on #1249 when it lands; the feature-registry entry
  (`features.yaml` in noy-db-docs) is coordination work routed at release
  time per the family process.

## 13. Constraints

- `collection.ts` sits at its 4318-line kernel-surface ceiling — the delete
  hook and prior-thunk additions there must be offset (shrink-first), with the
  bulk of new logic living in `dispatch.ts` / a new `trigger-match.ts` beside
  it.
- No new persisted state: match evaluation is entirely read-side. (The array
  fan-out sidecar is unrelated and untouched.)
- Bundle-size gate: dispatch growth is modest; the normalisation and match
  helpers tree-shake with the service as today.
- Changeset: `@noy-db/hub` **minor** (additive API).
