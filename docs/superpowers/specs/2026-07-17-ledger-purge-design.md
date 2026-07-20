# Arc 8 — ledger purge on elevate (#729)

**Issue:** [#729](https://github.com/vLannaAi/noy-db/issues/729) · recon: task a5738732. **Owner decision (2026-07-16): PURGE deltas on elevate.**
**Predecessors:** the tier campaign (#700…#712/#721/#723/#727/#731) + the Arc-7 composition guard.

## The problem (recon-confirmed; #729's "rewrap like #712" framing is wrong)

The audit ledger is a **flat, vault-wide, tamper-evident hash-chained log**. A record's tier-0-era **plaintext reverse-JSON-Patch deltas** are stored in `_ledger_deltas/<paddedIndex>` (`ledger/store.ts:320-333`), encrypted **directly under one flat `_ledger` collection DEK** (`store.ts:380`) — held by every keyring holder. `elevate()` never touches them, so an elevated record's pre-elevation deltas stay readable at rest by any tier-0 caller, and ride into every `dump()` backup verbatim (`vault.ts:3593`).

**The #712 rewrap cannot apply:** deltas have no per-record `_cek`, they're under one flat vault-wide key, and each delta's ciphertext is bound into the chain via `deltaHash = sha256(deltaEnvelope._data)` — re-encrypting would change the hash and break `verify()` for that entry and every later one. (`forget()` has the identical gap — filed as #734, a separate PR reusing this arc's primitive.)

## Decision: purge the record's deltas on elevate

On a move to tier > 0, **delete the record's `_ledger_deltas/<index>` rows.** Chain-safe: `verify()` (`store.ts:606`) recomputes the chain from each **entry's** canonical fields — including the stored `deltaHash` **field**, which lives on the entry, not on the deleted delta row — and **never re-reads `_ledger_deltas`. So deleting a delta leaves `verify()` fully valid.** `reconstruct` (`store.ts:493`) already treats a missing delta (`loadDelta → null`, `store.ts:352`) as a pruned stop (`store.ts:544-559`).

**Accepted trade-offs (owner-approved):**
- **Irreversible** — `demote()` cannot restore delta reconstruction (the plaintext is gone). Elevating permanently erases the plaintext of a record's pre-elevation audit deltas.
- **Entry metadata remains** — the `_ledger/<index>` entries (that record X was mutated, at which versions/timestamps/actors, plus `deltaHash`) stay in the chain; removing them would break tamper-evidence. Only the delta **plaintext content** is purged, not the audit record that a change occurred.

## Design

**The primitive** (`LedgerStore`, `ledger/store.ts` — no ceiling): 
```ts
/** Purge a record's tier-0-era plaintext deltas (#729). Deletes each
 *  `_ledger_deltas/<index>` row whose entry matches (collection, id) and
 *  carries a delta. Chain-safe: `verify()` reads only entry fields (the
 *  `deltaHash` lives on the entry), never the delta rows; `reconstruct`
 *  treats a missing delta as a pruned stop. Returns the count purged. */
async purgeRecordDeltas(collection: string, id: string): Promise<number>
```
Implementation: `loadAllEntries()` (`store.ts:398`), filter `e.collection === collection && e.id === id && e.deltaHash !== undefined`, `adapter.delete(vault, LEDGER_DELTAS_COLLECTION, paddedIndex(e.index))` each, return the count. No entry is touched; no re-encryption; the chain is untouched.

**The hook.** `TiersContext.syncLedger(id): Promise<void>` (doc-commented like `syncHistory`), wired in `collection.ts` `tiersContext()` (`~:4504-4521`) to `this.ledger?.purgeRecordDeltas(this.name, id)` (the ledger is on the Collection at `collection.ts:668`; `undefined` when no ledger → the `?.` no-ops). Called by `elevate` and `putAtTier(tier > 0)` — i.e. whenever the record lands at tier > 0. **Not** called by `demote` or `putAtTier(0)` (nothing to restore — irreversible; and a tier-0 record's deltas are fine). Idempotent: purging already-purged deltas is a no-op scan, so redundant calls are harmless. Placed **after** the live `adapter.put` (the #691 ordering rule) — ledger-purge has no dependency on the other sync hooks, but for consistency it runs in the same "after put" block.

**Interaction with the read path.** The owner chose purge only, not a read-gate. So `vault.ledger()`/`loadDelta`/`entries` stay ungated — after a purge, `loadDelta` for a purged index returns `null` (pruned) and `entries()` still lists the (metadata-only) entries. That is the intended residual (metadata remains; plaintext is gone). No read-gate this arc.

## Constraints

- Ceiling: `collection.ts` **4548** exact — the one `syncLedger` wiring line needs a mechanical shrink-join. `store.ts`/`tiers/index.ts` have no ceiling. `vault.ts`/`noydb.ts` untouched (the forget-side #734 is a separate PR).
- Zero-knowledge: purge deletes ciphertext rows and resolves **no tier key material**. It decrypts only the `_ledger` entry metadata (under the ledger's own DEK the caller already holds) to filter by `(collection, id)` — never a tier DEK, a record CEK, or a delta payload; the deleted delta rows are never opened.
- **Chain integrity is the invariant to protect:** every test must assert `ledger.verify()` returns `{ok: true}` after a purge. A purge that breaks `verify()` is a Critical failure.
- **Coverage gap:** no test combines tiers with the ledger's delta-reconstruction. Tests must: after `elevate`, the record's `_ledger_deltas` rows are gone from the store; `verify()` still passes; `reconstruct` can no longer recover the pre-elevation plaintext (returns the pruned/current state, not the old fields); a sibling record's deltas are untouched; `putAtTier(>0)` also purges; a non-elevated record keeps its deltas; and (the audit-preserved half) `entries()` still lists the record's mutation metadata after the purge.

## Tests reference

Base the fixture on `__tests__/history-at-rest.test.ts` / `per-record-cek.test.ts` (they compose `withHistory()` — which enables the ledger — with `withTiers()` + tiers), and inspect raw `_ledger_deltas` rows via `store.get(vault, '_ledger_deltas', paddedIndex)`. Grep an existing ledger test (`__tests__/*ledger*`) for the `vault.ledger()` / `loadDelta` / `reconstruct` / `verify` call shapes and the `paddedIndex` helper.
