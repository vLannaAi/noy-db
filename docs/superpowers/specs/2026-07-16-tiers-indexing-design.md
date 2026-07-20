# Arc 2 — tiers × indexing: elevated records leave tier-0 indexes (#709)

**Issue:** [#709](https://github.com/vLannaAi/noy-db/issues/709) — see [this comment](https://github.com/vLannaAi/noy-db/issues/709#issuecomment-4988327097) for the full file:line-anchored recon; the issue's original text is wrong on one claim and misses the headline.
**Predecessors (merged):** #700/#710/#714/#717 (read surface) + #719 (write ring — no public tier-0 path can demote or erase `_tier`).

## The problem

**Headline (absent from the issue): persisted index sidecars leak an elevated record's plaintext field value, at rest.**
`with-lookup/indexing/collection-facade.ts:370-377` stores each sidecar `_idx/<field>/<recordId>` as `{field, value: serializeIndexValue(v), recordId}` — and `serializeIndexValue` (`:87-90`) only ISO-izes Dates; **every other value passes through verbatim**. It is encrypted via `encryptJsonString` → `record-codec.ts:257` `getDEK()` → `dekKey(name, 0) === name` — i.e. **always under the tier-0 DEK**, whatever the record's tier. `elevate()` never touches it.

So with **no facade call at all**: `put('emp-1', {salary: 200000})` → `elevate('emp-1', 1)` → any tier-0 caller decodes `_idx/salary/emp-1` (`collection.ts:4230-4237`, ungated) and learns **the exact value and the owning id**. Elevating a record never hid its indexed field values.

**The codebase already recognized this exact leak class — for `forget()`** (`collection-facade.ts:426-429`): *"`forget()` crypto-shreds the body but keeps the collection DEK, under which these side-cars are encrypted — so without this they leave the indexed field VALUES readable after a 'forget'."* `purgePersistedIndexes` exists **because of it**. The same reasoning was never applied to `elevate()`. That precedent is both the severity argument and the fix shape.

**Amplifiers:** `rebuildIndexes` (`:203-209`) and `reconcileIndex` (`:279-281`) decrypt every canonical envelope ungated → warm cekCache **mints a fresh tier-0 sidecar from an elevated record** (a warm leak that materializes into a permanent at-rest one; `reconcileIndex` will even **re-create a sidecar someone deleted**), cold session **throws** and bricks the operation.

**Correctness (not a leak):** the eager path is cache-mediated (`builder.ts:1179-1188` → `collection.ts:3307` `lookupById` → the elevated-free cache), so a stale entry resolves to `undefined`. But index hits are **never re-verified** (the clause is dropped from the post-filter, `builder.ts:1160-1166`), so `putAtTier(id, rec, 0)`'s stale entry is a **silent false positive**.

**Not a problem:** `uniqueConstraints` + tiers is already **refused at registration** (`unique-constraints.ts:158-163`) — the issue's claim there is impossible.

## Decision (user-approved 2026-07-16): purge on elevate, restore on demote

**Elevated records are simply not present in tier-0 indexes** — the indexing expression of the invisibility law, and a direct mirror of the `forget()` → `purgePersistedIndexes` precedent.

| Op | Index action |
|---|---|
| `elevate(id, N>0)`, `putAtTier(id, rec, N>0)` | **Purge** the record's `_idx/*/<id>` sidecars **and** drop its in-memory index entries |
| `demote(id, 0)`, `putAtTier(id, rec, 0)` | **Rebuild/maintain** entries from the (now tier-0) record — also fixes the stale-entry false positive |
| `rebuildIndexes` / `reconcileIndex` facade loops | **Skip** elevated envelopes *before* the decrypt — kills the warm mint and the cold brick |

**Rejected — refuse `indexes` + `tiers`** (mirroring the unique refusal): consistent, but removes a working combination instead of fixing it; non-unique indexes are a query optimization, not a correctness constraint. **Deferred — tier-scoped sidecars** (encrypted under the tier DEK so cleared callers can still query elevated records): a real future option, not needed to close the leak.

**Consequence, intended:** an elevated record is unindexed and therefore not findable by *any* index-driven query, including from a session holding its tier DEK. `getAtTier`/`listAtTier` remain the tier-aware read surfaces. Document it.

## Design

Everything needed already exists — this is wiring, not invention:
- `purgePersistedIndexes(ctx, id)` (`collection-facade.ts:437`) — the forget path's purge; already wrapped on Collection (`collection.ts:47`).
- `maintainPersistedIndexesOnPut(ctx, id, newRecord, previousRecord, version)` (`:337`) — already wrapped (`collection.ts:45`, called at `:2065`).
- `this.indexes?.upsert(id, record, prior)` / `?.remove(id, record)` (`collection.ts:2070`, `:2789`).

`TiersContext` gains **one callback**, mirroring the established `syncCache` pattern (`collection.ts:4517`):

```ts
/** Sync the collection's indexes after a tier move (#709). `null` → the record left
 *  tier 0: purge its persisted sidecars (they hold PLAINTEXT field values under the
 *  tier-0 DEK — see purgePersistedIndexes' forget() precedent) and drop its in-memory
 *  entries. A record → it is tier-0 again: (re)build its entries from that record. */
syncIndexes(id: string, record: T | null): Promise<void>
```

Wired in `tiersContext()`; called by `elevate`/`demote`/`putAtTier` **after** their `adapter.put` lands (same ordering rule #691 established for `syncCache`: never blind the caches for a write that then throws).

The facade gate is the campaign's standard fold: `if ((envelope._tier ?? 0) > 0) continue` **before** `decryptRecord`, at both loops.

## Constraints

- Ceiling: `collection.ts` **4548** exact (checker 4549). Expect ~+2 (the `syncIndexes` wiring line + any import) → fund with mechanical shrink-joins. Never edit ceiling values; `vault.ts`/`noydb.ts` untouched. `collection-facade.ts` and `tiers/index.ts` have no ceiling.
- Zero-knowledge invariant: the facade gate resolves **no** key material (envelope peek); the demote rebuild decodes only a record already at tier 0.
- Cost: purge/rebuild only runs on tier moves, and `syncIndexes` must no-op fast when the collection has no indexes.
- **Coverage gap to close:** no test anywhere combines `tiers:` with `indexes:` — the entire exposed configuration is untested. Tests must cover lazy (sidecars exist) *and* eager (in-memory only).
