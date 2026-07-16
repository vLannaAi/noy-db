# Arc 4 — history at-rest: rewrap history CEKs on tier moves (#712, complete fix)

**Issue:** [#712](https://github.com/vLannaAi/noy-db/issues/712) · recon: task ac10cbac. **Closes #712** (the read-gate shipped Arc 1 / PR #717; this is the at-rest hardening the user chose).
**Predecessors (merged):** the full read+write+index+search campaign (#700/#710/#714/#717/#719/#723/#727).

## The problem

`history()`/`getVersion()` are read-gated (Arc 1: they peek the live record's tier and return empty when elevated). But the prior-version **ciphertext still sits decryptable at rest under the tier-0 DEK**: each `_history/{coll}:{id}:{v}` snapshot carries its **own** `_cek`, AES-KW-wrapped under the collection tier-0 DEK (`record-codec.ts:256-261`), and `elevate()` rewraps only the *live* record's `_cek` — never the history entries. So any tier-0 holder unwraps a history `_cek` → recovers the (shared) CEK → decrypts the prior-version body. The read-gate hides it through the API; the at-rest ciphertext is unprotected, and the gate is bypassable (the #716-class signal erasure). This is the same class the campaign has closed everywhere else: *every `forget()` shred site is an `elevate()` bug* — `forget()` crypto-shreds history (`tombstoneHistory`, `history.ts:182-212`); `elevate()` has no analogue.

## Decision (user-approved: the complete fix): rewrap, don't purge

On a tier move, **rewrap every history snapshot's key material** from the record's current-tier DEK to its new-tier DEK — mirroring what `rewrapBodyToDek` already does for the live body. This is defense-in-depth *beneath* the Arc-1 read-gate: it protects the ciphertext even if the gate is bypassed. Rewrap (not purge like `tombstoneHistory`) is required so `demote()` restores tier-0 readability.

## Design

**Reuse the vetted crypto.** `rewrapBodyToDek` (`kernel/enclave/record-keys/lifecycle.ts:75-89`) consumes only `_iv/_data/_cek` — it applies to a history envelope unchanged. perRecordKeys: unwrap `_cek` under `fromDek`, rewrap under `toDek` (it also re-encrypts the body under the unchanged CEK — a small waste; a leaner `_cek`-only rewrap is a perf follow-up, not this arc). Legacy (no `_cek`): decrypt body under `fromDek`, re-encrypt under `toDek`. Both O(history).

**Uniform hook on all three tier ops.** `elevate`, `demote`, AND `putAtTier` move a record's tier, so all three must carry its history — exactly as they all call `syncSearch`/`syncIndexes`. Each rewraps history `from = the record's tier BEFORE the op → to = its tier AFTER`:
- `elevate(id, toTier)`: from `dekKey(name, fromTier)` → `dekKey(name, toTier)` (`fromTier` = the live envelope's `_tier ?? 0`).
- `demote(id, toTier)`: from `dekKey(name, fromTier)` → `dekKey(name, toTier)`.
- `putAtTier(id, rec, tier)`: from `dekKey(name, existing._tier ?? 0)` → `dekKey(name, tier)`.
Skip when `from === to`. **These are the SAME `fromDek`/`toDek` the live rewrap already computes** — reuse them, don't recompute.

**Why the DEKs track cleanly** (the recon's key finding): history is created *only* by tier-0 `put()` (elevate/demote/putAtTier write no new history — #728), and once we rewrap on **every** move, history stays in lockstep with the live record's tier. So a snapshot's `_cek` is always wrapped under the record's current tier — never a third tier. The `from = current tier` assumption holds for every record elevated *after* this ships.

**Legacy migration (pre-fix records).** A record already at tier N *before* this fix has tier-0-wrapped history (never rewrapped). A first post-fix demote would try `fromDek = tier-N` and fail to unwrap. Handle it in the rewrap primitive: attempt `fromDek`; on unwrap/decrypt failure, retry under the **tier-0** DEK (the only other wrapping a snapshot can have — created tier-0, moved only by tier ops). Output is always wrapped under `toDek`. This is a bounded 2-key write-side fallback (not a cache-dependent read gate), so it does not reintroduce the forbidden try/catch pattern — the fable review should confirm it cannot leak (it changes only which unwrap key is tried; the plaintext never egresses).

**New surface (blast radius LOW-MODERATE, no format change, no `_tier` added to snapshots):**
- `with-commit/history/history.ts`: a `rewrapHistory(adapter, vault, collection, recordId, fromDek, toDek)` sibling of `tombstoneHistory` — list `_history` by prefix `{collection}:{recordId}:`, rewrap each entry via `rewrapBodyToDek` (with the tier-0 fallback), `adapter.put` back at the same id.
- `HistoryStrategy`: a `rewrapHistory` method so `NO_HISTORY` no-ops it (mirroring `tombstoneHistory`, `history/strategy.ts`).
- `TiersContext`: a `syncHistory(id, fromDek, toDek): Promise<void>` callback (doc-commented like `syncSearch`).
- `collection.ts` `tiersContext()`: one wiring line beside `syncIndexes`/`syncSearch` → the history strategy's rewrap.
- `elevate`/`demote`/`putAtTier`: one `await ctx.syncHistory(id, fromDek, toDek)` each, after the live `adapter.put`.

## Interaction with the shipped read-gate

Unchanged. The rewrap touches only `_iv/_data/_cek` on history envelopes — it does NOT add `_tier` to them and does NOT touch the live record's tier — so `liveRecordIsElevated` still fires and `history()`/`getVersion()` still return empty for an elevated record. The two layers are independent; the read-gate's tests read through the live record and are unaffected.

## Constraints

- Ceiling: `collection.ts` **4548** exact — the one wiring line needs a shrink-join. `history.ts`/`tiers/index.ts` have no ceiling. `vault.ts`/`noydb.ts` untouched.
- Zero-knowledge: rewrap resolves key material inside the enclave path only (via `rewrapBodyToDek`, already the sanctioned primitive); no plaintext egress; no `getDEK` auto-mint (the tier DEKs are the same ones the live rewrap resolves, already asserted held by `assertTierAccess`).
- **Coverage gap:** no test reads a `_history` entry's at-rest key after `elevate` (the existing per-record-cek tests assert decryptability *through the shared CEK* — the very property that IS the leak). Tests must: after elevate, assert a raw `_history` envelope's `_cek` no longer unwraps under the tier-0 DEK but does under the tier-N DEK; a cold tier-0-only session cannot decrypt it; demote restores; `putAtTier(>0)` rewraps; the legacy tier-0 fallback works; and the Arc-1 read-gate still returns empty (unchanged).
- Reuse `rewrapBodyToDek` — do NOT hand-roll crypto.
