# Classified fields — stage 2: the enclave oracle (design)

**Date:** 2026-07-04 · **Status:** APPROVED (owner adopted all 7 recommendations 2026-07-04) — pending adversarial security audit before implementation

**Resolved decisions (Open Questions):** Q1 `_bidx`/`findByDigest` split to slice 2b · Q2 write via normal `put()` · Q3 CRDT×classified refused fail-loud at `collection()` · Q4 `notLastN` cap = 8 · Q5 hub-side attempt counter deferred · Q6 one `'verify'` consent op per `matchGroup` call · Q7 injected `now()` on ctx.
**Issue:** #572 · **Builds on:** stage 1 (merged via PR #570, main `af31ef42`), `2026-07-04-classified-fields-design.md`
**Precedents bound:** M-2 subject-index (`with-audit/forget/subject-index.ts`: keyed HMAC ids + padded bodies), #306 record-scoped sealing (`_sealed` + CEK-derived field keys + dual-read), Enclave Contract v1 (additive-only frozen barrel), L-1 lesson (never use a raw DEK across purposes — always HKDF a dedicated key).

## Problem

Stage 1 governs display egress (masks, riders, audited reveal). Stage 2 adds **verify-without-reveal**: the enclave answers "does this candidate match?" with a verdict, and the plaintext (or even its digest, in recoverable form) never crosses the boundary. Targets: `password()` / `secretAnswer()` digest-only presets, `verify` / `verifyText`, k-of-n `matchGroup`, rotation policies (`rotateDays` / `notLastN`).

## Zero-knowledge constraint that shapes everything

A bare digest in the envelope would let the store dictionary-attack low-entropy values (secret answers, PINs) offline — the exact failure M-2 fixed for subject ids. Therefore:

- **Verify digests are ENCRYPTED at rest** (a new `_vdig` slot, sealed exactly like `_sealed`). The store sees ciphertext; only the enclave can read the digest to compare against a freshly-digested candidate.
- **External digests come in as candidates only** — compared inside the enclave, never persisted (resolves interop without ever storing a weak hash).
- The opt-in **equatable blind index** (`_bidx`, store-visible keyed HMAC per the M-2 pattern) is deliberately split into **slice 2b** — see Open Question 1 — so the core audit stays small.

## 1. Keys and salt domains (all HKDF-SHA256, following `derivePresenceKey` / `deriveSealedFieldKey` conventions)

| Key | Derivation | Usage |
|---|---|---|
| vdig slot key | HKDF(CEK, salt `'noydb-classify-vdig'`, info `JSON.stringify(['noydb-classify-vdig', collection, field])`) → AES-GCM, non-extractable | encrypt/decrypt the `_vdig[field]` blob |
| vdig slot key (legacy fallback) | same, from collection DEK with salt `'noydb-classify-vdig-dek'` | ONLY when no `_cek` exists (mirrors `_sealed` dual-derivation; keeps residue semantics identical) |
| classify index key (2b only) | HKDF(collection DEK, salt `'noydb-classify-index-v1'`, info `[domain, collection, field]`) → HMAC-SHA256, non-extractable, `['sign']` | blind-index digests, `findByDigest` |
| ct-compare ephemeral key | fresh random HMAC key per comparison (never stored) | constant-time equality (§3) |

New enclave functions (ADDITIVE to the Contract v1 barrel — no existing export changes):
`deriveVdigSlotKey(cekOrDek, collection, field, { fromCek })`, `pbkdf2VerifyDigest(value, salt, iterations)`, `ctEqualHex(a, b)`, `evaluateKofN(results, min)`. Implementation lives in a new **`kernel/enclave/classify/`** folder — classified plaintext-touching code moves INSIDE the enclave (§6); `with-shape/classified/` keeps only the strategy seam and presets, delegating via dynamic import (bundle-gate pattern proven in stage 1).

Caching: vdig slot keys are resolved per operation from the codec's existing CEK resolution (`resolveEnvelopeCek`); the 2b index keys join the codec ctx cache **by reference** (the #1 extraction landmine — never copy).

## 2. Envelope: the `_vdig` slot

```ts
// kernel/types.ts (EncryptedEnvelope) — new optional slot beside _sealed (types.ts:181)
readonly _vdig?: Record<string, string>   // field -> "iv:data" AES-GCM blob (sealed-slot wire format)
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
- **Write path:** `storage: 'digest-only'` (new `ClassifiedStorage` variant) — the plaintext arrives in a normal `put()`, write-enforcement (stage-1 seam, runs before riders/schema) validates it, the enclave digests it into `_vdig`, and the field is **stripped from `_data` entirely** (unlike `'never'`, which rejects; unlike `'recoverable'`, which seals). Ring maintenance happens here: previous `cur` shifts into `ring`, trimmed to `notLastN`.
- **forget():** `_vdig` rides the CEK — the existing tombstone (drops `_cek`/`_sealed`/`_data`) extends to drop `_vdig`; `classifySealedShred` gains the same shreddable-vs-dekResidue classification for vdig slots. Same honesty caveats as #306 D5.
- **Ledger hash:** `envelopePayloadHash` currently binds `_data + _sealed` (#306 Slice C). Extending to `_vdig` is breaking for existing hashes → **pin-first migration** exactly like Slice C (pre-commit literal hashes, then widen). `_cek` stays excluded.
- **History:** `_vdig` travels inside the envelope, so `_history` full snapshots carry it automatically; `getVersion()` never exposes digests (they decrypt only via the verify path, not `decryptRecord`).

## 3. Strategy seam: verify / verifyText / matchGroup (additive to `ClassifiedStrategy`)

```ts
// with-shape/classified/strategy.ts — stage-1 reveal() unchanged
export interface ClassifiedVerdict { readonly ok: boolean; readonly mustRotate?: true }

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
- `verify` — digest path (`digest-only` and, later, `dual` forms): decrypt `_vdig[field]`, normalize candidate per preset, `pbkdf2VerifyDigest(candidate, cur.salt, iter)`, `ctEqualHex`. Returns `{ ok }`, plus `mustRotate: true` when `spec.rotateDays` set and `now() > cur.at + rotateDays`. Verdict only — no distinction between "record missing", "no digest", "mismatch" beyond `ok: false` (existence oracles are oracles too); a `ClassifiedVerifyError` is thrown ONLY for caller bugs (unknown field, wrong storage form for the op).
- `verifyText` — recoverable path: unseal via existing `dualReadSealedSlot`, normalize BOTH sides per preset, `ctEqualHex(hmacEphemeral(a), hmacEphemeral(b))`. Plaintext exists microseconds inside the enclave function; only the boolean leaves.
- `matchGroup` — k-of-n: resolves the declared group (all `secretAnswer` members of a composite / an explicit field list), evaluates **every** member unconditionally (no short-circuit — a loop that collects, never breaks), `evaluateKofN(results, min)` returns only the aggregate. Per-member results never appear in any return, error, or audit payload (they'd decompose the challenge into independent single oracles). One `onAccess('verify', id)` per call, not per member.

**Constant time under `crypto.subtle`:** JS string comparison is not constant-time and `timingSafeEqual` is Node-only (hub-portable rule). Plan: the **double-HMAC pattern** — `ctEqualHex(a, b)` computes `hmacSha256Hex(K_e, a) === hmacSha256Hex(K_e, b)` under a fresh ephemeral random key `K_e`; the observable string compare then operates on values the attacker cannot predict, so its timing leaks nothing. This is the standard portable construction; it becomes an enclave barrel export with conformance vectors.

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

`notLastN` (cap **8**, documented): on a digest-only write, the candidate is first verified against `cur` + every `ring` entry (n × 600K PBKDF2 — the cap keeps worst case ~5s on slow devices); a match throws `ClassifiedRotationError('password was used recently')`. `rotateDays` never blocks verify — it only decorates the verdict with `mustRotate` (the app decides UX).

## 5. Threat model (stage-2 deltas + carry-ins)

- **Oracle abuse:** every `verify`/`matchGroup` emits one `'verify'` consent op (union extension, same mechanism as stage-1 `'reveal'`); hub ships **no** rate limiter in this slice — per-preset docs state the enumeration math for low-entropy fields plainly (blood group: 8 candidates beat any digest). App-side rate hooks; a hub-side attempt-counter service is future work (Open Q5).
- **Frequency leakage:** none from `_vdig` (encrypted, per-record salts). It is exclusively a 2b/`_bidx` concern, where the M-2 candor + keyed-HMAC + opt-in flag apply.
- **Reveal double-consent carry-in (fix here):** `reveal`'s internal `getView` currently rides `collection.get()` and emits a spurious `'get'` consent entry. Stage 2 reworks the reveal ctx onto the same raw-envelope access as `ClassifiedVerifyCtx` (decrypt one sealed slot directly via `dualReadSealedSlot`) — one op, one audit entry, and reveal stops materializing the full record view as a bonus exposure reduction.
- **CRDT/merge pipeline bypass carry-in:** merge resolvers bypass the whole write pipeline (pre-existing), so a merge could carry a stale/foreign `_vdig` or resurrect plaintext into `_data` for digest-only fields. Stage 2 position: **refuse the combination fail-loud** — `collection()` throws `ClassifiedConfigError` when `classifiedFields` (any digest-only or recoverable member) coexists with a `crdt`/`conflictPolicy` resolver (Open Q3). Mirrors the stage-1 MV-source refusal philosophy: no silent unprotected path.
- **External-digest interop:** `verify` accepts only raw candidates; a `verifyExternalDigest` accepting foreign `sha256(value)` schemes is explicitly OUT (weak schemes for low-entropy data; revisit only with a concrete partner requirement).

## 6. Enforcement & governance

- **`enclave-body-only` ratchet extension:** new rule — modules outside `kernel/enclave/**` may not call `pbkdf2VerifyDigest`/`ctEqualHex`/vdig key derivation or touch `_vdig` payloads; `with-shape/classified` keeps zero plaintext-touching verify code (grep-able, banked like the stage-1 ratchet).
- **Enclave conformance kit** gains vectors: vdig round-trip (write→verify ok/fail), ct-equal (equal/unequal/length-mismatch), k-of-n truth table incl. min=0/min>n edges, ring rotation (notLastN reuse refusal), dual-derivation fallback.
- **Goldens (all additive):** enclave barrel +4 exports; kernel-api +`verify`/`verifyGroup` on Collection; root barrel +`ClassifiedVerdict`/errors; bundle gate — verify engine behind the existing dynamic-import seam in `active.ts` (the stage-1 negative-test methodology re-applied: size tolerance is the proven detector).
- **Security review gate:** this design → plan → implementation all pass an adversarial security review before merge (M-2..M-5 rhythm); the review's focus list: §3 verdict-only egress, §2 shred semantics, ct-equal construction, k-of-n no-short-circuit.

## Non-goals (unchanged from stage 1 + new)

Typo-tolerant matching; hub-side rate limiting (this slice); `verifyExternalDigest`; `_bidx`/`findByDigest` (slice 2b); hardware-enclave claims.

## Open questions for the owner

1. **`_bidx` equatable blind index + `findByDigest`: in this slice or split to 2b?** — Rec: **2b**. It's the only store-visible artifact and the only frequency-leak surface; splitting keeps this audit focused on the encrypted-digest core.
2. **Digest-only write ergonomics: consume via normal `put()` (as designed) or a dedicated `setSecret()` API?** — Rec: **put()** — uniform pipeline, reuses stage-1 write enforcement; a `rotateSecret()` convenience can come later without new crypto.
3. **CRDT × classified: refuse fail-loud at `collection()` (as designed) vs strip-and-recompute digests on merge?** — Rec: **refuse**; strip-and-recompute silently drops writes and needs merge-path plaintext, which contradicts the ratchet.
4. **`notLastN` cap = 8?** — Rec: yes; n × 600K PBKDF2 at write time is the cost ceiling, documented.
5. **Hub-side verify attempt counter (a small audit-adjacent service) now or later?** — Rec: later; consent audit gives the signal, apps own the policy, and a counter is a new service with governance cost.
6. **Consent op granularity for `matchGroup`: one `'verify'` entry per call (as designed) or per member?** — Rec: per call; per-member entries would leak match structure into the audit trail.
7. **Clock for `rotateDays`: injected `now()` on the ctx (as designed, testable) vs direct `Date.now()`?** — Rec: injected — costs nothing, makes rotation testable without clock mocking hacks.
