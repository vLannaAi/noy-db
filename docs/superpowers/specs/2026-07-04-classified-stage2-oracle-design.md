# Classified fields — stage 2: the enclave oracle (design)

**Date:** 2026-07-04 · **Status:** REVISED post-audit 2026-07-04 — all Critical/Important findings incorporated; ready for implementation planning

**Resolved decisions (Open Questions):** Q1 `_bidx`/`findByDigest` split to slice 2b · Q2 write via normal `put()` · Q3 CRDT×classified refused fail-loud at `collection()` · Q4 `notLastN` cap = 8 · Q5 hub-side attempt counter deferred · Q6 one `'verify'` consent op per `matchGroup` call · Q7 injected `now()` on ctx.
**Issue:** #572 · **Builds on:** stage 1 (merged via PR #570, main `af31ef42`), `2026-07-04-classified-fields-design.md` · **Audit:** `.superpowers/sdd/stage2-audit-findings.md` (3 lenses, 2026-07-04)
**Precedents bound:** M-2 subject-index (`with-audit/forget/subject-index.ts`: keyed HMAC ids + padded bodies), #306 record-scoped sealing (`_sealed` + CEK-derived field keys + dual-read), Enclave Contract v1 (additive-only frozen barrel), L-1 lesson (never use a raw DEK across purposes — always HKDF a dedicated key).

## Audit resolution

The three-lens adversarial audit confirmed the architecture (encrypted `_vdig` digests + enclave oracle + verdict-only egress) sound and returned 6 Critical, 6 Important, 3 Minor findings. Every one is resolved in this revision; each Critical/Important also lands as a conformance-kit vector (§6). Closure map:

| Finding | Resolved in |
|---|---|
| C1 — rollback splice (no AAD) | §2 *AAD binding* + §2 *Ledger hash* (temporal residual) |
| C2 — constant-time construction wrong for variable-length input | §3 *Fixed-length-tag constant-time comparison* |
| C3 — CEK rotation destroys/bricks `_vdig` | §2 *Rotation* + §6 conformance vectors |
| C4 — existence/timing oracle | §3 *Timing uniformity* |
| C5 — CRDT refusal second door (`_applyClassifiedFields`) | §5 CRDT bullet + Refusal matrix R2 |
| C6 — read-modify-write wipes the password (showstopper) | §2 *Write path & carry-forward* |
| I1 — `mustRotate` only on `ok:true` | §3 `verify` semantics |
| I2 — matchGroup hardening | §3 `matchGroup` semantics |
| I3 — DEK-legacy fallback deleted; digest-only requires `perRecordKeys` | §1 key table + §2 *forget()* + Refusal matrix R1 |
| I4 — storage-form exclusivity + transitions | §2 *Write path* + Refusal matrix R5/R6 |
| I5 — digest-only ∩ deterministic/indexed/vector/subject-key refused | Refusal matrix R3/R4 + §2 codec mirror |
| I6 — reveal rework preserves fail-closed gates | §5 reveal bullet |
| M1 — ratchet restated identifier-based | §6 |
| M2 — ring blast radius | §5 ring bullet |
| M3 — history/pod carry | §2 *History & pods* |
| Ledger — conditional widen, no flag-day | §2 *Ledger hash* |

## Problem

Stage 1 governs display egress (masks, riders, audited reveal). Stage 2 adds **verify-without-reveal**: the enclave answers "does this candidate match?" with a verdict, and the plaintext (or even its digest, in recoverable form) never crosses the boundary. Targets: `password()` / `secretAnswer()` digest-only presets, `verify` / `verifyText`, k-of-n `matchGroup`, rotation policies (`rotateDays` / `notLastN`).

## Zero-knowledge constraint that shapes everything

A bare digest in the envelope would let the store dictionary-attack low-entropy values (secret answers, PINs) offline — the exact failure M-2 fixed for subject ids. Therefore:

- **Verify digests are ENCRYPTED at rest** (a new `_vdig` slot, sealed like `_sealed` but AAD-bound — §2). The store sees ciphertext; only the enclave can read the digest to compare against a freshly-digested candidate.
- **External digests come in as candidates only** — compared inside the enclave, never persisted (resolves interop without ever storing a weak hash).
- The opt-in **equatable blind index** (`_bidx`, store-visible keyed HMAC per the M-2 pattern) is deliberately split into **slice 2b** — see Open Question 1 — so the core audit stays small.

## 1. Keys and salt domains (all HKDF-SHA256, following `derivePresenceKey` / `deriveSealedFieldKey` conventions)

| Key | Derivation | Usage |
|---|---|---|
| vdig slot key | HKDF(CEK, salt `'noydb-classify-vdig'`, info `JSON.stringify(['noydb-classify-vdig', collection, field])`) → AES-GCM, non-extractable | encrypt/decrypt the `_vdig[field]` blob (AAD-bound, §2). **CEK-only — there is NO DEK fallback (I3).** |
| classify index key (2b only) | HKDF(collection DEK, salt `'noydb-classify-index-v1'`, info `[domain, collection, field]`) → HMAC-SHA256, non-extractable, `['sign']` | blind-index digests, `findByDigest` |
| ct-compare ephemeral key `K_e` | fresh random HMAC-SHA256 key per comparison (never stored, never reused) | fixed-length-tag reduction for the blinded compare (§3) |

**Why no DEK derivation (I3, audit-mandated deletion):** `_vdig` is a brand-new slot — there is nothing legacy to dual-read. A DEK-keyed derivation would only mint NEW digests that survive `forget()` (dekResidue): a pre-forget backup would let a collection-DEK holder offline-crack low-entropy secrets after the tombstone. Therefore `storage: 'digest-only'` is REFUSED unless the collection has `perRecordKeys: true` (Refusal matrix R1), the `'noydb-classify-vdig-dek'` salt domain does not exist, and there is no vdig-dekResidue classification (§2 *forget()*). The digest-only write itself mints `_cek` via the existing lazy CEK migration, so unmigrated records are not a blocker.

New enclave functions (ADDITIVE to the Contract v1 barrel — no existing export changes):
`deriveVdigSlotKey(cek, collection, field)` (CEK-only — no `fromCek` flag, no DEK variant), `pbkdf2VerifyDigest(value, salt, iterations)` (→ fixed 32-byte digest), `ctEqualTags(a, b)` (exactly-32-byte tags only, §3), `evaluateKofN(results, min)`. Implementation lives in a new **`kernel/enclave/classify/`** folder — classified plaintext-touching code moves INSIDE the enclave (§6); `with-shape/classified/` keeps only the strategy seam and presets, delegating via dynamic import (bundle-gate pattern proven in stage 1).

Caching: vdig slot keys are resolved per operation from the codec's existing CEK resolution (`resolveEnvelopeCek`); the 2b index keys join the codec ctx cache **by reference** (the #1 extraction landmine — never copy).

## 2. Envelope: the `_vdig` slot

```ts
// kernel/types.ts (EncryptedEnvelope) — new optional slot beside _sealed (types.ts:181)
readonly _vdig?: Record<string, string>   // field -> "iv:data" AES-256-GCM blob, AAD-bound (below)
```

Decrypted `_vdig[field]` payload (JSON):

```ts
interface VdigPayload {
  v: 1
  alg: 'PBKDF2-SHA256'
  iter: 600_000                       // family constant (crypto.ts deriveKey)
  cur: { salt: string; hash: string; at: string }   // base64 32-byte salt · base64 digest · ISO write-time
  ring?: Array<{ salt: string; hash: string }>       // previous digests, oldest-first, length ≤ notLastN (cap 8)
}
```

- **Per-record, per-write random salt** — verify digests are non-equatable by construction (no cross-record correlation even for identical passwords).

**AAD binding (C1 — rollback-splice hardening).** Every `_vdig[field]` blob is sealed via the existing `encryptBytesWithAAD` / `decryptBytesWithAAD` pair (`kernel/enclave/crypto.ts:419-474`, the blob-chunk AAD pattern) under the vdig slot key, with

```
AAD = UTF-8(JSON.stringify(['noydb-classify-vdig', collection, recordId, field]))
```

— the injective JSON-array encoding, same collision argument as `deriveSealedFieldKey`. The AAD is not stored; the reader reconstructs it. Because the CEK is stable across `put()`s, without AAD every historical `_vdig` blob for ANY record/field of the collection would remain a valid ciphertext forever — an adversarial store could splice a pre-change blob back in and `verify(oldPassword)` would return ok (the lifecycle F7b class). With AAD, a blob spliced from another record or field fails the GCM auth tag (`TamperedError`); `verify` maps that failure to `{ ok: false }` after the C4 timing pad (no tamper oracle to the verify caller). A monotonic `_v`/writeSeq component was considered for the AAD and **deliberately excluded**: C6's carry-forward copies `_vdig[field]` bytes verbatim across `_v` bumps, so the AAD must be version-independent. The residual — same-record same-field *temporal* rollback — is detected by the ledger's conditional `_vdig` binding (see *Ledger hash* below); AAD + ledger cross-check together close the class.

**Write path & carry-forward (C6 — the showstopper fix).** `storage: 'digest-only'` (new `ClassifiedStorage` variant): the plaintext arrives in a normal `put()`, write-enforcement (stage-1 seam, runs before riders/schema) validates it, the enclave digests it into `_vdig`, and the field is **stripped from `_data` entirely** (unlike `'never'`, which rejects; unlike `'recoverable'`, which seals). But digest-only fields are never present in any read view (stripped from `_data`, reveal refused), so a plain `get → mutate other field → put` would omit them — and `encryptRecord` (`record-codec.ts:178-243`) emits slots only for fields present in the incoming record, so the password would be silently destroyed by any unrelated update. Fix — **codec interface change, owned here:** the previous live envelope is plumbed into the codec write path — `encryptRecord` gains a `prev: EncryptedEnvelope | null` parameter (the `put()` path already reads the prior envelope for its `_v` bump, so this is plumbing, not an extra store read). Per digest-only field, exactly one of:

1. **Field ABSENT from the put record → carry-forward:** copy `prev._vdig[field]` **verbatim, byte-for-byte** into the new envelope. Sound because the CEK is version-stable (an update reuses the record's CEK — `resolveEnvelopeCek`) and the AAD excludes `_v`; verbatim bytes keep the ledger payload hash deterministic across unrelated updates.
2. **Field present with a string value → rotate:** validate (stage-1 write seam), then `notLastN` reuse check (§4), then digest to a fresh `cur` under a fresh random salt; previous `cur` shifts into `ring`, trimmed to `notLastN`; strip from `_data`.
3. **Field explicitly `null` → clear:** drop `_vdig[field]` from the new envelope (and emit nothing into `_data`). This is the defined way to delete a secret short of `forget()`. Subsequent `verify` returns `{ ok: false }` (padded, C4).
4. **Any other type → write-validation error** (caller bug, fail-loud).

Envelope invariant (I4): for every field, **at most one of `_sealed[field]` / `_vdig[field]` exists**. A digest-only write never emits `_sealed[field]` and never carries a stale `_sealed[field]` forward from `prev` for that field — it is deleted from the outgoing envelope (conformance vector). The `_det` mirror (I5): `record-codec.ts:231-243` excludes `sensitiveFields` from `_det` (line 234); digest-only fields join that exclusion in the codec, in addition to the config-level refusal (Refusal matrix R3).

**Rotation (C3 — found by two lenses independently).** `rotateRecordCek` (`record-keys/sealing.ts:160-223`) rebuilds the envelope from an allowlist (`_tier`/`_det`/`_sealed`) and re-seals `_sealed` under the new CEK; unfixed, it either drops `_vdig` (data loss — the #306 Slice-A bug replayed) or orphans it (undecryptable under the new CEK → the correct password false-rejects). `revokeSealedRecord({ hard: true })` delegates to it (`sealing.ts:144-148`), so revoking a grant would delete the password. Fix, mirroring the `_sealed` re-seal block at `sealing.ts:182-191`: when `live._vdig !== undefined`, for each slot decrypt under the **old**-CEK vdig key with the reconstructed AAD (no DEK fallback exists — I3, so this is a single read, not a dual-read), re-encrypt under the **new**-CEK vdig key with the same AAD, and spread `...(vdigOut !== undefined ? { _vdig: vdigOut } : {})` into the rotated envelope. Conformance vectors: `put → rotateRecordCek → verify(correct) → ok:true`, and `revokeSealedRecord({hard:true}) → verify(correct) → ok:true`. **Ledger position (stated):** rotation writes hash-bound slots with **no ledger entry** — a pre-existing property (`hash.ts` documents that `rotateRecordCek` rewrites `_cek` with no entry; `verifyBackupIntegrity` flags rotated records until re-anchored) that `_vdig` inherits unchanged. Accepted as-is for this slice, consistent with #306; not a new gap.

**forget():** `_vdig` rides the CEK — the existing tombstone (drops `_cek`/`_sealed`/`_data`) extends to drop `_vdig`. Because vdig keys are CEK-only (I3), **every vdig slot is `shreddable` by construction — there is no vdig-dekResidue class**; `classifySealedShred`'s vdig extension reports vdig slots as shreddable unconditionally on a `_cek` record. Same honesty caveats as #306 D5.

**Ledger hash (audit-confirmed simplification — replaces the draft's pin-first plan).** `envelopePayloadHash` binds `_data + _sealed` via a **conditional widen** (`with-commit/history/ledger/hash.ts:33-42`: no `_sealed` → `sha256(_data)` byte-identical to legacy). `_vdig` joins the exact same way: bind it **only when present**. No existing envelope carries `_vdig`, so this is back-compat with **no flag-day and no pin-first migration**, provided the widen ships no later than the first `_vdig` writer — enforced by landing the codec change and the hash change in the same slice. `_cek` stays excluded. This binding is also the temporal-rollback detector completing C1.

**History & pods (M3, documented consequences):** `_vdig` travels inside the envelope, so `_history` full snapshots carry it automatically — rotated-away digests persist in history snapshots until prune, a **shadow ring beyond the cap-8** (documented; prune is the remedy). `.noydb` pods carry every digest+ring slot too — ciphertext-only, so ZK holds and `load()` needs no re-key. `getVersion()` never exposes digests (they decrypt only via the verify path, not `decryptRecord`). `diff()` shows empty for a rotation-only write — by design: digests are not record fields.

## 3. Strategy seam: verify / verifyText / matchGroup (additive to `ClassifiedStrategy`)

```ts
// with-shape/classified/strategy.ts — stage-1 reveal() unchanged
export interface ClassifiedVerdict {
  readonly ok: boolean
  readonly mustRotate?: true   // I1: present ONLY when ok === true — never computed for a false verdict
}

export interface ClassifiedVerifyCtx {
  readonly collection: string
  readonly spec: ClassifiedFieldSpec
  getEnvelope(id: string): Promise<EncryptedEnvelope | null>       // raw envelope, NOT a decrypted view
  resolveCek(env: EncryptedEnvelope): Promise<EnclaveKey | undefined>
  getDEK(): Promise<EnclaveKey>
  readonly now: () => number                                        // injected for rotateDays (Open Q7)
  readonly onAccess?: ((op: 'verify', id: string) => Promise<void>) | undefined
}

export interface ClassifiedStrategy {
  reveal(ctx: ClassifiedRevealCtx, id: string, field: string): Promise<unknown>
  verify(ctx: ClassifiedVerifyCtx, id: string, field: string, candidate: string): Promise<ClassifiedVerdict>
  verifyText(ctx: ClassifiedVerifyCtx, id: string, field: string, candidate: string): Promise<ClassifiedVerdict>
  matchGroup(ctx: ClassifiedVerifyCtx, id: string, answers: Record<string, string>,
             opts: { readonly min: number }): Promise<{ readonly passed: boolean }>
}
```

`NO_CLASSIFIED` gains three throwing members (same `ClassifiedNotEnabledError`, fail-closed). Public surface: `collection.verify(id, field, candidate)`, `collection.verifyGroup(id, answers, { min })` — two kernel-api golden additions, gated behind the existing `withClassified()`.

**Semantics:**
- `verify` — digest path (`digest-only` and, later, `dual` forms): decrypt `_vdig[field]` (AAD-checked, §2), normalize candidate per preset, `pbkdf2VerifyDigest(candidate, cur.salt, iter)`, tag-compare (below). Verdict only — no distinction between "record missing", "no digest", "AAD/tamper failure", "mismatch" beyond `ok: false` (existence oracles are oracles too); a `ClassifiedVerifyError` is thrown ONLY for caller bugs (unknown field, wrong storage form for the op). **`mustRotate` (I1): computed and attached only when `ok === true`** and `spec.rotateDays` is set and `now() > cur.at + rotateDays`; a false verdict is exactly `{ ok: false }` with the key absent, so a non-holder learns nothing about the secret's write-age vs rotation policy. On `ok: true` it necessarily discloses write-age-vs-policy to the successful verifier — intended and documented (audit crypto F6).
- `verifyText` — recoverable path: unseal via existing `dualReadSealedSlot`, normalize BOTH sides per preset, reduce each side to a fixed 32-byte tag, compare tags (construction below). Plaintext exists microseconds inside the enclave function; only the boolean leaves.
- `matchGroup` — k-of-n, hardened per I2, in this exact order:
  1. **Validate everything up front, before any PBKDF2:** resolve the declared group (all `secretAnswer` members of a composite / an explicit field list); caller-bug checks — unknown field, wrong storage form, and `1 ≤ min ≤ groupSize` — throw `ClassifiedVerifyError` uniformly at ~0 elapsed time (no member-position leak via timing or throw type); normalize/validate ALL supplied candidates in the same up-front pass.
  2. **Iterate RESOLVED GROUP MEMBERS, not the `answers` object:** a member with no supplied answer contributes a `false` result AND runs the dummy-PBKDF2 pad (C4); answer keys that are not group members are **silently ignored** (no membership-probe oracle). The denominator is always `|groupMembers|`.
  3. Evaluate **every** member unconditionally (no short-circuit — a loop that collects, never breaks); `evaluateKofN(results, min)` returns only the aggregate. Per-member results never appear in any return, error, or audit payload (they'd decompose the challenge into independent single oracles). One `onAccess('verify', id)` per call, not per member.

**Timing uniformity (C4 — existence/timing oracle).** A present-but-wrong candidate costs decrypt + a full 600K PBKDF2 (~seconds); an unpadded miss returns at ~0ms — wall-clock would enumerate which records/fields/answers exist. Rule: **every path that cannot run a real comparison** — record not found, envelope lacks `_vdig[field]` (verify) or `_sealed[field]` (verifyText), group member with no supplied answer, AAD/tamper decrypt failure — MUST run one dummy `pbkdf2VerifyDigest` against a throwaway random salt plus one dummy tag-compare before returning its `false`, so total work is invariant between "exists but wrong" and "doesn't exist" (the PBKDF2 dominates all other variance). Conformance: a **timing-parity vector** asserting statistical wall-time parity between wrong-candidate and missing-record / missing-slot / missing-answer calls.

**Fixed-length-tag constant-time comparison (C2 — replaces the draft construction).** JS string comparison is not constant-time and `timingSafeEqual` is Node-only (hub-portable rule). Two rules, both mandatory:

1. **Only fixed-length values are ever compared.** `ctEqualTags(a, b)` accepts exactly two 32-byte tags and throws (caller bug) on any other length — tag length is structural, never secret-dependent, so that check leaks nothing. No code path compares variable-length secret-derived strings, and length equality is folded into the result (unequal-length inputs produce unequal tags → `ok: false`), never an early return.
2. **Every comparand is reduced to a 32-byte tag under a fresh ephemeral key before comparison.** Per comparison: generate a fresh random HMAC-SHA256 key `K_e` (never stored, never reused); compute `tagA = HMAC-SHA256(K_e, bytes(a))`, `tagB = HMAC-SHA256(K_e, bytes(b))` — 32 bytes each regardless of input length; verdict = `ctEqualTags(tagA, tagB)`. This is the double-HMAC-of-fixed-length-tags construction: on the `verify` path the comparands are already fixed 32-byte PBKDF2 outputs but still route through the tag reduction so there is exactly one construction; on the `verifyText` path the comparands are variable-length normalized plaintexts, and the reduction to fixed-length tags happens **before** any comparison.

Why this is sound — stated precisely, because the draft's justification ("the compared values are unpredictable, so compare timing leaks nothing") was **wrong and is retracted**: keyed blinding under `K_e` makes the final compare's timing uncorrelated with the underlying *values* (the attacker cannot choose or predict tag bytes without `K_e`) — blinding does **not** address input-length timing, which is why rule 1 (fixed 32-byte comparands) is independently load-bearing. Residual: the HMAC reduction itself costs ⌈len/64⌉ compression rounds — block-count granularity, sub-microsecond, buried under the mandatory 600K PBKDF2 (verify) or AES-GCM unseal (verifyText) that precedes it on every path. **Length-invariance conformance vectors are required:** equal statistical wall-time across equal vs unequal comparisons AND across candidate/stored length variation, plus the tag-length precondition tests.

## 4. Presets

```ts
classified.password({ minLength = 10, rotateDays?, notLastN? })   // storage 'digest-only'
classified.secretAnswer()                                          // storage 'digest-only', groupable
```

| Aspect | password | secretAnswer |
|---|---|---|
| normalize | NFC only (byte-faithful otherwise) | NFC + casefold + trim + collapse whitespace |
| list | omit | omit |
| verify | `verify` only | `verify` + `matchGroup` member |
| reveal | **refused** — runtime `ClassifiedRevealError` (stage-1 mechanism); compile-time refusal joins the deferred S-generic work | same |
| riders | none | none |
| write validation | `minLength`, open write-side validators (D3 law) | non-empty post-normalization |

Both presets are digest-only and therefore subject to every row of the Refusal matrix below (perRecordKeys required; no CRDT; no deterministic/indexed/vector/subject-key intersection; form exclusivity).

`notLastN` (cap **8**, documented): on a digest-only write, the candidate is first verified against `cur` + every `ring` entry (n × 600K PBKDF2 — the cap keeps worst case ~5s on slow devices), each via the §3 tag-compare; a match throws `ClassifiedRotationError('password was used recently')`. `rotateDays` never blocks verify — it only decorates an `ok: true` verdict with `mustRotate` (I1; the app decides UX).

## Refusal matrix (fail-loud config guards — each row becomes a guard + a test)

Consolidates every `collection()` / reconcile refusal this design and the audit introduced. "Both doors" = the guard runs in `collection()` config resolution AND in `_applyClassifiedFields` (`kernel/collection.ts:1153`), because `classifiedFields` can attach post-construction via the reconcile seam while `crdt`/`conflictPolicy`/`perRecordKeys` are construction-only (C5's lesson).

| # | Refused condition | Enforced at | Error | Finding |
|---|---|---|---|---|
| R1 | any `storage: 'digest-only'` member on a collection without `perRecordKeys: true` | both doors | `ClassifiedConfigError` | I3 |
| R2 | `classifiedFields` with any digest-only **or** recoverable member ∧ (`crdt` mode set ∨ a `conflictPolicy` resolver registered) | both doors | `ClassifiedConfigError` | C5 (+ stage-1 Q3) |
| R3 | digest-only field ∈ `deterministicFields` | `collection()`; mirrored structurally in the codec (`record-codec.ts:234` exclusion extended to digest-only) | `ClassifiedConfigError` | I5 |
| R4 | digest-only field ∈ `indexes` / text index / vector index / subject-key field | `collection()` | `ClassifiedConfigError` | I5 |
| R5 | one field declared under more than one storage form (`digest-only` ∧ `recoverable`, or digest-only ∧ bare `sensitiveFields` membership) — forms are mutually exclusive per field | `resolveClassifiedFields` (config resolution, both doors) | `ClassifiedConfigError` | I4 |
| R6 | storage-form transition `recoverable` ↔ `digest-only` for an existing field | see below | `ClassifiedConfigError` | I4 |

**R6 transition semantics (the chosen fail-loud branch of I4's OR — no migration in this slice):** within a session, `resolveClassifiedFields` is first-wins and refuses a re-declaration that changes a field's form. Across sessions there is no persisted descriptor to diff, so detection is data-driven: a digest-only **write** that finds `prev._sealed[field]`, or a **verify** that finds `_sealed[field]` present while `_vdig[field]` is absent, treats it as transition evidence and throws `ClassifiedConfigError` — never silent deletion of recoverable plaintext, and never an `ok: false` masquerading as wrong-password (the exact inversion I4 flagged). This caller/config-bug throw is exempt from the C4 pad like other `ClassifiedVerifyError` paths. Once a field's digest-only write has gone through (no `_sealed[field]` on prev), the §2 envelope invariant keeps the forms exclusive forever after. An explicit migration path (with history-copy honesty — old `_sealed[field]` plaintext persists in `_history` until prune) is future work, out of scope for this slice.

## 5. Threat model (stage-2 deltas + carry-ins)

- **Oracle abuse:** every `verify`/`matchGroup` emits one `'verify'` consent op (union extension, same mechanism as stage-1 `'reveal'`); hub ships **no** rate limiter in this slice — per-preset docs state the enumeration math for low-entropy fields plainly (blood group: 8 candidates beat any digest). App-side rate hooks; a hub-side attempt-counter service is future work (Open Q5).
- **Existence/timing oracle (C4):** closed by the invariant-work rule in §3 — no verify path returns faster because a record/slot/answer is missing; conformance-gated by the timing-parity vector.
- **Rollback splice (C1):** closed by AAD binding `[collection, recordId, field]` (§2) for cross-record/cross-field splices; the temporal residual is detected by the ledger's conditional `_vdig` binding. Same class as lifecycle F7b — AAD + ledger cross-check together.
- **Frequency leakage:** none from `_vdig` (encrypted, per-record per-write salts). It is exclusively a 2b/`_bidx` concern, where the M-2 candor + keyed-HMAC + opt-in flag apply.
- **Ring blast radius (M2, documented position):** ring entries are salted PBKDF2 digests (already non-reversible commitments), but a vdig-slot-key compromise exposes up to 8 historical digests for **correlated** past passwords of one record — a raised per-key-compromise blast radius vs the current-only baseline (8 offline-crackable targets instead of 1, and cross-entry patterns like incrementing suffixes become visible to a cracker). Accepted for the rotation-hygiene value; the cap bounds it; per-preset docs state it. `notLastN: 0`/omit keeps the baseline.
- **Reveal double-consent carry-in (fix here, gates preserved — I6):** `reveal`'s internal `getView` currently rides `collection.get()` and emits a spurious `'get'` consent entry. Stage 2 reworks the reveal ctx onto the same raw-envelope access as `ClassifiedVerifyCtx` (decrypt one sealed slot directly via `dualReadSealedSlot`) — one op, one audit entry, and reveal stops materializing the full record view. The rework MUST preserve stage-1's three fail-closed gates, behavioral-parity tested: (a) the `storage: 'never'` gate fires before any strategy call; (b) record not found → `ClassifiedRevealError`; (c) an absent `_sealed[field]` slot → `ClassifiedRevealError` — never the raw `TypeError` that `parseSealedSlot(undefined)` would throw (a different observable that also skips the audit entry).
- **CRDT/merge pipeline bypass carry-in (C5 — guard BOTH doors):** merge resolvers bypass the whole write pipeline (pre-existing), so a merge could carry a stale/foreign `_vdig` or resurrect plaintext into `_data` for digest-only fields. Position: **refuse the combination fail-loud** — and refusing at `collection()` alone is incomplete, because `crdt`/`conflictPolicy` is construction-only while `classifiedFields` can attach later through `_applyClassifiedFields` (`collection.ts:1153`, the stage-1 reconcile seam). The identical refusal therefore runs in BOTH `collection()` and `_applyClassifiedFields` (Refusal matrix R2). Mirrors the stage-1 MV-source refusal philosophy: no silent unprotected path.
- **External-digest interop:** `verify` accepts only raw candidates; a `verifyExternalDigest` accepting foreign `sha256(value)` schemes is explicitly OUT (weak schemes for low-entropy data; revisit only with a concrete partner requirement).

## 6. Enforcement & governance

- **`enclave-body-only` ratchet extension (M1 — identifier-based, restated):** modules outside `kernel/enclave/**` may not reference the identifiers `deriveVdigSlotKey`, `pbkdf2VerifyDigest`, `ctEqualTags`, or the `'noydb-classify-vdig'` salt literal (conformance-kit files allowlisted). **Explicitly PERMITTED: opaque `_vdig` ciphertext-map transit** — `collection.ts` / `vault.ts` / `backup.ts` / `history.ts` legitimately shuttle `_vdig` blobs between envelopes, and C6's carry-forward *requires* the codec to copy them verbatim. The boundary is: plaintext / digest / key operations = enclave-only; ciphertext-map plumbing = anywhere. Grep-able and banked like the stage-1 ratchet.
- **Enclave conformance kit** gains vectors (each Critical/Important finding is represented): vdig round-trip (write→verify ok/fail) · **AAD-mismatch rejection** — a `_vdig` blob spliced from another record/field verifies `ok:false` (C1) · **carry-forward** — unrelated `put()` preserves `verify → ok:true`, explicit `field: null` clears, and the ledger payload hash is byte-stable across a pure carry-forward (C6) · **rotate→verify ok** — `rotateRecordCek` and `revokeSealedRecord({hard:true})` both preserve verification (C3) · **timing parity** — missing record/slot/answer vs wrong candidate (C4) · ct-equal fixed-tag: equal/unequal + **length-invariance** wall-time + tag-length preconditions (C2) · k-of-n truth table incl. `min` bounds validation, missing-answer pad, non-member-key ignore, uniform up-front validation (I2) · `mustRotate` absent on every `ok:false` (I1) · mutual-exclusion invariant — digest-only write emits no `_sealed[field]` (I4) · ring rotation (notLastN reuse refusal) · every Refusal-matrix row R1–R6 (guard + test). The draft's dual-derivation-fallback vector is **deleted** with the fallback itself (I3).
- **Goldens (all additive):** enclave barrel +4 exports; kernel-api +`verify`/`verifyGroup` on Collection; root barrel +`ClassifiedVerdict`/errors; bundle gate — verify engine behind the existing dynamic-import seam in `active.ts` (the stage-1 negative-test methodology re-applied: size tolerance is the proven detector).
- **Security review gate:** this design → plan → implementation all pass an adversarial security review before merge (M-2..M-5 rhythm); the review's focus list: §3 verdict-only egress + timing uniformity, §2 AAD/carry-forward/rotation, ct-equal construction, k-of-n no-short-circuit, Refusal matrix coverage.

## Non-goals (unchanged from stage 1 + new)

Typo-tolerant matching; hub-side rate limiting (this slice); `verifyExternalDigest`; `_bidx`/`findByDigest` (slice 2b); recoverable↔digest-only migration tooling (R6 refuses instead); hardware-enclave claims.

## Open questions for the owner

1. **`_bidx` equatable blind index + `findByDigest`: in this slice or split to 2b?** — Rec: **2b**. It's the only store-visible artifact and the only frequency-leak surface; splitting keeps this audit focused on the encrypted-digest core.
2. **Digest-only write ergonomics: consume via normal `put()` (as designed) or a dedicated `setSecret()` API?** — Rec: **put()** — uniform pipeline, reuses stage-1 write enforcement; a `rotateSecret()` convenience can come later without new crypto.
3. **CRDT × classified: refuse fail-loud at `collection()` (as designed) vs strip-and-recompute digests on merge?** — Rec: **refuse**; strip-and-recompute silently drops writes and needs merge-path plaintext, which contradicts the ratchet. (Post-audit: the refusal runs in both doors — see C5 / Refusal matrix R2.)
4. **`notLastN` cap = 8?** — Rec: yes; n × 600K PBKDF2 at write time is the cost ceiling, documented. (Post-audit: blast-radius consequence documented in §5 — M2.)
5. **Hub-side verify attempt counter (a small audit-adjacent service) now or later?** — Rec: later; consent audit gives the signal, apps own the policy, and a counter is a new service with governance cost.
6. **Consent op granularity for `matchGroup`: one `'verify'` entry per call (as designed) or per member?** — Rec: per call; per-member entries would leak match structure into the audit trail.
7. **Clock for `rotateDays`: injected `now()` on the ctx (as designed, testable) vs direct `Date.now()`?** — Rec: injected — costs nothing, makes rotation testable without clock mocking hacks.
