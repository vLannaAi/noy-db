---
"@noy-db/core": minor
---

Add delta history via RFC 6902 JSON Patch. Every `Collection.put` after the genesis now computes a **reverse** JSON Patch from the new record to the previous version and stores it in the compartment's `_ledger_deltas/` internal collection. The delta is hashed into the ledger entry's new optional `deltaHash` field, linking it to the hash chain from #43.

```ts
const company = await db.openCompartment('demo-co')
const invoices = company.collection('invoices')

// Normal puts — deltas are stored automatically.
await invoices.put('inv-1', { amount: 100, status: 'draft' })
await invoices.put('inv-1', { amount: 150, status: 'open' })
await invoices.put('inv-1', { amount: 150, status: 'paid' })

// Reconstruct any historical version by walking the chain.
const ledger = company.ledger()
const current = await invoices.get('inv-1')
const v2 = await ledger.reconstruct('invoices', 'inv-1', current, 2)
// → { amount: 150, status: 'open' }
```

## Why reverse patches?

Delta storage has two main designs:
- **Forward patches** (prev → next): easy to apply going forward from a base snapshot
- **Reverse patches** (next → prev): easy to apply going backward from the current state

We picked reverse because the current state is already live in the data collection — no base snapshot needed. Walking backward from "now" through reverse patches reconstructs any historical version without duplicating data.

## Storage efficiency

The core property: **storage scales with edit size, not record size**. A 1KB record edited 100 times produces ~100 KB of full snapshots but under 20 KB of deltas (gate in the test suite). The cost is fully proportional to the delta size between consecutive versions, regardless of how much unchanged data the record carries.

## What's new

- **`packages/core/src/ledger/patch.ts`** — hand-rolled RFC 6902 JSON Patch compute + apply. Subset: `add`, `remove`, `replace` (no `move`/`copy`/`test`). Arrays treated as atomic values (whole-array replace). Path escaping (`~0`, `~1`) implemented per spec. Zero deps.
- **`packages/core/src/ledger/entry.ts`** — extended `LedgerEntry` with optional `deltaHash` field. Conditionally included in canonical JSON so `undefined` never leaks through to hashing.
- **`packages/core/src/ledger/store.ts`** — `LedgerStore.append()` accepts an optional `delta` in `AppendInput`, persists it to `_ledger_deltas/<paddedIndex>`, and records its hash. New `LedgerStore.reconstruct(collection, id, current, atVersion)` walks the chain backward and applies reverse patches to reconstruct historical versions. New `loadDelta(index)` helper exposes individual delta payloads.
- **`packages/core/src/collection.ts`** — `Collection.put` computes the reverse patch when there's an existing record and passes it to `ledger.append({ delta })`. Genesis puts (no existing record) and deletes leave the delta undefined.

New exports from `@noy-db/core`:
- Types: `JsonPatch`, `JsonPatchOp`
- Helpers: `computePatch`, `applyPatch`
- Constant: `LEDGER_DELTAS_COLLECTION`

## Known limitations

- Reconstruct is ambiguous across delete+recreate cycles because `version` restarts at 1 after a delete. Users needing unambiguous historical access should use ledger index-based queries (planned for v0.5).
- The legacy `_history` collection (full snapshots) is still maintained alongside deltas. Switching the default and deprecating `_history` is a follow-up.
- `pruneHistory({ keepLast: N })` — folding old deltas into a base snapshot — is deferred to a follow-up PR.
- Grant/revoke/rotate operations are not yet recorded in the ledger (only put/delete). Also a follow-up.

Closes #44, part of #41.
