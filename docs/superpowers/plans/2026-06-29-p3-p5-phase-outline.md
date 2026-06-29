# P3–P5 — phase outline (storage-architecture epic)

> Executable task breakdowns for the phases after P2. The detailed design is in the spec:
> `docs/superpowers/specs/2026-06-28-edge-crypto-storage-architecture.md`. Each phase is its own
> plan→subagent→PR cycle. **Universal safety rule:** every phase is additive and **default-off** —
> a collection that declares no sensitive fields and leaves `ramCiphertext` false behaves
> **byte-identically to today**; the full suite stays green after every task.

---

## P3 — per-field group-encryption + `Sealed<V>` type-enforcement

**Spec:** §4.1 (layout), §4.2 (API + types), §6.2 (erasure). **Depends on:** P2 (the `StoreEdgeCodec` seam + `ramCiphertext`/`storeCiphertext` split).

**Safety framing:** group-encryption with **zero declared sensitive fields** = today's whole-record encryption (open group = all fields, no `_sealed`). Divergence happens *only* when a field is declared sensitive. So P3 is safe-by-default.

**Tasks:**
- **T1 — field-classification declaration.** Add `sensitive?: (keyof T)[]` to the collection options (beside the Standard-Schema validator). Plumb to the Collection. No runtime behavior yet (just stored). Test: option accepted, default empty. *Behavior-preserving.*
- **T2 — group-encryption in the codec.** Extend `StoreEdgeCodec.encodeForStore`: partition the record into the **open group** (non-sensitive fields → `_data`, as today) and **sealed fields** (each sensitive field → `_sealed[field]` under its own per-field CEK — HKDF(recordCEK, field) when no independent forget needed, standalone wrapped CEK when it is). `decodeFromStore`: decrypt `_data`; for sealed fields, return them as **handles**, not values. **With `sensitive: []` the `_sealed` map is empty and output is identical to today** (assert byte-identity in a test). Per §4.1.
- **T3 — `Sealed<V>` handles + `reveal()`.** `get()` types sensitive fields as `Sealed<V>` (not `V`); `await rec.reveal('ssn')` unwraps that field's CEK and decrypts `_sealed['ssn']` transiently (byte path; zeroize after). Test: a sensitive field is a handle by default, `reveal()` returns the value, and the value never appears in `JSON.stringify(rec)`.
- **T4 — per-field forget + ledger coverage.** `forget(id, field?)` drops a field's CEK (record bytes retained → chain intact, §6.2). Make `envelopePayloadHash` cover `_data` + `_sealed` + `_det`. Test: drop one field's CEK → that field undecryptable, others intact, ledger `verify()` still passes.
- **T5 — compile-time enforcement (`Collection<T, Q, S>`).** Derive `Q` (queryable = indexed) and `S` (sensitive) from declarations; type `where`/`orderBy` to `Q`, `index()` to `Exclude<keyof T, S>`, `.scan(r => …)` to `Omit<T, S>`. *Type-only — no runtime change; verify with type-tests (`tsconfig.typetest.json`).* Per §4.2.

**Risk note:** T2 (the codec split on the hot path) and T4 (ledger hash change) are the delicate ones — gate hard on full-suite-green + byte-identity tests; review with the most capable model.

---

## P4 — query routing + order-statistics index

**Spec:** §5.1 (routing), §5.2 (ordering). **Depends on:** P3 (field classes) for the sensitive-field routing; the order-statistics index is independent and can land first.

**Tasks:**
- **T1 — order-statistics ranking index (independent, no crypto).** A balanced order-statistics tree (or indexed skip-list): `insert`/`delete` O(log n) without rewrite, plus `rank(key)`/`select(k)` from subtree sizes. Pure data structure — full TDD (insert/delete/rank/select/duplicate-keys/balance). New module under `src/lookup/indexing/` (or `src/indexing/` on main's layout). *Additive; no behavior change to existing query paths.*
- **T2 — `orderBy` routes to the order-statistics index.** When a field has an order index, `orderBy(field)` uses `select(offset)` + rank-order read (no full materialization). Falls back to today's path otherwise. Test: ordered pagination returns correct windows, O(log n) updates.
- **T3 — query planner: access-path + residual.** Plan a `where`/`orderBy` chain: pick the most selective indexed/SSE predicate → decrypt only candidates' non-sensitive fields → residual-filter in plaintext. Per §5.1.
- **T4 — `.scan()` + refuse-by-default.** Type un-indexed `where` as a compile error (field ∉ `Q`); add explicit `.scan(r => …)` (transient decrypt-all in bounded zeroized batches; type-blocks sensitive fields). Streaming top-K for `.scan().orderBy().limit(K)` (bounded heap). Per §5.2.

---

## P5 — SSE / store-usable blind index (encrypted search)

**Spec:** §9, plus the architecture-survey research (deterministic / blind index / n-gram / leakage-abuse caveats). **Depends on:** P3 (`_det` slot, sensitive classification). **Highest research content — scope a design spike first.**

**Tasks (after a design spike confirms the scheme):**
- **T1 — deterministic-encryption equality** for `_det` (refs / unique / sensitive-equality). Keyed PRF (HMAC) per field → equality-matchable ciphertext. Accept + document the frequency leak. TDD: same value → same `_det`; different keys → unlinkable.
- **T2 — blind-index query path.** `where(sensitiveField, '==', v)` generates a trapdoor, matches against `_det` without decrypting. Type-gated to sensitive fields with an SSE index.
- **T3 — n-gram / prefix tokenization (fuzzy + autocomplete).** Trigram blind-index for fuzzy ("Honk"≈"Hong" via shared encrypted trigrams); prefix tokens for autocomplete. **Leakage budget documented per §9; default off; never on a field not explicitly opted in.**
- **T4 — store-usable push-down.** Let a zero-knowledge store match trapdoors server-side (the marquee capability). Validate against the latest leakage-abuse literature in the spike.

**Caveat (from the validation panel):** every encrypted-search scheme leaks; do **not** ship past a design spike without re-checking current leakage-abuse results. Position as roadmap, not present, until shipped.

---

## Sequencing & safety summary

1. **P2** (foundation + codec seam) → 2. **P3** (group-encryption, default-off) → 3. **P4** (query routing; order-statistics index can land independently) → 4. **P5** (SSE, after a spike).
- Default behavior never changes until a *deliberate, supervised* flag flip (the `ramCiphertext`-default decision) — explicitly **not** an autonomous change.
- The full test suite at main's count is the behavior-preserving proof gate for every task.
- Delicate tasks (P3-T2/T4 hot-path crypto; P5 entirely) get the most-capable review model and a design spike where noted.
