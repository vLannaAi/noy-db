# #306 — Record-scoped sealing (design + spec)

> Status: **SHIPPED** (2026-06-30) — all three slices merged to `main`. Slice A `f97c64b4` (rotateRecordCek `_sealed` data-loss fix); Slice B `03929256` (CEK-derived sealing + dual-read so `forget()` crypto-shreds sealed fields); Slice C `56d747ce` (ledger `payloadHash` binds `_sealed` — back-compat, `_cek` excluded). Each was TDD'd and adversarially reviewed; the dual-read legacy-record data-loss guard is pinned by `__tests__/sealed-fields-cek-derived.test.ts`. Release note: `.changeset/record-scoped-sealing.md`. The text below is the original design (2026-06-29), kept for the rationale; one in-flight decision changed during implementation — Slice C covers `_data + _sealed` only, NOT `_cek` (a tampered `_cek` self-detects, and `rotateRecordCek` rewrites it with no ledger entry).

## Problem

Sealed (`sensitive`) fields are encrypted into `_sealed[field]` under a key derived **from the collection DEK**: `deriveSealedFieldKey(dek, collection, field)` (HKDF salt `'noydb-sealed'`, info `['noydb-sealed', collection, field]`, `crypto.ts:469`). That key is **identical for every record** and for all time. So `vault.forget(subject)` — which tombstones the live envelope (dropping `_sealed`, `_data`, `_cek`) but **never drops the collection DEK** — does NOT cryptographically erase a record's sealed fields: anyone holding the collection DEK + an old `_sealed` ciphertext (from a pre-forget backup/snapshot) can re-derive the key and decrypt.

The codebase already flags this. `collection.ts:1088` warns at construction when `sensitive` + `perRecordKeys` are both set:
> "sealed `sensitive` fields derive off the collection DEK and are NOT covered by per-record crypto-shred (#304) until record-scoped sealing (#306) — forgetting a record leaves its sealed fields recoverable."

`perRecordKeys` already gives each record a fresh per-record CEK, AES-KW-wrapped under the collection DEK on `_cek`, **stable across versions** (`record-keys/lifecycle.ts:40` `resolveStableCek`; wrap domain `'noydb-cek-wrap'`, `crypto.ts:153`). #306's idea: derive the sealed-field key from the **per-record CEK** instead of the collection DEK, so dropping `_cek` (which `forget` already does) makes `_sealed` irrecoverable from the live store — the same erasure guarantee `_data` already has.

## Decisions (recommended; confirm before Slice B)

- **D1 — Opt-in, automatic when both flags set.** When a collection sets BOTH `sensitive` and `perRecordKeys`, derive sealed-field keys from the per-record CEK. No new option (the existing `console.warn` becomes obsolete and is removed). Rationale: the warning already tells users this combination is the #306 path; making it "just work" is the least-surprising fix. (Alternative considered: a separate `sensitiveFromCek` flag — rejected as redundant ceremony.)
- **D2 — Reuse the HKDF with a distinct domain.** Add `deriveSealedFieldKeyFromCek(cek, collection, field)` with salt `'noydb-sealed-cek'` (distinct from `'noydb-sealed'`) so the two derivation contexts can never collide. (`crypto.ts`.)
- **D3 — Envelope shape unchanged.** `_sealed: Record<string,string>` stays; only the key material changes. No new slot, no format-version bump for Slice B. (The `_sealed_keys`-wrapped-per-CEK alternative is heavier and unnecessary.)
- **D4 — Mandatory dual-read.** The read path tries the CEK-derived key first (when `_cek` present + sensitive), falling back to the collection-DEK key for legacy `_sealed`. **This is non-negotiable** — without it, every existing sealed record becomes unreadable (R1, below). New writes use the CEK derivation; legacy records migrate lazily on next `put()`.
- **D5 — Erasure scope is honestly bounded.** Slice B improves erasure to match `_data`: after `forget`, an adversary with old `_sealed` ciphertext but NOT the old `_cek` cannot recover the value. An offline backup taken before forget that captured BOTH `_sealed` AND `_cek` is still recoverable by a collection-DEK holder — same caveat as `_data`. The spec/doc must state this; #306 does not claim more.

## Slices

### Slice A — safe, land now (a real data-loss bug fix, independent of the rest)
**`rotateRecordCek` drops `_sealed` (silent data loss).** `record-keys/sealing.ts:153-154` builds the rotated envelope carrying `_tier` and `_det` but NOT `_sealed`. Rotating a CEK on a `sensitive` collection silently loses the sealed values. Today `_sealed` is collection-DEK-derived (a CEK rotation doesn't invalidate it), so the fix is to **carry `_sealed` forward** verbatim:
```ts
...(live._sealed !== undefined ? { _sealed: live._sealed } : {}),
```
+ a regression test (`sensitive` + `perRecordKeys` → put → rotateRecordCek → reveal() still returns the value). Pure additive, no derivation change. **Shipped as its own PR.**
> Note: once Slice B lands (sealed keys CEK-derived), `rotateRecordCek` must RE-ENCRYPT `_sealed` under the new CEK rather than carry it forward. Slice A's carry-forward is correct only while sealed is collection-DEK-derived; Slice B updates it.

### Slice B — the core #306 (runtime crypto; supervised go-ahead)
1. `deriveSealedFieldKeyFromCek(cek, collection, field)` in `crypto.ts` (salt `'noydb-sealed-cek'`).
2. `encryptRecord` (`collection.ts:5086`): when `perRecordCek && cek !== undefined`, derive sealed-field keys from the CEK.
3. `unsealField`/`makeSealedHandle`/`decryptRecord` (`collection.ts:5555` + the read path): thread the per-record CEK (already unwrapped from `_cek` in `decryptRecord`) into sealed-field decryption; **dual-read** fallback to the collection-DEK key for legacy `_sealed` (D4). `makeSealedHandle` must capture the CEK at read time (handles are point-in-time — see R4).
4. `rotateRecordCek`: re-encrypt `_sealed` under the new CEK (supersedes Slice A's carry-forward).
5. Remove the `collection.ts:1088` `console.warn`; extend `ForgetResult` with a `sealedFieldsShredded` count.
6. Tests: `sensitive + perRecordKeys + forget()` → sealed fields unreadable from the live store; dual-read of legacy records; rotateRecordCek round-trips `_sealed`; warning no longer fires.

### Slice C — deferred epic (NOT part of #306 proper)
Extend `envelopePayloadHash` (`history/ledger/hash.ts:24`, currently `sha256Hex(_data)` only) to also cover `_sealed`/`_cek`, so the ledger attests to sealed-field tamper/erasure. **This is a breaking ledger-format change** (every existing `payloadHash` becomes invalid) → needs a ledger format-version bump + flag-day, a separate epic. Today `_sealed` tamper is not chain-detectable (R3).

## Risks (verified)
- **R1 (data loss):** switching the read path to CEK derivation without the dual-read fallback makes all existing `_sealed` records throw `TamperedError`. Dual-read (D4) is mandatory until a migration pass runs.
- **R2 (data loss, FIXED by Slice A):** `rotateRecordCek` currently drops `_sealed`.
- **R3 (chain):** extending the ledger hash is breaking → Slice C, separate.
- **R4 (handle staleness):** a `Sealed` handle captures the CEK at read time; if the record is CEK-rotated while the handle is live, `reveal()` throws. Document handles as point-in-time, or add re-read-on-failure.
- **R5 (scope honesty):** see D5 — pre-forget backups holding both `_sealed` + `_cek` remain recoverable; state it.

## Test-coverage gap to close
No existing test combines `sensitive` + `perRecordKeys` + `vault.forget()` and asserts sealed-field erasure/residue. Slice B adds it; it also regression-pins the warning removal.
