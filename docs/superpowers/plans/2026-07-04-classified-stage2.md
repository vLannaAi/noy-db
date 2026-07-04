# Classified Fields Stage 2 — Enclave Oracle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Verify-without-reveal for classified fields — encrypted `_vdig` digest slots, an enclave oracle (`verify` / `verifyText` / `matchGroup`), `password()` / `secretAnswer()` digest-only presets, rotation policies, and the full Refusal matrix — per the hardened spec `docs/superpowers/specs/2026-07-04-classified-stage2-oracle-design.md`.

**Architecture:** All plaintext/digest/key operations live in a new `kernel/enclave/classify/` folder (inside the enclave, behind the Contract v1 barrel — 4 new barrel exports). The envelope gains an optional `_vdig` slot (AES-256-GCM, AAD-bound to `[collection, recordId, field]`, keyed off a CEK-only HKDF slot key). `with-shape/classified/` keeps only the strategy seam + presets, delegating into the enclave via dynamic import (the proven stage-1 bundle-gate pattern). The codec write path gains `prev`-envelope carry-forward semantics (C6); rotation, forget, ledger hash, and reveal are extended/reworked; governance (ratchet, conformance kit, goldens, bundle gate) locks it all in.

**Tech Stack:** TypeScript ESM, `crypto.subtle` only, vitest, pnpm + turbo. Worktree root: `/Users/vicio/lanna-db/.worktrees/classified-stage2` — **all paths below are relative to it; run all commands from it.**

## Global Constraints (verbatim hard rules from the spec + repo law)

- **Hub stays portable** — no Node built-ins in `packages/hub/src/**`; `timingSafeEqual` is Node-only and therefore banned; every crypto op via `globalThis.crypto.subtle`, zero npm crypto deps.
- **Encryption happens inside `@noy-db/hub` before any storage backend is called.** Stores see ciphertext only. The store never sees a bare digest — `_vdig` is encrypted at rest.
- **Key rule (I3/L-1):** vdig slot keys are **CEK-only** — no DEK derivation, no `'noydb-classify-vdig-dek'` salt domain, no dual-read fallback. `storage: 'digest-only'` is refused without `perRecordKeys: true` (R1).
- **C2 rule:** only fixed 32-byte tags are ever compared; every comparand is reduced to a 32-byte tag under a fresh ephemeral HMAC key before comparison; length equality folds into the result, never an early return.
- **C4 rule:** every verify path that cannot run a real comparison runs one dummy `pbkdf2VerifyDigest` against a throwaway random salt plus one dummy tag-compare before returning `{ ok: false }`.
- **I1 rule:** `mustRotate` is computed and attached ONLY when `ok === true`.
- **Enclave Contract v1:** the barrel (`kernel/enclave/index.ts`) is additive-only; nothing outside `kernel/enclave/**` may reference `deriveVdigSlotKey`, `pbkdf2VerifyDigest`, `ctEqualTags`, or the `'noydb-classify-vdig'` salt literal (conformance-kit + `*.test.ts` files allowlisted). Opaque `_vdig` ciphertext-map transit is PERMITTED anywhere (M1).
- **Goldens are frozen contracts** — any task that changes a surface updates the matching golden JSON **in the same task/commit** (flagged per task below). Same for `KERNEL_SURFACE_BUDGET` ceilings and check-bundle baselines.
- **Never** add Claude attribution to commits/PRs/CHANGELOGs. **Never** reference the private pilot client. **Never** publish without explicit user confirmation.
- **Lint + typecheck before push** — CI runs ESLint too: `pnpm lint && pnpm typecheck` locally, not just typecheck.
- **Full cross-package suite for hub API changes:** `pnpm build && pnpm test && pnpm lint && pnpm typecheck && pnpm check:architecture` at the end of every layer, and mandatorily in Task 20.
- **TDD:** every task is failing test → verify RED → implement → verify GREEN → commit.
- **Security-review gate (spec §6):** after Task 20, the implementation goes through an adversarial security review (focus: verdict-only egress + timing uniformity, AAD/carry-forward/rotation, ct-equal construction, k-of-n no-short-circuit, Refusal matrix coverage) before merge. Do not merge without it.

## Dependency layers & parallelization

| Layer | Tasks | Parallelizable within layer |
|---|---|---|
| A — enclave primitives | 1, 2, 3, 4, 5 | 1–4 fully independent (parallel); 5 after 1–4 |
| B — envelope, codec, lifecycle | 6, 7, 8, 9, 10, 11 | 6 first (spine); then 7, 9, 10, 11 in parallel; 8 after 7 |
| C — strategy, presets, refusals, reveal | 12, 13, 14, 15, 16 | 12 after 6 (can run parallel to 7–11); 13 after 12; 14 after 5+7+12 (parallel with 13); 15 after 8+9+13+14; 16 after 15 |
| D — governance | 17, 18, 19, 20 | 18 after 5 (can start early); 17 and 19 after 16; 20 last |

**Golden/budget-touching tasks (baseline update in the SAME task):** Task 5 (enclave-surface golden), Task 8 (kernel-surface ceiling `collection.ts`), Task 12 (with-surface + root-barrel goldens), Task 13 (kernel-surface ceilings `collection.ts`/`vault.ts`/`collection-config` import allowlist if tripped), Task 15 (kernel-api golden + with-surface golden + kernel-surface ceiling), Task 16 (check-bundle canary rename), Task 17 (check-architecture new check), Task 19 (check-bundle canaries).

**File map (who owns what):**

- `packages/hub/src/kernel/enclave/classify/` — NEW enclave folder: `digest.ts`, `normalize.ts`, `compare.ts`, `kofn.ts`, `vdig.ts`, `write.ts`, `verify.ts`, `reveal.ts`.
- `packages/hub/src/kernel/types.ts` — `_vdig` envelope slot, `VdigFieldPolicy`, `ClassifiedVerdict` (spine types).
- `packages/hub/src/kernel/errors.ts` — `ClassifiedVerifyError`, `ClassifiedRotationError` (new) + `ClassifiedConfigError`, `ClassifiedRevealError` (moved here from with-shape so the enclave can throw them; with-shape re-exports).
- `packages/hub/src/kernel/enclave/record-keys/record-codec.ts` — `encryptRecord` `vdig` param + branches; `_det` exclusion; `classifySealedShred` vdig extension.
- `packages/hub/src/kernel/enclave/record-keys/sealing.ts` — `rotateRecordCek` `_vdig` re-encrypt.
- `packages/hub/src/kernel/enclave/record-keys/envelope-body.ts` — `envelopeBodyForHash` conditional `_vdig` widen.
- `packages/hub/src/kernel/collection-config.ts` — `vdigFields` map + `classifiedGuardCtx`.
- `packages/hub/src/kernel/collection.ts` — prev-envelope plumbing, `verify()`/`verifyGroup()`, reveal ctx rework, both-door guards.
- `packages/hub/src/with-shape/classified/` — `descriptor.ts` (storage union + policy fields), `presets.ts` (+password/secretAnswer), `resolve.ts` (R5), `guards.ts` (NEW), `strategy.ts`, `active.ts`, `errors.ts` (re-export shim), `write.ts` (null-clear skip); `reveal.ts` DELETED in Task 16.
- Governance: `scripts/check-architecture.mjs`, `packages/hub/scripts/check-bundle.mjs`, `test-harnesses/enclave-conformance/`, goldens under `packages/hub/__tests__/`.
- Tests: enclave-primitive tests in `packages/hub/__tests__/classified/` beside the stage-1 suite (repo convention: hub tests live in `packages/hub/__tests__/`; tests are exempt from the architecture ratchets, so they may deep-import `kernel/enclave/classify/*`).

**Shared test harness:** every integration test below reuses the stage-1 `inlineMemory()` store helper. To avoid copy-paste in 8 files, Task 6 extracts it to `packages/hub/__tests__/classified/harness.ts` (pure test util, no golden impact) and stage-2 tests import it. Full text is in Task 6.

---

### Task 1: Layer A — `pbkdf2VerifyDigest` + `normalizeForVerify`

**Files:**
- Create: `packages/hub/src/kernel/enclave/classify/digest.ts`
- Create: `packages/hub/src/kernel/enclave/classify/normalize.ts`
- Test: `packages/hub/__tests__/classified/verify-digest-primitive.test.ts`

**Interfaces:**
- Consumes: `globalThis.crypto.subtle` only.
- Produces:
  - `export const VDIG_ITERATIONS = 600_000` (the family constant)
  - `export async function pbkdf2VerifyDigest(value: string, salt: Uint8Array, iterations: number): Promise<Uint8Array>` — always exactly 32 bytes (PBKDF2-SHA256 → 256 deriveBits)
  - `export type VerifyNormalizeMode = 'password' | 'secret-answer'`
  - `export function normalizeForVerify(mode: VerifyNormalizeMode, value: string): string` — password: NFC only (byte-faithful otherwise); secret-answer: NFC + casefold + trim + collapse whitespace

- [ ] **Step 1: Write the failing test**

```ts
// packages/hub/__tests__/classified/verify-digest-primitive.test.ts
import { describe, it, expect } from 'vitest'
import { pbkdf2VerifyDigest, VDIG_ITERATIONS } from '../../src/kernel/enclave/classify/digest.js'
import { normalizeForVerify } from '../../src/kernel/enclave/classify/normalize.js'

// Low iteration count for speed in structural tests; determinism is
// iteration-count independent. One test pins the 600K family constant.
const FAST = 1_000

describe('pbkdf2VerifyDigest', () => {
  it('returns exactly 32 bytes regardless of input length', async () => {
    const salt = new Uint8Array(32).fill(7)
    expect((await pbkdf2VerifyDigest('a', salt, FAST)).length).toBe(32)
    expect((await pbkdf2VerifyDigest('a'.repeat(500), salt, FAST)).length).toBe(32)
  })

  it('is deterministic for same value+salt+iterations, and salt-sensitive', async () => {
    const s1 = new Uint8Array(32).fill(1)
    const s2 = new Uint8Array(32).fill(2)
    const a = await pbkdf2VerifyDigest('correct horse', s1, FAST)
    const b = await pbkdf2VerifyDigest('correct horse', s1, FAST)
    const c = await pbkdf2VerifyDigest('correct horse', s2, FAST)
    expect(Buffer.from(a).toString('hex')).toBe(Buffer.from(b).toString('hex'))
    expect(Buffer.from(a).toString('hex')).not.toBe(Buffer.from(c).toString('hex'))
  })

  it('pins the family iteration constant', () => {
    expect(VDIG_ITERATIONS).toBe(600_000)
  })
})

describe('normalizeForVerify', () => {
  it('password mode is NFC-only and otherwise byte-faithful', () => {
    // U+0065 U+0301 (e + combining acute) NFC-normalizes to U+00E9
    expect(normalizeForVerify('password', 'café')).toBe('café')
    expect(normalizeForVerify('password', '  MiXeD  Case  ')).toBe('  MiXeD  Case  ')
  })

  it('secret-answer mode: NFC + casefold + trim + collapse whitespace', () => {
    expect(normalizeForVerify('secret-answer', '  Fluffy   The\tCat ')).toBe('fluffy the cat')
    expect(normalizeForVerify('secret-answer', 'CAFÉ')).toBe('café')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/hub/__tests__/classified/verify-digest-primitive.test.ts`
Expected: FAIL — `Cannot find module .../kernel/enclave/classify/digest.js`

- [ ] **Step 3: Write the implementation**

```ts
// packages/hub/src/kernel/enclave/classify/digest.ts
/**
 * Verify-digest primitive for classified `digest-only` fields (stage 2).
 * PBKDF2-SHA256 → fixed 32-byte digest. The digest NEVER leaves the enclave
 * in recoverable form — it is sealed into the `_vdig` envelope slot (vdig.ts)
 * or compared in-enclave (verify.ts). @module
 */
const subtle = globalThis.crypto.subtle

/** Family KDF constant — matches crypto.ts PBKDF2_ITERATIONS (600K). */
export const VDIG_ITERATIONS = 600_000

/**
 * Digest a (pre-normalized) candidate/value to exactly 32 bytes.
 * PBKDF2-SHA256 with a per-record per-write random salt (§2): verify
 * digests are non-equatable by construction.
 */
export async function pbkdf2VerifyDigest(
  value: string,
  salt: Uint8Array,
  iterations: number,
): Promise<Uint8Array> {
  const keyMaterial = await subtle.importKey(
    'raw',
    new TextEncoder().encode(value),
    'PBKDF2',
    false,
    ['deriveBits'],
  )
  const bits = await subtle.deriveBits(
    { name: 'PBKDF2', salt: salt as BufferSource, iterations, hash: 'SHA-256' },
    keyMaterial,
    256,
  )
  return new Uint8Array(bits)
}
```

```ts
// packages/hub/src/kernel/enclave/classify/normalize.ts
/**
 * Preset normalization for verify candidates AND stored comparands (§4).
 * Both sides of every comparison route through the SAME function so
 * write-time digests and verify-time candidates agree. @module
 */
export type VerifyNormalizeMode = 'password' | 'secret-answer'

export function normalizeForVerify(mode: VerifyNormalizeMode, value: string): string {
  const nfc = value.normalize('NFC')
  if (mode === 'password') return nfc
  // secret-answer: casefold + trim + collapse internal whitespace runs
  return nfc.toLowerCase().trim().replace(/\s+/g, ' ')
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/hub/__tests__/classified/verify-digest-primitive.test.ts`
Expected: PASS (all 5)

- [ ] **Step 5: Commit**

```bash
git add packages/hub/src/kernel/enclave/classify/digest.ts packages/hub/src/kernel/enclave/classify/normalize.ts packages/hub/__tests__/classified/verify-digest-primitive.test.ts
git commit -m "feat(classified): pbkdf2VerifyDigest + preset normalization enclave primitives"
```

---

### Task 2: Layer A — `ctEqualTags` + `blindedEqual` (C2 construction)

**Files:**
- Create: `packages/hub/src/kernel/enclave/classify/compare.ts`
- Test: `packages/hub/__tests__/classified/ct-equal.test.ts`

**Interfaces:**
- Consumes: `globalThis.crypto.subtle`.
- Produces:
  - `export function ctEqualTags(a: Uint8Array, b: Uint8Array): boolean` — throws `Error` (caller bug) unless BOTH inputs are exactly 32 bytes; XOR-accumulate, no early return.
  - `export async function blindedEqual(a: Uint8Array, b: Uint8Array): Promise<boolean>` — the double-HMAC-of-fixed-length-tags construction: fresh ephemeral HMAC-SHA256 key `K_e` per call (never stored/reused), `tagX = HMAC(K_e, x)` (32 bytes each), verdict = `ctEqualTags(tagA, tagB)`. Accepts ANY input lengths; length inequality folds into unequal tags.

- [ ] **Step 1: Write the failing test** — includes the C2 conformance vectors: equal/unequal, tag-length preconditions, and **length-invariance wall-time**.

```ts
// packages/hub/__tests__/classified/ct-equal.test.ts
import { describe, it, expect } from 'vitest'
import { ctEqualTags, blindedEqual } from '../../src/kernel/enclave/classify/compare.js'

const bytes = (s: string) => new TextEncoder().encode(s)

describe('ctEqualTags (fixed 32-byte tags only)', () => {
  it('true for identical 32-byte tags, false for a single-bit difference', () => {
    const a = new Uint8Array(32).fill(0xab)
    const b = new Uint8Array(32).fill(0xab)
    expect(ctEqualTags(a, b)).toBe(true)
    b[31] = 0xaa
    expect(ctEqualTags(a, b)).toBe(false)
  })

  it('throws (caller bug) on any non-32-byte input — tag length is structural', () => {
    const ok = new Uint8Array(32)
    expect(() => ctEqualTags(new Uint8Array(31), ok)).toThrow(/32 bytes/)
    expect(() => ctEqualTags(ok, new Uint8Array(33))).toThrow(/32 bytes/)
    expect(() => ctEqualTags(new Uint8Array(0), new Uint8Array(0))).toThrow(/32 bytes/)
  })
})

describe('blindedEqual (double-HMAC reduction)', () => {
  it('equal inputs → true; unequal → false; unequal lengths → false, never a throw', async () => {
    expect(await blindedEqual(bytes('swordfish!'), bytes('swordfish!'))).toBe(true)
    expect(await blindedEqual(bytes('swordfish!'), bytes('swordfish?'))).toBe(false)
    expect(await blindedEqual(bytes('short'), bytes('a-much-longer-comparand'))).toBe(false)
  })

  it('length-invariance: wall-time does not scale with comparand length (conformance C2)', async () => {
    // HMAC cost is block-count granular (sub-µs per block); assert the 100x
    // length spread stays within a generous constant factor — a linear or
    // early-return regression blows well past it.
    const N = 200
    const time = async (a: Uint8Array, b: Uint8Array) => {
      const t0 = performance.now()
      for (let i = 0; i < N; i++) await blindedEqual(a, b)
      return performance.now() - t0
    }
    await time(bytes('warmup'), bytes('warmup'))
    const short = await time(bytes('aa'), bytes('ab'))
    const long = await time(bytes('x'.repeat(200)), bytes('y'.repeat(200)))
    const mixed = await time(bytes('aa'), bytes('x'.repeat(200)))
    expect(long).toBeLessThan(short * 5 + 50)
    expect(mixed).toBeLessThan(short * 5 + 50)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/hub/__tests__/classified/ct-equal.test.ts`
Expected: FAIL — `Cannot find module .../classify/compare.js`

- [ ] **Step 3: Write the implementation**

```ts
// packages/hub/src/kernel/enclave/classify/compare.ts
/**
 * C2 — fixed-length-tag constant-time comparison (hub-portable; no
 * Node timingSafeEqual). Two mandatory rules (spec §3):
 *  1. Only fixed 32-byte tags are ever compared — ctEqualTags throws on
 *     anything else (tag length is structural, never secret-dependent).
 *  2. Every comparand is reduced to a 32-byte tag under a FRESH ephemeral
 *     HMAC-SHA256 key before comparison — keyed blinding makes compare
 *     timing uncorrelated with underlying values; rule 1 (not blinding)
 *     is what removes input-length timing. Length inequality folds into
 *     unequal tags — never an early return.
 * @module
 */
const subtle = globalThis.crypto.subtle

/** Compare exactly-32-byte tags. XOR-accumulate over all 32 bytes, no early exit. */
export function ctEqualTags(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== 32 || b.length !== 32) {
    throw new Error(
      `ctEqualTags: tags must be exactly 32 bytes (got ${a.length}/${b.length}) — caller bug; ` +
      `reduce comparands with blindedEqual first`,
    )
  }
  let diff = 0
  for (let i = 0; i < 32; i++) diff |= (a[i]! ^ b[i]!)
  return diff === 0
}

/**
 * Blinded equality of arbitrary-length byte strings: fresh K_e per
 * comparison (never stored, never reused), HMAC both sides to 32-byte
 * tags, then ctEqualTags. On the digest path the inputs are already
 * 32-byte PBKDF2 outputs but still route through this reduction so
 * there is exactly ONE comparison construction (spec §3 rule 2).
 */
export async function blindedEqual(a: Uint8Array, b: Uint8Array): Promise<boolean> {
  const ke = await subtle.generateKey({ name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const tagA = new Uint8Array(await subtle.sign('HMAC', ke, a as BufferSource))
  const tagB = new Uint8Array(await subtle.sign('HMAC', ke, b as BufferSource))
  return ctEqualTags(tagA, tagB)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/hub/__tests__/classified/ct-equal.test.ts`
Expected: PASS (all 4)

- [ ] **Step 5: Commit**

```bash
git add packages/hub/src/kernel/enclave/classify/compare.ts packages/hub/__tests__/classified/ct-equal.test.ts
git commit -m "feat(classified): ctEqualTags + blindedEqual fixed-tag comparison (C2)"
```

---

### Task 3: Layer A — `evaluateKofN`

**Files:**
- Create: `packages/hub/src/kernel/enclave/classify/kofn.ts`
- Test: `packages/hub/__tests__/classified/kofn.test.ts`

**Interfaces:**
- Produces: `export function evaluateKofN(results: readonly boolean[], min: number): boolean` — full scan (never breaks), throws `Error` (caller bug) unless `1 ≤ min ≤ results.length` and `min` is an integer.

- [ ] **Step 1: Write the failing test** — the k-of-n truth-table conformance vector (§6, I2) at the pure-aggregate level.

```ts
// packages/hub/__tests__/classified/kofn.test.ts
import { describe, it, expect } from 'vitest'
import { evaluateKofN } from '../../src/kernel/enclave/classify/kofn.js'

describe('evaluateKofN', () => {
  it('truth table', () => {
    expect(evaluateKofN([true, true, false], 2)).toBe(true)
    expect(evaluateKofN([true, false, false], 2)).toBe(false)
    expect(evaluateKofN([true, true, true], 3)).toBe(true)
    expect(evaluateKofN([false, false, false], 1)).toBe(false)
    expect(evaluateKofN([true], 1)).toBe(true)
    expect(evaluateKofN([true, true, false, false], 2)).toBe(true)
  })

  it('min bounds are caller-bug throws (I2c)', () => {
    expect(() => evaluateKofN([true, true], 0)).toThrow(/out of range/)
    expect(() => evaluateKofN([true, true], 3)).toThrow(/out of range/)
    expect(() => evaluateKofN([true, true], 1.5)).toThrow(/out of range/)
    expect(() => evaluateKofN([], 1)).toThrow(/out of range/)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/hub/__tests__/classified/kofn.test.ts`
Expected: FAIL — `Cannot find module .../classify/kofn.js`

- [ ] **Step 3: Write the implementation**

```ts
// packages/hub/src/kernel/enclave/classify/kofn.ts
/**
 * k-of-n aggregate for matchGroup (§3). Deliberately a full scan that
 * never breaks: per-member results must never influence control flow in
 * a way an observer could time or decompose. Returns ONLY the aggregate.
 * @module
 */
export function evaluateKofN(results: readonly boolean[], min: number): boolean {
  if (!Number.isInteger(min) || min < 1 || min > results.length) {
    throw new Error(
      `evaluateKofN: min ${min} out of range 1..${results.length} — caller bug ` +
      `(matchGroup validates bounds up front, before any PBKDF2)`,
    )
  }
  let count = 0
  for (const r of results) {
    if (r) count += 1 // no short-circuit — collect, never break
  }
  return count >= min
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/hub/__tests__/classified/kofn.test.ts`
Expected: PASS (both)

- [ ] **Step 5: Commit**

```bash
git add packages/hub/src/kernel/enclave/classify/kofn.ts packages/hub/__tests__/classified/kofn.test.ts
git commit -m "feat(classified): evaluateKofN no-short-circuit aggregate"
```

---

### Task 4: Layer A — `VdigPayload` + AAD builder + `deriveVdigSlotKey` + seal/open

**Files:**
- Create: `packages/hub/src/kernel/enclave/classify/vdig.ts`
- Test: `packages/hub/__tests__/classified/vdig-slot.test.ts`

**Interfaces:**
- Consumes: `encryptBytesWithAAD` / `decryptBytesWithAAD` (`kernel/enclave/crypto.ts:419-474` — signatures `(data: Uint8Array, dek: CryptoKey, aad: Uint8Array) => Promise<{iv, data}>` and `(ivBase64, dataBase64, dek, aad) => Promise<Uint8Array>`, the latter throwing `TamperedError` on AAD/auth failure); `EnclaveKey`; `generateDEK` (to mint test CEKs).
- Produces:
  - `export const VDIG_SALT_DOMAIN = 'noydb-classify-vdig'`
  - `export interface VdigDigestEntry { readonly salt: string; readonly hash: string }` (base64 32-byte salt / base64 32-byte digest)
  - `export interface VdigPayload { readonly v: 1; readonly alg: 'PBKDF2-SHA256'; readonly iter: number; readonly cur: VdigDigestEntry & { readonly at: string }; readonly ring?: readonly VdigDigestEntry[] }`
  - `export function buildVdigAad(collection: string, recordId: string, field: string): Uint8Array` — `UTF-8(JSON.stringify(['noydb-classify-vdig', collection, recordId, field]))`; deliberately version-independent (C6 carry-forward copies bytes across `_v` bumps).
  - `export async function deriveVdigSlotKey(cek: EnclaveKey, collection: string, field: string): Promise<EnclaveKey>` — HKDF-SHA256(CEK, salt `'noydb-classify-vdig'`, info `JSON.stringify(['noydb-classify-vdig', collection, field])`) → non-extractable AES-256-GCM. **CEK-only — no DEK variant, no `fromCek` flag (I3).**
  - `export async function sealVdigPayload(payload: VdigPayload, cek: EnclaveKey, collection: string, recordId: string, field: string): Promise<string>` → `"iv:data"`
  - `export async function openVdigPayload(blob: string, cek: EnclaveKey, collection: string, recordId: string, field: string): Promise<VdigPayload>` — throws `TamperedError` when the blob was sealed under a different record/field/collection AAD (C1).

- [ ] **Step 1: Write the failing test** — includes the **AAD-mismatch conformance vectors** (cross-record and cross-field splice) here in Layer A, per C1.

```ts
// packages/hub/__tests__/classified/vdig-slot.test.ts
import { describe, it, expect } from 'vitest'
import { generateDEK } from '../../src/kernel/enclave/index.js'
import {
  VDIG_SALT_DOMAIN, buildVdigAad, deriveVdigSlotKey,
  sealVdigPayload, openVdigPayload, type VdigPayload,
} from '../../src/kernel/enclave/classify/vdig.js'
import { TamperedError } from '../../src/kernel/errors.js'

const payload: VdigPayload = {
  v: 1, alg: 'PBKDF2-SHA256', iter: 600_000,
  cur: { salt: 'c2FsdA==', hash: 'aGFzaA==', at: '2026-07-04T00:00:00.000Z' },
}

describe('vdig slot seal/open', () => {
  it('pins the salt domain literal', () => {
    expect(VDIG_SALT_DOMAIN).toBe('noydb-classify-vdig')
  })

  it('AAD is the injective JSON-array encoding, version-independent', () => {
    const aad = new TextDecoder().decode(buildVdigAad('users', 'r1', 'password'))
    expect(aad).toBe('["noydb-classify-vdig","users","r1","password"]')
  })

  it('round-trips under the record CEK with matching AAD coordinates', async () => {
    const cek = await generateDEK()
    const blob = await sealVdigPayload(payload, cek, 'users', 'r1', 'password')
    expect(blob).toMatch(/^[^:]+:.+$/) // iv:data shape
    const back = await openVdigPayload(blob, cek, 'users', 'r1', 'password')
    expect(back).toEqual(payload)
  })

  it('C1: a blob spliced from ANOTHER RECORD fails the GCM auth tag (TamperedError)', async () => {
    const cek = await generateDEK()
    const blob = await sealVdigPayload(payload, cek, 'users', 'r1', 'password')
    await expect(openVdigPayload(blob, cek, 'users', 'r2', 'password')).rejects.toBeInstanceOf(TamperedError)
  })

  it('C1: a blob spliced from ANOTHER FIELD fails the GCM auth tag (TamperedError)', async () => {
    const cek = await generateDEK()
    const blob = await sealVdigPayload(payload, cek, 'users', 'r1', 'password')
    await expect(openVdigPayload(blob, cek, 'users', 'r1', 'pin')).rejects.toBeInstanceOf(TamperedError)
  })

  it('a different CEK cannot open the slot (CEK-only key, I3)', async () => {
    const cek = await generateDEK()
    const other = await generateDEK()
    const blob = await sealVdigPayload(payload, cek, 'users', 'r1', 'password')
    await expect(openVdigPayload(blob, other, 'users', 'r1', 'password')).rejects.toThrow()
  })

  it('slot keys are domain-separated per field', async () => {
    const cek = await generateDEK()
    const k1 = await deriveVdigSlotKey(cek, 'users', 'password')
    const k2 = await deriveVdigSlotKey(cek, 'users', 'pin')
    expect(k1).not.toBe(k2) // distinct non-extractable key handles
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/hub/__tests__/classified/vdig-slot.test.ts`
Expected: FAIL — `Cannot find module .../classify/vdig.js`

- [ ] **Step 3: Write the implementation**

```ts
// packages/hub/src/kernel/enclave/classify/vdig.ts
/**
 * The `_vdig` slot payload + crypto (stage 2, spec §2).
 *
 * A `_vdig[field]` blob is AES-256-GCM `"iv:data"` sealed under an
 * HKDF(CEK) slot key with AAD = ['noydb-classify-vdig', collection,
 * recordId, field] (C1 rollback-splice hardening). The AAD is NOT stored —
 * readers reconstruct it. It is deliberately `_v`-independent: C6's
 * carry-forward copies blob bytes verbatim across version bumps; the
 * same-record same-field TEMPORAL rollback residual is detected by the
 * ledger's conditional `_vdig` binding (envelope-body.ts).
 *
 * CEK-ONLY (I3): there is no DEK derivation and no
 * 'noydb-classify-vdig-dek' salt domain — every vdig slot dies with the
 * record's `_cek` (forget() shreds it totally; no vdig-dekResidue class).
 * @module
 */
import { encryptBytesWithAAD, decryptBytesWithAAD, type EnclaveKey } from '../crypto.js'

const subtle = globalThis.crypto.subtle

export const VDIG_SALT_DOMAIN = 'noydb-classify-vdig'

export interface VdigDigestEntry {
  readonly salt: string   // base64 32-byte per-write random salt
  readonly hash: string   // base64 32-byte pbkdf2VerifyDigest output
}

export interface VdigPayload {
  readonly v: 1
  readonly alg: 'PBKDF2-SHA256'
  readonly iter: number
  readonly cur: VdigDigestEntry & { readonly at: string }  // ISO write-time
  /** Previous digests, oldest-first, length ≤ notLastN (cap 8). */
  readonly ring?: readonly VdigDigestEntry[]
}

/** Injective JSON-array AAD — same collision argument as deriveSealedFieldKey. */
export function buildVdigAad(collection: string, recordId: string, field: string): Uint8Array {
  return new TextEncoder().encode(JSON.stringify([VDIG_SALT_DOMAIN, collection, recordId, field]))
}

/** HKDF(CEK) → non-extractable AES-256-GCM vdig slot key. CEK-only (I3). */
export async function deriveVdigSlotKey(
  cek: EnclaveKey,
  collection: string,
  field: string,
): Promise<EnclaveKey> {
  const raw = await subtle.exportKey('raw', cek)
  const hkdf = await subtle.importKey('raw', raw, 'HKDF', false, ['deriveBits'])
  const salt = new TextEncoder().encode(VDIG_SALT_DOMAIN)
  const info = new TextEncoder().encode(JSON.stringify([VDIG_SALT_DOMAIN, collection, field]))
  const bits = await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, hkdf, 256)
  return subtle.importKey('raw', bits, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
}

export async function sealVdigPayload(
  payload: VdigPayload,
  cek: EnclaveKey,
  collection: string,
  recordId: string,
  field: string,
): Promise<string> {
  const key = await deriveVdigSlotKey(cek, collection, field)
  const { iv, data } = await encryptBytesWithAAD(
    new TextEncoder().encode(JSON.stringify(payload)),
    key,
    buildVdigAad(collection, recordId, field),
  )
  return `${iv}:${data}`
}

/** Throws TamperedError on any AAD / auth-tag mismatch (C1). */
export async function openVdigPayload(
  blob: string,
  cek: EnclaveKey,
  collection: string,
  recordId: string,
  field: string,
): Promise<VdigPayload> {
  const sep = blob.indexOf(':')
  const key = await deriveVdigSlotKey(cek, collection, field)
  const bytes = await decryptBytesWithAAD(
    blob.slice(0, sep),
    blob.slice(sep + 1),
    key,
    buildVdigAad(collection, recordId, field),
  )
  return JSON.parse(new TextDecoder().decode(bytes)) as VdigPayload
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/hub/__tests__/classified/vdig-slot.test.ts`
Expected: PASS (all 7)

- [ ] **Step 5: Commit**

```bash
git add packages/hub/src/kernel/enclave/classify/vdig.ts packages/hub/__tests__/classified/vdig-slot.test.ts
git commit -m "feat(classified): VdigPayload + AAD-bound seal/open + CEK-only slot key (C1/I3)"
```

---

### Task 5: Layer A — enclave barrel +4 exports + enclave-surface golden  ⚠ golden

**Files:**
- Modify: `packages/hub/src/kernel/enclave/index.ts` (add a `─── classify ───` section)
- Modify: `packages/hub/__tests__/enclave-surface.golden.json` (**frozen golden — additive update in this task**)
- Test: existing `packages/hub/__tests__/enclave-surface-golden.test.ts`

**Interfaces:**
- Consumes: Tasks 1–4 exports.
- Produces (the ADDITIVE Contract v1 barrel delta, spec §1): `deriveVdigSlotKey`, `pbkdf2VerifyDigest`, `ctEqualTags`, `evaluateKofN` importable from `kernel/enclave/index.js`. (The seal/open/normalize/mint/verify orchestration is deliberately NOT on the barrel — with-shape reaches it via dynamic import, which `enclave-barrel-only` does not scan; the barrel carries only the 4 fork-contract primitives.)

- [ ] **Step 1: Write the failing test (golden expectation first)**

Edit `packages/hub/__tests__/enclave-surface.golden.json`: insert `"ctEqualTags"`, `"deriveVdigSlotKey"`, `"evaluateKofN"`, `"pbkdf2VerifyDigest"` into the `"values"` array in its existing alphabetical order (after `"buildTombstone"` insert `"ctEqualTags"`; after `"deriveSealedFieldKeyFromCek"` insert `"deriveVdigSlotKey"`; after `"encryptDeterministic"` insert `"evaluateKofN"` — check exact sort with the test output; after `"openEnvelopeJson"` insert `"pbkdf2VerifyDigest"`).

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/hub/__tests__/enclave-surface-golden.test.ts`
Expected: FAIL — golden now lists 4 exports the barrel does not have.

- [ ] **Step 3: Add the barrel exports**

Append to `packages/hub/src/kernel/enclave/index.ts` (after the envelope-body section):

```ts
// ─── classify (stage-2 verify oracle primitives) ────────────────────
// ADDITIVE per Enclave Contract v1. A fork must provide these four; the
// verify/matchGroup orchestration (classify/verify.ts) sits behind the
// with-shape dynamic-import seam and is not part of the fork contract.
export { deriveVdigSlotKey } from './classify/vdig.js'
export { pbkdf2VerifyDigest } from './classify/digest.js'
export { ctEqualTags } from './classify/compare.js'
export { evaluateKofN } from './classify/kofn.js'
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/hub/__tests__/enclave-surface-golden.test.ts`
Expected: PASS. Also run `pnpm check:architecture` — expect clean (barrel change is inside the enclave).

- [ ] **Step 5: Commit**

```bash
git add packages/hub/src/kernel/enclave/index.ts packages/hub/__tests__/enclave-surface.golden.json
git commit -m "feat(classified): enclave barrel +4 classify primitives (Contract v1 additive)"
```

---

### Task 6: Layer B — spine types + errors + descriptor widen + shared test harness

**Files:**
- Modify: `packages/hub/src/kernel/types.ts` (add `_vdig` beside `_sealed` at ~types.ts:181; add `VdigFieldPolicy`, `ClassifiedVerdict`)
- Modify: `packages/hub/src/kernel/errors.ts` (add `ClassifiedVerifyError`, `ClassifiedRotationError`; move `ClassifiedConfigError`, `ClassifiedRevealError` here)
- Modify: `packages/hub/src/with-shape/classified/errors.ts` (becomes a re-export shim for the two moved classes; keeps `ClassifiedNeverStoredError`, `ClassifiedValidationError` locally)
- Modify: `packages/hub/src/with-shape/classified/descriptor.ts` (`ClassifiedStorage` + `'digest-only'`; policy fields on `ClassifiedFieldSpec`)
- Create: `packages/hub/__tests__/classified/harness.ts` (extracted `inlineMemory()` — copy the exact function body from `packages/hub/__tests__/classified/reveal-gate.test.ts` and export it; update that test to import it)
- Test: `packages/hub/__tests__/classified/stage2-spine.test.ts`

**Interfaces:**
- Produces (everything later tasks type against):

```ts
// kernel/types.ts — on EncryptedEnvelope, directly after the _sealed member:
/**
 * Verify-digest slots (classified stage 2). Map of digest-only field name →
 * AES-256-GCM `iv:data` blob sealed under the HKDF(CEK) vdig slot key with
 * AAD ['noydb-classify-vdig', collection, recordId, field]. The store sees
 * only ciphertext; only the enclave verify path can read the digest. At most
 * one of `_sealed[field]` / `_vdig[field]` exists per field (I4).
 */
readonly _vdig?: Record<string, string>

/** Spine policy for one digest-only classified field — the enclave-consumable
 *  projection of a ClassifiedFieldSpec (the enclave never imports with-*). */
export interface VdigFieldPolicy {
  readonly normalize: 'password' | 'secret-answer'
  /** Ring size for reuse refusal; 0 = no ring. Cap 8 (spec Q4). */
  readonly notLastN: number
  readonly rotateDays?: number
}

/** Verdict-only egress of the enclave oracle (spec §3). */
export interface ClassifiedVerdict {
  readonly ok: boolean
  /** I1: present ONLY when ok === true — never computed for a false verdict. */
  readonly mustRotate?: true
}
```

```ts
// kernel/errors.ts — appended (match the file's existing plain-Error style
// used by the with-shape classified errors so behavior does not drift):
export class ClassifiedConfigError extends Error {
  constructor(public readonly collection: string, message: string) {
    super(`classifiedFields for collection "${collection}": ${message}`)
    this.name = 'ClassifiedConfigError'
  }
}
export class ClassifiedRevealError extends Error {
  constructor(public readonly collection: string, public readonly field: string, detail: string) {
    super(`Cannot reveal field "${field}" in collection "${collection}": ${detail}`)
    this.name = 'ClassifiedRevealError'
  }
}
export class ClassifiedVerifyError extends Error {
  constructor(public readonly collection: string, public readonly field: string, detail: string) {
    super(`Cannot verify field "${field}" in collection "${collection}": ${detail}`)
    this.name = 'ClassifiedVerifyError'
  }
}
export class ClassifiedRotationError extends Error {
  constructor(public readonly collection: string, public readonly field: string, detail: string) {
    super(`Rotation refused for field "${field}" in collection "${collection}": ${detail}`)
    this.name = 'ClassifiedRotationError'
  }
}
```

  - `with-shape/classified/errors.ts` DELETES its `ClassifiedConfigError` / `ClassifiedRevealError` class bodies and replaces them with `export { ClassifiedConfigError, ClassifiedRevealError, ClassifiedVerifyError, ClassifiedRotationError } from '../../kernel/errors.js'` (public import paths and export names unchanged → no golden churn; the move lets `kernel/enclave/classify/*` throw them without importing with-*).
  - `descriptor.ts`: `export type ClassifiedStorage = 'recoverable' | 'never' | 'digest-only'` and on `ClassifiedFieldSpec` add:

```ts
  /** Digest-only verify policy (stage 2). Mode both sides normalize under. */
  readonly verifyNormalize?: 'password' | 'secret-answer'
  /** Decorate ok:true verdicts with mustRotate after this many days (I1). */
  readonly rotateDays?: number
  /** Refuse reuse of the last N values on rotate (cap 8, spec Q4). */
  readonly notLastN?: number
  /** Member of the collection's matchGroup (secretAnswer preset). */
  readonly verifyGroupMember?: true
```

  - `harness.ts`: `export function inlineMemory(): NoydbStore` — the verbatim function from `reveal-gate.test.ts` (Map-of-Maps store with OCC ConflictError, `gc()` helper, `loadAll` skipping `_`-collections), plus `export function lastEnvelope(...)` is NOT needed — tests read via `store.get`. Give the returned store a `raw` accessor so tests can inspect envelopes: return the object with an added `readonly _dump: (vault: string, coll: string, id: string) => EncryptedEnvelope | undefined` closure over the Map.

- [ ] **Step 1: Write the failing test**

```ts
// packages/hub/__tests__/classified/stage2-spine.test.ts
import { describe, it, expect } from 'vitest'
import type { EncryptedEnvelope, VdigFieldPolicy, ClassifiedVerdict } from '../../src/kernel/types.js'
import {
  ClassifiedConfigError, ClassifiedRevealError, ClassifiedVerifyError, ClassifiedRotationError,
} from '../../src/kernel/errors.js'
import {
  ClassifiedConfigError as ShimConfig, ClassifiedRevealError as ShimReveal,
} from '../../src/with-shape/classified/errors.js'
import type { ClassifiedFieldSpec } from '../../src/with-shape/classified/descriptor.js'

describe('stage-2 spine', () => {
  it('EncryptedEnvelope accepts a _vdig ciphertext map', () => {
    const env: EncryptedEnvelope = {
      _noydb: 1, _v: 1, _ts: 't', _iv: 'i', _data: 'd',
      _vdig: { password: 'iv:data' },
    }
    expect(env._vdig?.password).toBe('iv:data')
  })

  it('VdigFieldPolicy + ClassifiedVerdict + digest-only spec typecheck', () => {
    const p: VdigFieldPolicy = { normalize: 'password', notLastN: 3, rotateDays: 90 }
    const v: ClassifiedVerdict = { ok: true, mustRotate: true }
    const spec: ClassifiedFieldSpec = {
      _noydbClassified: true, preset: 'password', storage: 'digest-only',
      sensitivity: 'secret', list: { kind: 'omit' },
      verifyNormalize: 'password', notLastN: 3,
    }
    expect(p.notLastN + Number(v.ok) + spec.preset.length).toBeGreaterThan(0)
  })

  it('new error classes carry collection/field and stable names', () => {
    const e1 = new ClassifiedVerifyError('users', 'password', 'field is not classified')
    const e2 = new ClassifiedRotationError('users', 'password', 'password was used recently')
    expect(e1.name).toBe('ClassifiedVerifyError')
    expect(e2.message).toContain('used recently')
  })

  it('with-shape errors.ts re-exports the moved kernel classes (same identity)', () => {
    expect(ShimConfig).toBe(ClassifiedConfigError)
    expect(ShimReveal).toBe(ClassifiedRevealError)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/hub/__tests__/classified/stage2-spine.test.ts`
Expected: FAIL — `_vdig` unknown on `EncryptedEnvelope`, missing exports in `kernel/errors.js`.

- [ ] **Step 3: Implement** — apply the four file edits exactly as specified in **Interfaces** above, plus create `harness.ts`:

```ts
// packages/hub/__tests__/classified/harness.ts
import { ConflictError } from '../../src/kernel/errors.js'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../../src/kernel/types.js'

export interface InlineMemoryStore extends NoydbStore {
  /** Test-only raw envelope peek (bypasses the hub read path). */
  _dump(vault: string, collection: string, id: string): EncryptedEnvelope | undefined
}

export function inlineMemory(): InlineMemoryStore {
  const store = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  function gc(c: string, col: string) {
    let comp = store.get(c)
    if (!comp) { comp = new Map(); store.set(c, comp) }
    let coll = comp.get(col)
    if (!coll) { coll = new Map(); comp.set(col, coll) }
    return coll
  }
  return {
    async get(c, col, id) { return store.get(c)?.get(col)?.get(id) ?? null },
    async put(c, col, id, env, ev) {
      const coll = gc(c, col)
      const ex = coll.get(id)
      if (ev !== undefined && ex && ex._v !== ev) throw new ConflictError(ex._v)
      coll.set(id, env)
    },
    async delete(c, col, id) { store.get(c)?.get(col)?.delete(id) },
    async list(c, col) { const coll = store.get(c)?.get(col); return coll ? [...coll.keys()] : [] },
    async loadAll(c) {
      const comp = store.get(c)
      const s: VaultSnapshot = {}
      if (comp) {
        for (const [n, coll] of comp) {
          if (!n.startsWith('_')) {
            const r: Record<string, EncryptedEnvelope> = {}
            for (const [id, e] of coll) r[id] = e
            s[n] = r
          }
        }
      }
      return s
    },
    async saveAll(c, data) {
      for (const [n, recs] of Object.entries(data)) {
        const coll = gc(c, n)
        for (const [id, e] of Object.entries(recs)) coll.set(id, e)
      }
    },
    _dump(c, col, id) { return store.get(c)?.get(col)?.get(id) },
  }
}
```

Do NOT rewrite the stage-1 tests' inline copies (surgical-changes rule) — new stage-2 tests use the harness; stage-1 files stay untouched.

- [ ] **Step 4: Run tests to verify GREEN**

Run: `pnpm vitest run packages/hub/__tests__/classified/ && pnpm --filter @noy-db/hub typecheck`
Expected: PASS (stage-1 suite still green — the error move is identity-preserving), typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add packages/hub/src/kernel/types.ts packages/hub/src/kernel/errors.ts packages/hub/src/with-shape/classified/errors.ts packages/hub/src/with-shape/classified/descriptor.ts packages/hub/__tests__/classified/harness.ts packages/hub/__tests__/classified/stage2-spine.test.ts
git commit -m "feat(classified): _vdig envelope slot + spine policy/verdict types + kernel-owned errors"
```

---

### Task 7: Layer B — codec write path: mint/carry-forward/rotate/clear + I4/I5 + R6 write-side + ring

**Files:**
- Create: `packages/hub/src/kernel/enclave/classify/write.ts` (`mintVdigSlot`)
- Modify: `packages/hub/src/kernel/enclave/record-keys/record-codec.ts` (ctx `vdigFields`; `encryptRecord` gains trailing `vdig?: { id, prev }` param + the C6 branch block; `_det` exclusion at record-codec.ts:234)
- Test: `packages/hub/__tests__/classified/codec-vdig-write.test.ts`

**Interfaces:**
- Consumes: Task 1 (`pbkdf2VerifyDigest`, `VDIG_ITERATIONS`, `normalizeForVerify`), Task 2 (`blindedEqual`), Task 4 (`sealVdigPayload`/`openVdigPayload`/`VdigPayload`), Task 6 (`VdigFieldPolicy`, `ClassifiedRotationError`, `_vdig`), plus existing `generateSalt`, `bufferToBase64`, `base64ToBuffer` from `../crypto.js` and `ValidationError` from `../../errors.js`.
- Produces:
  - `export async function mintVdigSlot(rawValue: string, policy: VdigFieldPolicy, prevBlob: string | undefined, cek: EnclaveKey, collection: string, recordId: string, field: string): Promise<string>` — normalize → notLastN reuse check against `cur` + every `ring` entry (each via pbkdf2+blindedEqual; match → `ClassifiedRotationError(collection, field, 'password was used recently')`) → fresh 32-byte salt digest at `VDIG_ITERATIONS` → previous `cur` shifts into `ring` (oldest-first, trimmed to `notLastN`) → `sealVdigPayload`.
  - `RecordCodecContext` gains `readonly vdigFields: ReadonlyMap<string, VdigFieldPolicy> | null`.
  - `RecordCodec.encryptRecord(record, version, cek?, source?, sourceTs?, vdig?: { readonly id: string; readonly prev: EncryptedEnvelope | null }): Promise<EncryptedEnvelope>` with, per digest-only field, exactly one of the four C6 branches (absent → verbatim carry-forward of `prev._vdig[field]`; string → rotate; `null` → clear; other → `ValidationError`), fail-loud when `vdigFields` is non-empty and `vdig`/`cek` is missing, R6 write-side `ClassifiedConfigError` when the value is present and `prev._sealed[field]` exists, `_data` strip, no `_sealed[field]` emission (structural — digest-only fields are never in `sensitiveFields`, enforced later by R5), and `_det` exclusion (I5).

- [ ] **Step 1: Write the failing test** — drives the codec directly (unit level; collection-level plumbing is Task 8). Uses `VDIG_ITERATIONS`-real digests only where the ring is involved (accepting ~1-2 s of PBKDF2 per ring assertion).

```ts
// packages/hub/__tests__/classified/codec-vdig-write.test.ts
import { describe, it, expect } from 'vitest'
import { RecordCodec } from '../../src/kernel/enclave/index.js'
import { generateDEK } from '../../src/kernel/enclave/index.js'
import { openVdigPayload } from '../../src/kernel/enclave/classify/vdig.js'
import { NO_CRDT } from '../../src/kernel/collection-config.js'
import type { VdigFieldPolicy, EncryptedEnvelope } from '../../src/kernel/types.js'
import { ClassifiedConfigError, ClassifiedRotationError, ValidationError } from '../../src/kernel/errors.js'

// NOTE: if NO_CRDT lives elsewhere, mirror whatever record-codec.test peers
// use; the codec ctx only needs a crdtStrategy stub with resolveCrdtSnapshot.

type Rec = Record<string, unknown>

async function makeCodec(vdigFields: ReadonlyMap<string, VdigFieldPolicy> | null, extras: Partial<Record<string, unknown>> = {}) {
  const dek = await generateDEK()
  const codec = new RecordCodec<Rec>({
    name: 'users', actor: 'tester', storeCiphertext: true, debugPlaintext: false,
    provenance: false, sensitiveFields: new Set<string>(),
    deterministicFields: null, crdtMode: undefined,
    crdtStrategy: NO_CRDT, schema: undefined,
    getDEK: async () => dek, cekCache: null,
    vdigFields,
    ...extras,
  } as never)
  return { codec, dek }
}

const pw: VdigFieldPolicy = { normalize: 'password', notLastN: 0 }

describe('encryptRecord digest-only branches (C6)', () => {
  it('rotate branch: string value → _vdig slot, field stripped from _data, no _sealed', async () => {
    const { codec } = await makeCodec(new Map([['password', pw]]))
    const cek = await generateDEK()
    const env = await codec.encryptRecord({ name: 'Nok', password: 'hunter2-hunter2' }, 1, cek, undefined, undefined, { id: 'r1', prev: null })
    expect(env._vdig?.password).toMatch(/^[^:]+:.+$/)
    expect(env._sealed?.password).toBeUndefined()          // I4 mutual exclusion
    const payload = await openVdigPayload(env._vdig!.password!, cek, 'users', 'r1', 'password')
    expect(payload.v).toBe(1)
    expect(payload.iter).toBe(600_000)
    // decrypt _data and prove the plaintext is gone
    const back = await codec.decryptRecord(env, { id: 'r1' })
    expect(back).toEqual({ name: 'Nok' })
  }, 30_000)

  it('carry-forward branch: field absent → prev._vdig copied BYTE-VERBATIM', async () => {
    const { codec } = await makeCodec(new Map([['password', pw]]))
    const cek = await generateDEK()
    const v1 = await codec.encryptRecord({ name: 'Nok', password: 'hunter2-hunter2' }, 1, cek, undefined, undefined, { id: 'r1', prev: null })
    const v2 = await codec.encryptRecord({ name: 'Somchai' }, 2, cek, undefined, undefined, { id: 'r1', prev: v1 })
    expect(v2._vdig?.password).toBe(v1._vdig?.password)    // verbatim bytes (ledger determinism)
  }, 30_000)

  it('clear branch: explicit null drops the slot and emits nothing into _data', async () => {
    const { codec } = await makeCodec(new Map([['password', pw]]))
    const cek = await generateDEK()
    const v1 = await codec.encryptRecord({ password: 'hunter2-hunter2' }, 1, cek, undefined, undefined, { id: 'r1', prev: null })
    const v2 = await codec.encryptRecord({ password: null }, 2, cek, undefined, undefined, { id: 'r1', prev: v1 })
    expect(v2._vdig?.password).toBeUndefined()
    expect(await codec.decryptRecord(v2, { id: 'r1' })).toEqual({})
  }, 30_000)

  it('validate branch: non-string non-null value is a loud ValidationError', async () => {
    const { codec } = await makeCodec(new Map([['password', pw]]))
    const cek = await generateDEK()
    await expect(
      codec.encryptRecord({ password: 42 }, 1, cek, undefined, undefined, { id: 'r1', prev: null }),
    ).rejects.toBeInstanceOf(ValidationError)
  })

  it('fail-loud: vdig ctx omitted on a digest-only collection (any missed call site = C6 wipe)', async () => {
    const { codec } = await makeCodec(new Map([['password', pw]]))
    const cek = await generateDEK()
    await expect(codec.encryptRecord({ name: 'x' }, 1, cek)).rejects.toThrow(/silently destroy _vdig|digest-only/)
  })

  it('R6 write-side: rotating a field that still has prev._sealed[field] throws ClassifiedConfigError', async () => {
    const { codec } = await makeCodec(new Map([['password', pw]]))
    const cek = await generateDEK()
    const prev: EncryptedEnvelope = {
      _noydb: 1, _v: 1, _ts: 't', _iv: 'i', _data: 'd',
      _sealed: { password: 'iv:stale-recoverable-slot' },
    }
    await expect(
      codec.encryptRecord({ password: 'new-password-1' }, 2, cek, undefined, undefined, { id: 'r1', prev }),
    ).rejects.toBeInstanceOf(ClassifiedConfigError)
  })

  it('I5: digest-only fields are excluded from _det even when declared deterministic', async () => {
    const { codec } = await makeCodec(new Map([['password', pw]]), { deterministicFields: new Set(['password', 'city']) })
    const cek = await generateDEK()
    const env = await codec.encryptRecord({ password: 'hunter2-hunter2', city: 'CNX' }, 1, cek, undefined, undefined, { id: 'r1', prev: null })
    expect(env._det?.password).toBeUndefined()
    expect(env._det?.city).toBeDefined()
  }, 30_000)
})

describe('notLastN ring (real 600K PBKDF2 — slow test)', () => {
  it('reuse of cur or a ring entry throws ClassifiedRotationError; ring trims to notLastN', async () => {
    const ringPw: VdigFieldPolicy = { normalize: 'password', notLastN: 2 }
    const { codec } = await makeCodec(new Map([['password', ringPw]]))
    const cek = await generateDEK()
    const v1 = await codec.encryptRecord({ password: 'password-one!' }, 1, cek, undefined, undefined, { id: 'r1', prev: null })
    const v2 = await codec.encryptRecord({ password: 'password-two!' }, 2, cek, undefined, undefined, { id: 'r1', prev: v1 })
    // reuse of the immediately-previous value → refused
    await expect(
      codec.encryptRecord({ password: 'password-one!' }, 3, cek, undefined, undefined, { id: 'r1', prev: v2 }),
    ).rejects.toBeInstanceOf(ClassifiedRotationError)
    // a fresh value is fine, and the ring holds ≤ notLastN entries
    const v3 = await codec.encryptRecord({ password: 'password-three!' }, 3, cek, undefined, undefined, { id: 'r1', prev: v2 })
    const payload = await openVdigPayload(v3._vdig!.password!, cek, 'users', 'r1', 'password')
    expect((payload.ring ?? []).length).toBeLessThanOrEqual(2)
  }, 120_000)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/hub/__tests__/classified/codec-vdig-write.test.ts`
Expected: FAIL — ctx rejects `vdigFields`, `encryptRecord` has no 6th param, `classify/write.js` missing. (If the `NO_CRDT` import path is wrong, fix the import — `grep -rn "export const NO_CRDT" packages/hub/src` — before judging RED.)

- [ ] **Step 3: Implement**

```ts
// packages/hub/src/kernel/enclave/classify/write.ts
/**
 * Digest-only write engine (C6 rotate branch + notLastN ring, spec §2/§4).
 * Called ONLY by RecordCodec.encryptRecord — both live inside the enclave.
 * @module
 */
import { generateSalt, bufferToBase64, base64ToBuffer, type EnclaveKey } from '../crypto.js'
import { pbkdf2VerifyDigest, VDIG_ITERATIONS } from './digest.js'
import { normalizeForVerify } from './normalize.js'
import { blindedEqual } from './compare.js'
import { sealVdigPayload, openVdigPayload, type VdigPayload, type VdigDigestEntry } from './vdig.js'
import { ClassifiedRotationError } from '../../errors.js'
import type { VdigFieldPolicy } from '../../types.js'

export async function mintVdigSlot(
  rawValue: string,
  policy: VdigFieldPolicy,
  prevBlob: string | undefined,
  cek: EnclaveKey,
  collection: string,
  recordId: string,
  field: string,
): Promise<string> {
  const normalized = normalizeForVerify(policy.normalize, rawValue)

  let prev: VdigPayload | null = null
  if (prevBlob !== undefined) {
    prev = await openVdigPayload(prevBlob, cek, collection, recordId, field)
  }

  // notLastN reuse refusal: candidate vs cur + every ring entry, each a full
  // PBKDF2 at the payload's own iteration count (n × 600K is the documented
  // write-time cost ceiling, cap 8 — spec Q4).
  if (prev !== null && policy.notLastN > 0) {
    const history: readonly VdigDigestEntry[] = [prev.cur, ...(prev.ring ?? [])]
    for (const entry of history) {
      const digest = await pbkdf2VerifyDigest(normalized, base64ToBuffer(entry.salt), prev.iter)
      if (await blindedEqual(digest, base64ToBuffer(entry.hash))) {
        throw new ClassifiedRotationError(collection, field, 'password was used recently')
      }
    }
  }

  const salt = generateSalt()
  const hash = await pbkdf2VerifyDigest(normalized, salt, VDIG_ITERATIONS)
  const ring = prev !== null && policy.notLastN > 0
    ? [...(prev.ring ?? []), { salt: prev.cur.salt, hash: prev.cur.hash }].slice(-policy.notLastN)
    : undefined

  const payload: VdigPayload = {
    v: 1,
    alg: 'PBKDF2-SHA256',
    iter: VDIG_ITERATIONS,
    cur: { salt: bufferToBase64(salt), hash: bufferToBase64(hash), at: new Date().toISOString() },
    ...(ring !== undefined && ring.length > 0 ? { ring } : {}),
  }
  return sealVdigPayload(payload, cek, collection, recordId, field)
}
```

`record-codec.ts` edits:

1. Ctx member (after `deterministicFields`):

```ts
  /** Digest-only classified fields → verify policy (stage 2). Null when none. */
  readonly vdigFields: ReadonlyMap<string, VdigFieldPolicy> | null
```

with `import { mintVdigSlot } from '../classify/write.js'`, `import { ClassifiedConfigError, ValidationError } from '../../errors.js'` (extend the existing errors import) and `VdigFieldPolicy` added to the types import.

2. `encryptRecord` signature gains the trailing param:

```ts
  async encryptRecord(
    record: T,
    version: number,
    cek?: EnclaveKey,
    source?: string,
    sourceTs?: string,
    vdig?: { readonly id: string; readonly prev: EncryptedEnvelope | null },
  ): Promise<EncryptedEnvelope> {
```

3. Insert the C6 block AFTER the sealed-peel block (after line ~220, before `encryptJsonString`):

```ts
    // ── Digest-only classified fields (stage 2, C6) ────────────────────
    // Per field, exactly one of: carry-forward (absent) / rotate (string) /
    // clear (null) / loud error (anything else). Runs on a CLONE so the
    // caller's record object is never mutated.
    let vdigOut: Record<string, string> | undefined
    if (this.ctx.vdigFields !== null && this.ctx.vdigFields.size > 0 && this.ctx.storeCiphertext) {
      if (vdig === undefined) {
        throw new Error(
          `RecordCodec.encryptRecord: collection "${this.ctx.name}" declares digest-only classified ` +
          `fields but this write path supplied no { id, prev } context — it would silently destroy _vdig (C6). Caller bug.`,
        )
      }
      if (cek === undefined) {
        throw new Error(
          `RecordCodec.encryptRecord: digest-only fields require a per-record CEK (R1 invariant) — ` +
          `collection "${this.ctx.name}" wrote without one. Caller bug.`,
        )
      }
      const open: Record<string, unknown> = { ...(openRecord as unknown as Record<string, unknown>) }
      const out: Record<string, string> = {}
      for (const [field, policy] of this.ctx.vdigFields) {
        const value = open[field]
        const prevBlob = vdig.prev?._vdig?.[field]
        if (value === undefined) {
          // 1. carry-forward: verbatim bytes (CEK version-stable, AAD _v-free;
          //    byte-identity keeps the ledger payload hash deterministic).
          if (prevBlob !== undefined) out[field] = prevBlob
          continue
        }
        if (value === null) {
          // 3. clear: the defined deletion short of forget().
          delete open[field]
          continue
        }
        if (typeof value !== 'string') {
          // 4. caller bug, fail-loud.
          throw new ValidationError(
            `digest-only classified field "${field}" in "${this.ctx.name}" must be a string (rotate) or null (clear), got ${typeof value}`,
          )
        }
        if (vdig.prev?._sealed?.[field] !== undefined) {
          // R6 transition evidence: never silently delete recoverable plaintext.
          throw new ClassifiedConfigError(
            this.ctx.name,
            `field "${field}" carries a recoverable _sealed slot from a previous storage form — ` +
            `recoverable ↔ digest-only transitions are refused (R6); migrate explicitly`,
          )
        }
        // 2. rotate: validate ran in the stage-1 write seam; digest + ring here.
        out[field] = await mintVdigSlot(value, policy, prevBlob, cek, this.ctx.name, vdig.id, field)
        delete open[field] // strip from _data — digest-only never persists plaintext
      }
      openRecord = open as unknown as T
      if (Object.keys(out).length > 0) vdigOut = out
    }
```

4. Widen the envelope assembly (currently `const withSealed = sealed ? ... : base`):

```ts
    const base = await this.encryptJsonString(JSON.stringify(openRecord), version, cek, source, sourceTs)
    const withSealed = sealed ? { ...base, _sealed: sealed } : base
    const withVdig = vdigOut ? { ...withSealed, _vdig: vdigOut } : withSealed
    if (!this.ctx.deterministicFields || !this.ctx.storeCiphertext) return withVdig
```

(and the two later `return withSealed` / spread sites become `withVdig`).

5. I5 `_det` mirror at record-codec.ts:234 — extend the exclusion:

```ts
      if (this.ctx.sensitiveFields.has(field)) continue
      if (this.ctx.vdigFields?.has(field)) continue // I5: digest-only never equality-correlatable
```

6. Every OTHER constructor of `RecordCodecContext` in `packages/hub/src` must now pass `vdigFields` — run `pnpm --filter @noy-db/hub typecheck` and add `vdigFields: null` at each site the compiler reports EXCEPT `collection.ts` (Task 8 wires the real map; for this task set `vdigFields: null` there too so the tree stays green — Task 8 replaces it).

- [ ] **Step 4: Run tests to verify GREEN**

Run: `pnpm vitest run packages/hub/__tests__/classified/codec-vdig-write.test.ts && pnpm --filter @noy-db/hub typecheck`
Expected: PASS (9 tests; the ring test takes ~10-30 s of real PBKDF2), typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add packages/hub/src/kernel/enclave/classify/write.ts packages/hub/src/kernel/enclave/record-keys/record-codec.ts packages/hub/src/kernel/collection.ts packages/hub/__tests__/classified/codec-vdig-write.test.ts
git commit -m "feat(classified): codec digest-only write branches — carry-forward/rotate/clear + ring + I4/I5/R6 (C6)"
```

---

### Task 8: Layer B — collection plumbing: `vdigFields` wiring + prev-envelope threading  ⚠ kernel-surface

**Files:**
- Modify: `packages/hub/src/kernel/collection-config.ts` (build `vdigFields` from resolved classified; return it)
- Modify: `packages/hub/src/kernel/collection.ts` (store `this.vdigFields`; pass into codec ctx; thread `{ id, prev }` through every `encryptRecord` call site)
- Modify: `scripts/check-architecture.mjs` (**kernel-surface ceiling bump for `collection.ts` in this task**, entry at scripts/check-architecture.mjs:649)
- Test: `packages/hub/__tests__/classified/put-carry-forward.test.ts`

**Interfaces:**
- Consumes: Task 7 codec signature; Task 6 descriptor (`storage: 'digest-only'`, `verifyNormalize`, `notLastN`, `rotateDays`).
- Produces: end-to-end `put()` behavior — a digest-only collection (declared via raw `ClassifiedFieldSpec` until presets land in Task 12) writes `_vdig`, carries it across unrelated updates, clears on `null`. Later tasks rely on `private readonly vdigFields: ReadonlyMap<string, VdigFieldPolicy> | null` existing on `Collection`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/hub/__tests__/classified/put-carry-forward.test.ts
import { describe, it, expect } from 'vitest'
import { createNoydb } from '../../src/kernel/noydb.js'
import { inlineMemory } from './harness.js'
import type { ClassifiedFieldSpec } from '../../src/with-shape/classified/descriptor.js'

// Raw spec (presets land in Task 12). minLength validation is stage-1 write-seam work.
const passwordSpec: ClassifiedFieldSpec = {
  _noydbClassified: true, preset: 'password', storage: 'digest-only',
  sensitivity: 'secret', list: { kind: 'omit' }, verifyNormalize: 'password',
}

async function openUsers(store = inlineMemory()) {
  const db = await createNoydb({ store, user: 'a', secret: 'pw-s2-8' })
  const v = await db.openVault('v1')
  const c = v.collection<Record<string, unknown>>('users', {
    perRecordKeys: true,
    classifiedFields: { password: passwordSpec },
  })
  return { store, c }
}

describe('put() carry-forward (C6 end-to-end)', () => {
  it('writes _vdig, strips plaintext, and an unrelated update carries the slot byte-verbatim', async () => {
    const { store, c } = await openUsers()
    await c.put('u1', { name: 'Nok', password: 'correct-horse-battery' })
    const e1 = store._dump('v1', 'users', 'u1')!
    expect(e1._vdig?.password).toMatch(/^[^:]+:.+$/)
    expect(e1._sealed?.password).toBeUndefined()
    expect(JSON.stringify(await c.get('u1'))).not.toContain('correct-horse')

    await c.put('u1', { name: 'Nok Jaidee' })          // password absent from the write
    const e2 = store._dump('v1', 'users', 'u1')!
    expect(e2._vdig?.password).toBe(e1._vdig?.password) // byte-verbatim carry-forward
    expect((await c.get('u1')) as Record<string, unknown>).toMatchObject({ name: 'Nok Jaidee' })
  }, 60_000)

  it('explicit null clears the slot', async () => {
    const { store, c } = await openUsers()
    await c.put('u1', { name: 'Nok', password: 'correct-horse-battery' })
    await c.put('u1', { name: 'Nok', password: null })
    expect(store._dump('v1', 'users', 'u1')!._vdig?.password).toBeUndefined()
  }, 60_000)

  it('history snapshots carry the displaced _vdig (M3)', async () => {
    // History strategy defaults on; the snapshot is written to the _history-side
    // namespace by historyStrategy.saveHistory — assert via a second update after
    // which the LIVE envelope still has _vdig (regression canary for prev-threading
    // through the history encryptRecord call site: without it the codec fail-loud
    // throw from Task 7 fires and this put() rejects).
    const { store, c } = await openUsers()
    await c.put('u1', { name: 'a', password: 'correct-horse-battery' })
    await c.put('u1', { name: 'b' })
    await c.put('u1', { name: 'c' })
    expect(store._dump('v1', 'users', 'u1')!._vdig?.password).toBeDefined()
  }, 60_000)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/hub/__tests__/classified/put-carry-forward.test.ts`
Expected: FAIL — the codec throws the Task-7 fail-loud error (`no { id, prev } context`) because `collection.ts` still passes `vdigFields: null` / no `vdig` arg. That RED proves the fail-loud guard works end-to-end.

- [ ] **Step 3: Implement**

`collection-config.ts` — after the `classifiedSensitive` block (~line 513), add:

```ts
  // Digest-only classified fields → the enclave-consumable policy map
  // (stage 2). Both the codec write path and the verify engine key off it.
  const vdigEntries: Array<readonly [string, VdigFieldPolicy]> =
    resolvedClassified === undefined ? [] :
      Object.entries(resolvedClassified.byField)
        .filter(([, s]) => s.storage === 'digest-only')
        .map(([f, s]) => [f, {
          normalize: s.verifyNormalize ?? 'password',
          notLastN: s.notLastN ?? 0,
          ...(s.rotateDays !== undefined ? { rotateDays: s.rotateDays } : {}),
        }] as const)
  const vdigFields: ReadonlyMap<string, VdigFieldPolicy> | null =
    vdigEntries.length > 0 ? new Map(vdigEntries) : null
```

with `import type { VdigFieldPolicy } from './types.js'` (extend the existing types import) and `vdigFields,` added to the returned object.

`collection.ts`:

1. Constructor: `this.vdigFields = cfg.vdigFields` (new `private readonly vdigFields: ReadonlyMap<string, VdigFieldPolicy> | null` field beside `classified`), and the codec-ctx construction passes `vdigFields: this.vdigFields` instead of `null`.
2. `_putInternal`: right after the `const cek = this.perRecordCek ? await this.resolveRecordCek(id) : undefined` line (~1822), add:

```ts
    // Digest-only classified fields need the PREVIOUS live envelope: the codec
    // carries `_vdig` forward when a field is absent from this write (C6).
    // One adapter read, only on vdig collections — zero-cost otherwise.
    const vdigCtx = this.vdigFields !== null
      ? { id, prev: await this.adapter.get(this.vault, this.name, id) }
      : undefined
```

then thread `vdigCtx` as the 6th argument into BOTH the history-snapshot call (collection.ts:1828) and the main write (collection.ts:1846):

```ts
      const historyEnvelope = await this.codec.encryptRecord(existing.record, existing.version, cek, undefined, undefined, vdigCtx)
      ...
    const envelope = await this.codec.encryptRecord(record, version, cek, options?.source, options?.sourceTs, vdigCtx)
```

3. The remaining `encryptRecord` call sites (grep `this.codec.encryptRecord` — collection.ts:881, 1743, 2415, 2559, 3814):
   - **collection.ts:1743** and **collection.ts:2415** (migration/re-encrypt paths with the live envelope in scope): pass `this.vdigFields !== null ? { id, prev: existingEnvelope } : undefined` (1743) / `{ id, prev: env }` (2415).
   - **collection.ts:2559** (delete-path history snapshot): fetch like `_putInternal` — `const prevForVdig = this.vdigFields !== null ? await this.adapter.get(this.vault, this.name, id) : null` and pass `this.vdigFields !== null ? { id, prev: prevForVdig } : undefined`.
   - **collection.ts:3814** (`dumpEnvelopes`): inside the loop, `const prevForVdig = this.vdigFields !== null ? await this.adapter.get(this.vault, this.name, id) : null` and pass the same shape (dump is cold-path; N extra reads only on vdig collections).
   - **collection.ts:881** (custom conflict-resolver merge): pass nothing, with a comment — `// R2 refuses digest-only × conflictPolicy; on a vdig collection this path is unreachable and the codec fail-loud guard backstops it.`
4. Kernel-surface ceiling: `pnpm check:architecture` will report `collection.ts is N lines, over its 4357-line ceiling`. Update `scripts/check-architecture.mjs:649` to the actual N with an appended justification comment:

```js
  // Bumped 4357→<N> (2026-07-04, classified stage 2): prev-envelope threading for
  // digest-only `_vdig` carry-forward (C6) — thin { id, prev } plumbing at the
  // encryptRecord call sites; the digest/carry crypto lives in kernel/enclave/classify/.
  'packages/hub/src/kernel/collection.ts': <N>,
```

- [ ] **Step 4: Run tests to verify GREEN**

Run: `pnpm vitest run packages/hub/__tests__/classified/ && pnpm --filter @noy-db/hub typecheck && pnpm check:architecture`
Expected: all PASS, architecture clean with the bumped ceiling.

- [ ] **Step 5: Commit**

```bash
git add packages/hub/src/kernel/collection-config.ts packages/hub/src/kernel/collection.ts scripts/check-architecture.mjs packages/hub/__tests__/classified/put-carry-forward.test.ts
git commit -m "feat(classified): thread prev envelope + vdigFields through the collection write path (C6)"
```

---

### Task 9: Layer B — `rotateRecordCek` / `revokeSealedRecord` re-encrypt `_vdig` (C3)

**Files:**
- Modify: `packages/hub/src/kernel/enclave/record-keys/sealing.ts` (`rotateRecordCek`, mirroring the `_sealed` re-seal block at sealing.ts:182-191)
- Test: `packages/hub/__tests__/classified/rotate-preserves-vdig.test.ts`

**Interfaces:**
- Consumes: Task 4 (`openVdigPayload`/`sealVdigPayload`), Task 6 (`_vdig`), Task 8 (end-to-end put writes `_vdig`); existing `SealingContext`, `rotateRecordCek(ctx, collection, id)`, `revokeSealedRecord(ctx, collection, id, pid, opts)`.
- Produces: after a hard rotation, every `_vdig[field]` slot decrypts under the NEW CEK with the SAME reconstructed AAD. Single read under the old CEK — **no DEK fallback exists (I3)**, so unlike `_sealed` this is not a dual-read.

- [ ] **Step 1: Write the failing test**

```ts
// packages/hub/__tests__/classified/rotate-preserves-vdig.test.ts
import { describe, it, expect } from 'vitest'
import { createNoydb } from '../../src/kernel/noydb.js'
import { inlineMemory } from './harness.js'
import { openVdigPayload } from '../../src/kernel/enclave/classify/vdig.js'
import { unwrapCek } from '../../src/kernel/enclave/index.js'
import type { ClassifiedFieldSpec } from '../../src/with-shape/classified/descriptor.js'

const passwordSpec: ClassifiedFieldSpec = {
  _noydbClassified: true, preset: 'password', storage: 'digest-only',
  sensitivity: 'secret', list: { kind: 'omit' }, verifyNormalize: 'password',
}

describe('C3 — CEK rotation preserves _vdig', () => {
  it('rotateRecordCek re-encrypts the slot under the new CEK (same AAD, still openable)', async () => {
    const store = inlineMemory()
    const db = await createNoydb({ store, user: 'a', secret: 'pw-s2-9' })
    const v = await db.openVault('v1')
    const c = v.collection<Record<string, unknown>>('users', {
      perRecordKeys: true, classifiedFields: { password: passwordSpec },
    })
    await c.put('u1', { name: 'Nok', password: 'correct-horse-battery' })
    const before = store._dump('v1', 'users', 'u1')!

    await v.rotateRecordCek('users', 'u1')

    const after = store._dump('v1', 'users', 'u1')!
    expect(after._cek).not.toBe(before._cek)
    expect(after._vdig?.password).toBeDefined()
    expect(after._vdig?.password).not.toBe(before._vdig?.password) // re-sealed, not orphaned bytes
    // Prove the slot opens under the NEW CEK with the reconstructed AAD —
    // unwrap the rotated _cek via the collection DEK, exposed for tests through
    // the vault's DEK accessor used by the sealing ctx. If no public accessor
    // exists, assert indirectly instead: a follow-up unrelated put() carries the
    // slot forward without the codec's open-on-carry throwing — carry-forward
    // never decrypts, so ALSO do a Task-15 style verify once available. For
    // this task the load-bearing assertions are the two above plus:
    await c.put('u1', { name: 'Nok Jaidee' }) // must not throw
    expect(store._dump('v1', 'users', 'u1')!._vdig?.password).toBe(after._vdig?.password)
  }, 60_000)

  it('revokeSealedRecord({ hard: true }) delegates and preserves _vdig', async () => {
    const store = inlineMemory()
    const db = await createNoydb({ store, user: 'a', secret: 'pw-s2-9b' })
    const v = await db.openVault('v1')
    const c = v.collection<Record<string, unknown>>('users', {
      perRecordKeys: true, classifiedFields: { password: passwordSpec },
    })
    await c.put('u1', { password: 'correct-horse-battery' })
    await v.revokeSealedRecord('users', 'u1', 'some-pid', { hard: true })
    expect(store._dump('v1', 'users', 'u1')!._vdig?.password).toBeDefined()
  }, 60_000)
})
```

(If `vault.rotateRecordCek` / `vault.revokeSealedRecord` have different public names/arities on this branch, check `packages/hub/src/kernel/vault.ts` and adjust the calls — the sealing functions themselves are the fixture under test.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/hub/__tests__/classified/rotate-preserves-vdig.test.ts`
Expected: FAIL — `after._vdig` is `undefined` (rotation rebuilds from the `_tier`/`_det`/`_sealed` allowlist and drops `_vdig` — the exact C3 data-loss bug).

- [ ] **Step 3: Implement** — in `rotateRecordCek` (sealing.ts), after the `_sealed` re-seal block and before the `env` literal:

```ts
  // Verify-digest slots are keyed off the per-record CEK too (I3: CEK-only,
  // no DEK fallback → single read, not a dual-read). Rotation must re-seal
  // each `_vdig[field]` under the new CEK with the SAME reconstructed AAD, or
  // the correct password would false-reject forever (C3).
  let vdigOut: Record<string, string> | undefined
  if (live._vdig !== undefined) {
    const out: Record<string, string> = {}
    for (const [field, blob] of Object.entries(live._vdig)) {
      const payload = await openVdigPayload(blob, oldCek, collection, id, field)
      out[field] = await sealVdigPayload(payload, newCek, collection, id, field)
    }
    vdigOut = out
  }
```

with `import { openVdigPayload, sealVdigPayload } from '../classify/vdig.js'` added to the imports, and in the rotated-envelope literal (beside the `_sealed` spread):

```ts
    ...(vdigOut !== undefined ? { _vdig: vdigOut } : {}),
```

- [ ] **Step 4: Run tests to verify GREEN**

Run: `pnpm vitest run packages/hub/__tests__/classified/rotate-preserves-vdig.test.ts && pnpm vitest run packages/hub/__tests__/classified/`
Expected: PASS; no stage-1/stage-2 regressions.

- [ ] **Step 5: Commit**

```bash
git add packages/hub/src/kernel/enclave/record-keys/sealing.ts packages/hub/__tests__/classified/rotate-preserves-vdig.test.ts
git commit -m "fix(classified): rotateRecordCek re-encrypts _vdig under the new CEK (C3)"
```

---

### Task 10: Layer B — forget/tombstone: `_vdig` shred classification + structural drop

**Files:**
- Modify: `packages/hub/src/kernel/enclave/record-keys/record-codec.ts` (`classifySealedShred` vdig extension, record-codec.ts:337-356)
- Test: `packages/hub/__tests__/classified/forget-vdig.test.ts`

**Interfaces:**
- Consumes: Tasks 6/8; existing `buildTombstone` (structurally omits `_vdig` — fresh envelope literal), `vault.forget()` orchestration which calls the collection's `_classifySealedShred` shim.
- Produces: `classifySealedShred(live)` counts `_vdig` slot fields into `shreddable` **unconditionally on a `_cek` record** — vdig keys are CEK-only (I3), so there is NO vdig-dekResidue class; the return type/shape is unchanged (field names join the existing `shreddable` array).

- [ ] **Step 1: Write the failing test**

```ts
// packages/hub/__tests__/classified/forget-vdig.test.ts
import { describe, it, expect } from 'vitest'
import { createNoydb } from '../../src/kernel/noydb.js'
import { inlineMemory } from './harness.js'
import { buildTombstone } from '../../src/kernel/enclave/index.js'
import type { ClassifiedFieldSpec } from '../../src/with-shape/classified/descriptor.js'

const passwordSpec: ClassifiedFieldSpec = {
  _noydbClassified: true, preset: 'password', storage: 'digest-only',
  sensitivity: 'secret', list: { kind: 'omit' }, verifyNormalize: 'password',
}

describe('forget() × _vdig', () => {
  it('a tombstone structurally carries no _vdig', () => {
    expect(buildTombstone(4, 'actor')._vdig).toBeUndefined()
  })

  it('classifySealedShred reports vdig slots as shreddable on a _cek record (no dekResidue class)', async () => {
    const store = inlineMemory()
    const db = await createNoydb({ store, user: 'a', secret: 'pw-s2-10' })
    const v = await db.openVault('v1')
    const c = v.collection<Record<string, unknown>>('users', {
      perRecordKeys: true, sensitive: ['ssn'],
      classifiedFields: { password: passwordSpec },
    })
    await c.put('u1', { ssn: '123-45-6789', password: 'correct-horse-battery' })
    const live = store._dump('v1', 'users', 'u1')!
    expect(live._vdig?.password).toBeDefined()
    // reach the codec through the collection's internal shim, as forget() does
    const result = await (c as unknown as {
      _classifySealedShred(e: unknown): Promise<{ shreddable: string[]; dekResidue: string[] }>
    })._classifySealedShred(live)
    expect(result.shreddable).toContain('password')
    expect(result.shreddable).toContain('ssn')       // CEK-sealed slot, unchanged behavior
    expect(result.dekResidue).not.toContain('password')
  }, 60_000)
})
```

(If the shim is named differently, `grep -n "_classifySealedShred\|classifySealedShred" packages/hub/src/kernel/collection.ts packages/hub/src/kernel/vault.ts` and call whatever `vault.forget()` calls.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/hub/__tests__/classified/forget-vdig.test.ts`
Expected: FAIL — `result.shreddable` lacks `'password'` (`classifySealedShred` only walks `_sealed`).

- [ ] **Step 3: Implement** — in `classifySealedShred` (record-codec.ts), extend before the `_sealed` walk's return:

```ts
  async classifySealedShred(
    live: EncryptedEnvelope,
  ): Promise<{ shreddable: string[]; dekResidue: string[] }> {
    const shreddable: string[] = []
    const dekResidue: string[] = []
    // Verify-digest slots are CEK-only by construction (I3): dropping `_cek`
    // makes every `_vdig[field]` permanently undecryptable — shreddable
    // unconditionally, no vdig-dekResidue class (spec §2 forget()). Same
    // honesty caveats as #306 D5 for synced/backup copies of the ciphertext.
    if (live._vdig !== undefined && live._cek !== undefined) {
      shreddable.push(...Object.keys(live._vdig))
    }
    const sealed = live._sealed
    if (sealed === undefined) return { shreddable, dekResidue }
    ... // existing _sealed walk unchanged
  }
```

- [ ] **Step 4: Run tests to verify GREEN**

Run: `pnpm vitest run packages/hub/__tests__/classified/forget-vdig.test.ts && pnpm vitest run packages/hub/__tests__/forget 2>/dev/null || pnpm --filter @noy-db/hub test -- --run forget`
Expected: new test PASS; every existing forget-suite test still green (the extension only ADDS names on `_vdig` records, which no pre-existing fixture has).

- [ ] **Step 5: Commit**

```bash
git add packages/hub/src/kernel/enclave/record-keys/record-codec.ts packages/hub/__tests__/classified/forget-vdig.test.ts
git commit -m "feat(classified): classifySealedShred counts _vdig slots as CEK-shreddable"
```

---

### Task 11: Layer B — ledger hash conditional widen for `_vdig`

**Files:**
- Modify: `packages/hub/src/kernel/enclave/record-keys/envelope-body.ts` (`envelopeBodyForHash`)
- Modify: `packages/hub/src/with-commit/history/ledger/hash.ts` (doc comment only — the derivation lives in the enclave helper it already calls)
- Test: `packages/hub/__tests__/classified/vdig-ledger-hash.test.ts`

**Interfaces:**
- Consumes: Task 6 (`_vdig` type).
- Produces: `envelopeBodyForHash(env)` —
  - no `_sealed`, no `_vdig` → `_data` alone (byte-identical to legacy: no flag-day),
  - any of the two maps present → canonical JSON of `{ _data, _sealed?, _vdig? }`, keys sorted at every level, each map bound ONLY when present. This is the C1 temporal-rollback detector: a same-record same-field splice changes the ledger payload hash.

- [ ] **Step 1: Write the failing test**

```ts
// packages/hub/__tests__/classified/vdig-ledger-hash.test.ts
import { describe, it, expect } from 'vitest'
import { envelopeBodyForHash } from '../../src/kernel/enclave/index.js'
import type { EncryptedEnvelope } from '../../src/kernel/types.js'

const base = { _noydb: 1 as const, _v: 1, _ts: 't', _iv: 'i' }

describe('envelopePayloadHash conditional _vdig widen', () => {
  it('legacy: no _sealed, no _vdig → _data alone, byte-identical', () => {
    const env: EncryptedEnvelope = { ...base, _data: 'CIPHERTEXT' }
    expect(envelopeBodyForHash(env)).toBe('CIPHERTEXT')
  })

  it('_sealed-only output is unchanged from stage 1 (back-compat pin)', () => {
    const env: EncryptedEnvelope = { ...base, _data: 'D', _sealed: { b: '2', a: '1' } }
    expect(envelopeBodyForHash(env)).toBe('{"_data":"D","_sealed":{"a":"1","b":"2"}}')
  })

  it('binds _vdig when present, sorted, independent of insertion order', () => {
    const env: EncryptedEnvelope = { ...base, _data: 'D', _vdig: { pin: 'p', password: 'q' } }
    expect(envelopeBodyForHash(env)).toBe('{"_data":"D","_vdig":{"password":"q","pin":"p"}}')
  })

  it('binds both maps together (sorted top-level keys)', () => {
    const env: EncryptedEnvelope = { ...base, _data: 'D', _vdig: { p: 'v' }, _sealed: { s: 'x' } }
    expect(envelopeBodyForHash(env)).toBe('{"_data":"D","_sealed":{"s":"x"},"_vdig":{"p":"v"}}')
  })

  it('temporal-rollback detector: swapping a _vdig blob changes the body string', () => {
    const a: EncryptedEnvelope = { ...base, _data: 'D', _vdig: { password: 'old-blob' } }
    const b: EncryptedEnvelope = { ...base, _data: 'D', _vdig: { password: 'new-blob' } }
    expect(envelopeBodyForHash(a)).not.toBe(envelopeBodyForHash(b))
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/hub/__tests__/classified/vdig-ledger-hash.test.ts`
Expected: FAIL — the `_vdig`-carrying cases return `_data`-only / `_sealed`-only strings.

- [ ] **Step 3: Implement** — replace the body of `envelopeBodyForHash`:

```ts
export function envelopeBodyForHash(env: EncryptedEnvelope): string {
  // Conditional widen (stage 2): bind `_vdig` exactly the way `_sealed` is
  // bound — only when present. No existing envelope carries `_vdig`, so this
  // ships with no flag-day PROVIDED it lands in the same slice as the first
  // `_vdig` writer (it does — Tasks 7/8/11 are one branch). This binding is
  // the temporal-rollback detector completing C1: AAD stops cross-record/
  // cross-field splices; the ledger hash catches same-slot rollbacks.
  if (env._sealed === undefined && env._vdig === undefined) return env._data
  const mapPart = (key: '_sealed' | '_vdig', map: Record<string, string>): string => {
    const parts = Object.keys(map).sort().map(
      (k) => `${JSON.stringify(k)}:${JSON.stringify(map[k])}`,
    )
    return `${JSON.stringify(key)}:{${parts.join(',')}}`
  }
  const segments = [`"_data":${JSON.stringify(env._data)}`]
  if (env._sealed !== undefined) segments.push(mapPart('_sealed', env._sealed))
  if (env._vdig !== undefined) segments.push(mapPart('_vdig', env._vdig))
  return `{${segments.join(',')}}`
}
```

Update the `hash.ts` doc comment: extend the "Hashes the open `_data` ciphertext, plus the sealed-field ciphertext map (`_sealed`)" paragraph with "… and the verify-digest ciphertext map (`_vdig`), each bound only when present — the `_vdig` binding is the temporal-rollback detector for the C1 splice class. `rotateRecordCek` rewrites `_vdig` with no ledger entry, the same pre-existing rotation property `_sealed`/`_cek` already have (`verifyBackupIntegrity` flags rotated records until re-anchored)."

- [ ] **Step 4: Run tests to verify GREEN**

Run: `pnpm vitest run packages/hub/__tests__/classified/vdig-ledger-hash.test.ts && pnpm vitest run packages/hub/src/kernel/enclave 2>/dev/null; pnpm --filter @noy-db/hub test`
Expected: new tests PASS; the FULL hub suite green — this touches the ledger contract, so `envelope-body.test.ts`, ledger and backup-integrity suites must all still pass (the `_sealed`-only pin test above proves byte-compat).

- [ ] **Step 5: Commit**

```bash
git add packages/hub/src/kernel/enclave/record-keys/envelope-body.ts packages/hub/src/with-commit/history/ledger/hash.ts packages/hub/__tests__/classified/vdig-ledger-hash.test.ts
git commit -m "feat(classified): ledger payload hash conditionally binds _vdig (C1 temporal detector)"
```

---

### Task 12: Layer C — presets `password()` / `secretAnswer()` + R5 in resolve + null-clear write seam + barrel exports  ⚠ goldens

**Files:**
- Modify: `packages/hub/src/with-shape/classified/presets.ts` (+2 presets)
- Modify: `packages/hub/src/with-shape/classified/resolve.ts` (R5: storage-form exclusivity message on double-claim)
- Modify: `packages/hub/src/with-shape/classified/write.ts` (`enforceClassifiedWrite`: `null` on a digest-only field is the explicit clear — skip validators)
- Modify: `packages/hub/src/with-shape/classified/index.ts` (+`ClassifiedVerifyError`, `ClassifiedRotationError` re-exports)
- Modify: `packages/hub/src/index.ts` (root barrel: +`ClassifiedVerifyError`, `ClassifiedRotationError`)
- Modify: `packages/hub/__tests__/root-barrel-surface.golden.json` and `packages/hub/__tests__/with-surface.golden.json` (**frozen goldens — additive updates in this task**)
- Test: `packages/hub/__tests__/classified/digest-presets.test.ts`

**Interfaces:**
- Consumes: Task 6 descriptor fields + kernel errors.
- Produces:
  - `classified.password(opts?: { minLength?: number; rotateDays?: number; notLastN?: number }): ClassifiedFieldSpec` — `storage: 'digest-only'`, `sensitivity: 'secret'`, `list: { kind: 'omit' }`, `verifyNormalize: 'password'`, default `minLength` 10, `notLastN` integer 0..8 (throw `Error` outside the cap), NFC-aware minLength validator.
  - `classified.secretAnswer(): ClassifiedFieldSpec` — `storage: 'digest-only'`, `verifyNormalize: 'secret-answer'`, `verifyGroupMember: true`, non-empty-post-normalization validator.

- [ ] **Step 1: Write the failing test**

```ts
// packages/hub/__tests__/classified/digest-presets.test.ts
import { describe, it, expect } from 'vitest'
import { classified } from '../../src/with-shape/classified/presets.js'
import { resolveClassifiedFields } from '../../src/with-shape/classified/resolve.js'
import { enforceClassifiedWrite } from '../../src/with-shape/classified/write.js'
import { ClassifiedConfigError, ClassifiedVerifyError, ClassifiedRotationError } from '../../src/kernel/errors.js'
import * as classifiedBarrel from '../../src/with-shape/classified/index.js'
import * as rootBarrel from '../../src/index.js'

describe('classified.password()', () => {
  it('is digest-only, omit-listed, password-normalized, with policy knobs', () => {
    const spec = classified.password({ minLength: 12, rotateDays: 90, notLastN: 3 })
    expect(spec.storage).toBe('digest-only')
    expect(spec.list).toEqual({ kind: 'omit' })
    expect(spec.verifyNormalize).toBe('password')
    expect(spec.rotateDays).toBe(90)
    expect(spec.notLastN).toBe(3)
    expect(spec.validate?.('short')).toMatch(/at least 12/)
    expect(spec.validate?.('long-enough-pw!')).toBeNull()
  })

  it('defaults minLength 10 and caps notLastN at 8', () => {
    const spec = classified.password()
    expect(spec.validate?.('123456789')).not.toBeNull()
    expect(spec.validate?.('1234567890')).toBeNull()
    expect(() => classified.password({ notLastN: 9 })).toThrow(/0\.\.8/)
    expect(() => classified.password({ notLastN: -1 })).toThrow(/0\.\.8/)
  })
})

describe('classified.secretAnswer()', () => {
  it('is digest-only, groupable, non-empty-post-normalization', () => {
    const spec = classified.secretAnswer()
    expect(spec.storage).toBe('digest-only')
    expect(spec.verifyGroupMember).toBe(true)
    expect(spec.verifyNormalize).toBe('secret-answer')
    expect(spec.validate?.('   ')).not.toBeNull()
    expect(spec.validate?.(' Fluffy ')).toBeNull()
  })
})

describe('R5 — storage forms mutually exclusive per field', () => {
  it('a field claimed under two forms is refused with a form-exclusivity message', () => {
    expect(() => resolveClassifiedFields('users', {
      password: classified.password(),
      grp: { _noydbClassifiedGroup: true, preset: 'g', members: { password: classified.secretAnswer() } },
    })).toThrow(ClassifiedConfigError)
  })
})

describe('null-clear passes the write seam', () => {
  it('enforceClassifiedWrite skips validators for null on a digest-only field', () => {
    const byField = { password: classified.password() }
    expect(() => enforceClassifiedWrite({ password: null }, byField, 'users')).not.toThrow()
    // but null on a recoverable field still validates as before
    const rec = { email: classified.email() }
    expect(() => enforceClassifiedWrite({ email: null }, rec, 'users')).toThrow()
  })
})

describe('barrel exports', () => {
  it('classified subpath + root barrel export the stage-2 errors', () => {
    expect(classifiedBarrel.ClassifiedVerifyError).toBe(ClassifiedVerifyError)
    expect(classifiedBarrel.ClassifiedRotationError).toBe(ClassifiedRotationError)
    expect((rootBarrel as Record<string, unknown>).ClassifiedVerifyError).toBe(ClassifiedVerifyError)
    expect((rootBarrel as Record<string, unknown>).ClassifiedRotationError).toBe(ClassifiedRotationError)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/hub/__tests__/classified/digest-presets.test.ts`
Expected: FAIL — `classified.password is not a function`.

- [ ] **Step 3: Implement**

`presets.ts` — append inside the `classified` object:

```ts
  /** Digest-only password: verify-without-reveal; never listed, never revealed.
   *  Enumeration math is on the caller for low-entropy values — see the
   *  per-preset docs; the hub ships no rate limiter in this slice (spec §5). */
  password(opts: { minLength?: number; rotateDays?: number; notLastN?: number } = {}): ClassifiedFieldSpec {
    const minLength = opts.minLength ?? 10
    const notLastN = opts.notLastN ?? 0
    if (!Number.isInteger(notLastN) || notLastN < 0 || notLastN > 8) {
      throw new Error(`classified.password: notLastN must be an integer 0..8 (write cost is n × 600K PBKDF2; ring blast radius is documented), got ${notLastN}`)
    }
    return {
      _noydbClassified: true, preset: 'password', storage: 'digest-only',
      sensitivity: 'secret', list: { kind: 'omit' },
      verifyNormalize: 'password',
      ...(opts.rotateDays !== undefined ? { rotateDays: opts.rotateDays } : {}),
      ...(notLastN > 0 ? { notLastN } : {}),
      validate: (v) => (typeof v === 'string' && v.normalize('NFC').length >= minLength
        ? null : `password must be at least ${minLength} characters`),
    }
  },

  /** Digest-only secret answer: normalized (casefold/trim/collapse), groupable
   *  into k-of-n matchGroup challenges. Low-entropy by nature — document the
   *  enumeration math to your users; add app-side rate limiting. */
  secretAnswer(): ClassifiedFieldSpec {
    return {
      _noydbClassified: true, preset: 'secretAnswer', storage: 'digest-only',
      sensitivity: 'secret', list: { kind: 'omit' },
      verifyNormalize: 'secret-answer', verifyGroupMember: true,
      validate: (v) => (typeof v === 'string'
        && v.normalize('NFC').toLowerCase().trim().replace(/\s+/g, ' ').length > 0
        ? null : 'secret answer must be non-empty after normalization'),
    }
  },
```

`resolve.ts` — in `claim()`, widen the double-claim message so R5 is explicit (behavior already refuses; the message now names the law):

```ts
    if (byField[field] !== undefined) {
      throw new ClassifiedConfigError(collection,
        `field "${field}" is claimed twice — storage forms are mutually exclusive per field (R5): ` +
        `a field is digest-only OR recoverable OR never, exactly one`)
    }
```

`write.ts` — in `enforceClassifiedWrite`'s loop, after the `undefined` skip:

```ts
    if (value === null && spec.storage === 'digest-only') continue // explicit clear (C6 branch 3)
```

`with-shape/classified/index.ts` — extend the errors re-export line with `ClassifiedVerifyError, ClassifiedRotationError`. `src/index.ts` — add the two names beside the existing `Classified*` error exports.

Golden updates: run the two golden tests; insert `"ClassifiedRotationError"` and `"ClassifiedVerifyError"` at their alphabetical positions in `root-barrel-surface.golden.json` and in the classified-subpath section of `with-surface.golden.json`.

- [ ] **Step 4: Run tests to verify GREEN**

Run: `pnpm vitest run packages/hub/__tests__/classified/digest-presets.test.ts packages/hub/__tests__/root-barrel-surface-golden.test.ts packages/hub/__tests__/with-surface-golden.test.ts`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/hub/src/with-shape/classified/presets.ts packages/hub/src/with-shape/classified/resolve.ts packages/hub/src/with-shape/classified/write.ts packages/hub/src/with-shape/classified/index.ts packages/hub/src/index.ts packages/hub/__tests__/root-barrel-surface.golden.json packages/hub/__tests__/with-surface.golden.json packages/hub/__tests__/classified/digest-presets.test.ts
git commit -m "feat(classified): password()/secretAnswer() digest-only presets + R5 + null-clear seam"
```

---

### Task 13: Layer C — Refusal matrix R1–R4 guards, BOTH doors + R6 session re-declaration  ⚠ kernel-surface

**Files:**
- Create: `packages/hub/src/with-shape/classified/guards.ts`
- Modify: `packages/hub/src/kernel/collection-config.ts` (build `classifiedGuardCtx`, run the guard at door 1, return the ctx + `hasConflictPolicy`)
- Modify: `packages/hub/src/kernel/collection.ts` (store `classifiedGuardCtx`; run the guard + R6 form-change refusal in `_applyClassifiedFields`, collection.ts:1153)
- Modify: `packages/hub/src/kernel/vault.ts` (plumb `subjectKeyField` from `forgetStrategy.subjects[collectionName]` into `collOpts`)
- Modify: `scripts/check-architecture.mjs` (ceiling bumps for `collection.ts` / `vault.ts` if tripped — bank actual line counts with a stage-2 justification comment, same style as Task 8)
- Test: `packages/hub/__tests__/classified/refusal-matrix.test.ts`

**Interfaces:**
- Consumes: Task 12 presets; Task 6 descriptor/errors.
- Produces:

```ts
// with-shape/classified/guards.ts
export interface ClassifiedGuardCtx {
  readonly perRecordKeys: boolean
  readonly crdt: boolean
  readonly hasConflictPolicy: boolean
  readonly deterministicFields: ReadonlySet<string> | null
  readonly indexedFields: ReadonlySet<string>
  readonly textIndexFields: ReadonlySet<string>
  readonly vectorSourceFields: ReadonlySet<string>
  readonly subjectKeyField: string | undefined
  readonly bareSensitiveFields: ReadonlySet<string>
}
export function guardClassifiedCompat(
  collection: string,
  byField: Record<string, ClassifiedFieldSpec>,
  ctx: ClassifiedGuardCtx,
): void  // throws ClassifiedConfigError per R1/R2/R3/R4/R5-overlap
```

Both doors call the SAME function with the SAME ctx object: door 1 = `resolveCollectionConfig` (construction), door 2 = `_applyClassifiedFields` (the reconcile seam — C5's lesson: `crdt`/`conflictPolicy`/`perRecordKeys` are construction-only but `classifiedFields` can attach later).

- [ ] **Step 1: Write the failing test**

```ts
// packages/hub/__tests__/classified/refusal-matrix.test.ts
import { describe, it, expect } from 'vitest'
import { createNoydb } from '../../src/kernel/noydb.js'
import { inlineMemory } from './harness.js'
import { classified } from '../../src/with-shape/classified/presets.js'
import { ClassifiedConfigError } from '../../src/kernel/errors.js'

async function vault(secret: string) {
  const db = await createNoydb({ store: inlineMemory(), user: 'a', secret })
  return db.openVault('v1')
}

describe('Refusal matrix — door 1: collection()', () => {
  it('R1: digest-only without perRecordKeys is refused', async () => {
    const v = await vault('pw-r1')
    expect(() => v.collection('users', {
      classifiedFields: { password: classified.password() },
    })).toThrow(ClassifiedConfigError)
  })

  it('R2: digest-only × crdt is refused; recoverable × conflictPolicy is refused', async () => {
    const v = await vault('pw-r2')
    expect(() => v.collection('a', {
      perRecordKeys: true, crdt: 'lww',
      classifiedFields: { password: classified.password() },
    })).toThrow(ClassifiedConfigError)
    expect(() => v.collection('b', {
      conflictPolicy: { merge: (l: unknown) => l },
      classifiedFields: { email: classified.email() },
    })).toThrow(ClassifiedConfigError)
  })

  it('R3: digest-only ∈ deterministicFields is refused', async () => {
    const v = await vault('pw-r3')
    expect(() => v.collection('users', {
      perRecordKeys: true,
      deterministicFields: ['password'], acknowledgeDeterministicRisk: true,
      classifiedFields: { password: classified.password() },
    })).toThrow(ClassifiedConfigError)
  })

  it('R4: digest-only ∈ indexes / text index / vector source is refused', async () => {
    const v = await vault('pw-r4')
    expect(() => v.collection('a', {
      perRecordKeys: true, indexes: ['password'],
      classifiedFields: { password: classified.password() },
    })).toThrow(ClassifiedConfigError)
    expect(() => v.collection('b', {
      perRecordKeys: true, textIndexes: ['password'],
      classifiedFields: { password: classified.password() },
    })).toThrow(ClassifiedConfigError)
    expect(() => v.collection('c', {
      perRecordKeys: true,
      embeddings: { source: 'password', encode: async () => new Float32Array(3), dim: 3, model: 'm' },
      classifiedFields: { password: classified.password() },
    })).toThrow(ClassifiedConfigError)
  })

  it('R5-overlap: digest-only field also in bare sensitive[] is refused', async () => {
    const v = await vault('pw-r5')
    expect(() => v.collection('users', {
      perRecordKeys: true, sensitive: ['password'],
      classifiedFields: { password: classified.password() },
    })).toThrow(ClassifiedConfigError)
  })

  it('a valid digest-only declaration still opens (guards are precise, not blanket)', async () => {
    const v = await vault('pw-ok')
    expect(() => v.collection('users', {
      perRecordKeys: true,
      classifiedFields: { password: classified.password() },
    })).not.toThrow()
  })
})

describe('Refusal matrix — door 2: _applyClassifiedFields (the reconcile seam, C5)', () => {
  it('R2 second door: a crdt collection cannot have digest-only fields bolted on later', async () => {
    const v = await vault('pw-d2')
    v.collection('docs', { crdt: 'lww', perRecordKeys: true })    // auto/first open, no classified
    expect(() => v.collection('docs', {
      crdt: 'lww', perRecordKeys: true,
      classifiedFields: { password: classified.password() },      // reconcile attach
    })).toThrow(ClassifiedConfigError)
  })

  it('R1 second door: reconcile attach onto a non-perRecordKeys collection is refused', async () => {
    const v = await vault('pw-d2b')
    v.collection('plain', {})
    expect(() => v.collection('plain', {
      classifiedFields: { password: classified.password() },
    })).toThrow(ClassifiedConfigError)
  })

  it('R6 session: a re-declaration that changes a field form is refused (first-wins otherwise)', async () => {
    const v = await vault('pw-r6')
    v.collection('users', { perRecordKeys: true, classifiedFields: { password: classified.password() } })
    // identical re-declaration → first-wins no-op
    expect(() => v.collection('users', {
      perRecordKeys: true, classifiedFields: { password: classified.password() },
    })).not.toThrow()
    // form flip digest-only → recoverable → refused
    expect(() => v.collection('users', {
      perRecordKeys: true, classifiedFields: { password: classified.email() },
    })).toThrow(ClassifiedConfigError)
  })
})
```

(Adjust `crdt: 'lww'` / `conflictPolicy` literal shapes to this branch's actual option types — `grep -n "crdt?:" packages/hub/src/kernel/collection-config.ts` and mirror an existing crdt test's options.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/hub/__tests__/classified/refusal-matrix.test.ts`
Expected: FAIL — every refusal case currently opens without throwing.

- [ ] **Step 3: Implement**

`guards.ts`:

```ts
/** Refusal matrix R1-R5 (spec) — ONE guard, run at BOTH doors:
 *  collection() config resolution AND _applyClassifiedFields (the reconcile
 *  seam), because crdt/conflictPolicy/perRecordKeys are construction-only
 *  while classifiedFields can attach later (C5's lesson). @module */
import type { ClassifiedFieldSpec } from './descriptor.js'
import { ClassifiedConfigError } from '../../kernel/errors.js'

export interface ClassifiedGuardCtx {
  readonly perRecordKeys: boolean
  readonly crdt: boolean
  readonly hasConflictPolicy: boolean
  readonly deterministicFields: ReadonlySet<string> | null
  readonly indexedFields: ReadonlySet<string>
  readonly textIndexFields: ReadonlySet<string>
  readonly vectorSourceFields: ReadonlySet<string>
  readonly subjectKeyField: string | undefined
  readonly bareSensitiveFields: ReadonlySet<string>
}

export function guardClassifiedCompat(
  collection: string,
  byField: Record<string, ClassifiedFieldSpec>,
  ctx: ClassifiedGuardCtx,
): void {
  const digestOnly = Object.entries(byField)
    .filter(([, s]) => s.storage === 'digest-only').map(([f]) => f)
  const protectedForms = Object.values(byField)
    .filter((s) => s.storage === 'digest-only' || s.storage === 'recoverable')

  // R2 — merge resolvers bypass the write pipeline entirely (C5): a merge
  // could carry stale/foreign _vdig or resurrect plaintext. Fail-loud.
  if (protectedForms.length > 0 && (ctx.crdt || ctx.hasConflictPolicy)) {
    throw new ClassifiedConfigError(collection,
      'digest-only/recoverable classified fields cannot combine with a crdt mode or a ' +
      'conflictPolicy resolver — merge paths bypass write enforcement (R2)')
  }
  if (digestOnly.length === 0) return

  // R1 — vdig slot keys are CEK-only (I3); without perRecordKeys a digest
  // would survive forget() in backups as offline-crackable material.
  if (!ctx.perRecordKeys) {
    throw new ClassifiedConfigError(collection,
      `storage:'digest-only' requires perRecordKeys: true — vdig keys derive from the ` +
      `per-record CEK so forget() shreds them (R1)`)
  }
  for (const f of digestOnly) {
    if (ctx.bareSensitiveFields.has(f)) {
      throw new ClassifiedConfigError(collection,
        `field "${f}" is digest-only AND listed in sensitive[] — storage forms are mutually exclusive per field (R5)`)
    }
    if (ctx.deterministicFields?.has(f)) {
      throw new ClassifiedConfigError(collection,
        `digest-only field "${f}" cannot be deterministic — equality-correlatable ciphertext defeats per-write salts (R3)`)
    }
    if (ctx.indexedFields.has(f) || ctx.textIndexFields.has(f)
      || ctx.vectorSourceFields.has(f) || ctx.subjectKeyField === f) {
      throw new ClassifiedConfigError(collection,
        `digest-only field "${f}" cannot be indexed, text-indexed, embedded, or a forget-subject key (R4)`)
    }
  }
}
```

`collection-config.ts` — beside the `vdigFields` block (Task 8), build the ctx and run door 1:

```ts
  const indexedFields = new Set<string>()
  for (const ix of opts.indexes ?? []) {
    if (typeof ix === 'string') indexedFields.add(ix)
    else if (Array.isArray(ix)) for (const f of ix) indexedFields.add(f)
    else for (const f of (ix as { readonly fields: readonly string[] }).fields) indexedFields.add(f)
  }
  const embeddingSources = opts.embeddings === undefined ? []
    : typeof opts.embeddings.source === 'string' ? [opts.embeddings.source] : [...opts.embeddings.source]
  const classifiedGuardCtx: ClassifiedGuardCtx = {
    perRecordKeys: opts.perRecordKeys === true,
    crdt: opts.crdt !== undefined,
    hasConflictPolicy: opts.conflictPolicy !== undefined,
    deterministicFields,
    indexedFields,
    textIndexFields: new Set(opts.textIndexes ?? []),
    vectorSourceFields: new Set(embeddingSources),
    subjectKeyField: opts.subjectKeyField,
    bareSensitiveFields: new Set(opts.sensitive ?? []),
  }
  if (resolvedClassified !== undefined) {
    guardClassifiedCompat(opts.name, resolvedClassified.byField, classifiedGuardCtx) // door 1
  }
```

with `subjectKeyField?: string | undefined` added to `CollectionOpts`, `classifiedGuardCtx` added to the return object, and imports from `../with-shape/classified/guards.js`.

`vault.ts` — where `collOpts` is assembled (near the `forgetStrategy.subjects` block at vault.ts:~1085):

```ts
      const subjectKey = this.forgetStrategy.subjects[collectionName]
      if (subjectKey !== undefined) collOpts.subjectKeyField = subjectKey
```

`collection.ts` —

1. Constructor: `this.classifiedGuardCtx = cfg.classifiedGuardCtx` (`private readonly classifiedGuardCtx: ClassifiedGuardCtx`).
2. `_applyClassifiedFields` (collection.ts:1153): replace the silent first-wins return with the R6 form-change comparison, and run door 2 before accepting:

```ts
  _applyClassifiedFields(classifiedFields: Record<string, ClassifiedEntry>): void {
    const resolved = resolveClassifiedFields(this.name, classifiedFields)
    if (this.classified !== undefined) {
      // R6 (session): first-wins, but a re-declaration that CHANGES a field's
      // storage form is refused — never a silent form flip.
      for (const [field, spec] of Object.entries(resolved.byField)) {
        const prior = this.classified.byField[field]
        if (prior !== undefined && prior.storage !== spec.storage) {
          throw new ClassifiedConfigError(this.name,
            `field "${field}" was already declared storage:'${prior.storage}' — ` +
            `storage-form transitions are refused (R6); migrate explicitly`)
        }
      }
      return // identical / compatible re-declaration → first-wins no-op
    }
    guardClassifiedCompat(this.name, resolved.byField, this.classifiedGuardCtx) // door 2 (C5)
    ... // existing rider-collision + unsealable checks unchanged, then assignment
  }
```

(Keep the existing rider-collision and recoverable-after-open checks verbatim below the door-2 guard.)

3. Ceiling bumps: run `pnpm check:architecture`; bank the new `collection.ts` / `vault.ts` line counts in `KERNEL_SURFACE_BUDGET` with a comment: `// Bumped (2026-07-04, classified stage 2): both-door Refusal-matrix guard call-sites (R1-R6); the guard logic lives in with-shape/classified/guards.ts.`

- [ ] **Step 4: Run tests to verify GREEN**

Run: `pnpm vitest run packages/hub/__tests__/classified/ && pnpm --filter @noy-db/hub typecheck && pnpm check:architecture`
Expected: all PASS (including stage-1 threading tests — MV reconcile paths must still work for non-digest declarations).

- [ ] **Step 5: Commit**

```bash
git add packages/hub/src/with-shape/classified/guards.ts packages/hub/src/kernel/collection-config.ts packages/hub/src/kernel/collection.ts packages/hub/src/kernel/vault.ts scripts/check-architecture.mjs packages/hub/__tests__/classified/refusal-matrix.test.ts
git commit -m "feat(classified): Refusal matrix R1-R6 guards at both doors (C5/I3/I4/I5)"
```

---

### Task 14: Layer C — enclave verify engine: `verifyDigestField` / `verifyTextField` / `matchGroupFields` (C4/I1/I2 + R6 verify-side)

**Files:**
- Create: `packages/hub/src/kernel/enclave/classify/verify.ts`
- Test: `packages/hub/__tests__/classified/verify-engine.test.ts`

**Interfaces:**
- Consumes: Tasks 1–4 primitives; `dualReadSealedSlot` (`../record-keys/sealed-slot.js` — in-enclave relative import, allowed); Task 6 types/errors.
- Produces (what Task 15's strategy delegates to):

```ts
export interface VerifyEngineCtx {
  readonly collection: string
  getEnvelope(id: string): Promise<EncryptedEnvelope | null>
  resolveCek(env: EncryptedEnvelope): Promise<EnclaveKey | undefined>
  getDEK(): Promise<EnclaveKey>
  readonly now: () => number            // injected (spec Q7)
}
export async function verifyDigestField(ctx: VerifyEngineCtx, id: string, field: string, candidate: string, policy: VdigFieldPolicy): Promise<ClassifiedVerdict>
export async function verifyTextField(ctx: VerifyEngineCtx, id: string, field: string, candidate: string, normalize: 'password' | 'secret-answer'): Promise<ClassifiedVerdict>
export async function matchGroupFields(ctx: VerifyEngineCtx, id: string, answers: Record<string, string>, members: ReadonlyArray<{ readonly field: string; readonly policy: VdigFieldPolicy }>, opts: { readonly min: number }): Promise<{ readonly passed: boolean }>
```

Semantics (spec §3, all mandatory): verdict-only egress; C4 dummy pad on every cannot-compare path; I1 `mustRotate` only on `ok === true`; I2 matchGroup order (validate everything up front at ~0 elapsed → iterate RESOLVED members → no short-circuit → aggregate only); R6 verify-side `ClassifiedConfigError` on `_sealed[field]`-present-`_vdig[field]`-absent (config-bug throw, exempt from the pad); `ClassifiedVerifyError` only for caller bugs.

- [ ] **Step 1: Write the failing test** — includes the §6 vectors: vdig round-trip ok/fail, spliced-blob → `ok:false`, **timing parity**, k-of-n behavior table, `mustRotate` absence on false verdicts.

```ts
// packages/hub/__tests__/classified/verify-engine.test.ts
import { describe, it, expect } from 'vitest'
import { generateDEK } from '../../src/kernel/enclave/index.js'
import { mintVdigSlot } from '../../src/kernel/enclave/classify/write.js'
import {
  verifyDigestField, verifyTextField, matchGroupFields, type VerifyEngineCtx,
} from '../../src/kernel/enclave/classify/verify.js'
import type { EncryptedEnvelope, VdigFieldPolicy } from '../../src/kernel/types.js'
import { ClassifiedConfigError, ClassifiedVerifyError } from '../../src/kernel/errors.js'

const pw: VdigFieldPolicy = { normalize: 'password', notLastN: 0 }
const sa: VdigFieldPolicy = { normalize: 'secret-answer', notLastN: 0 }

function ctxFor(env: EncryptedEnvelope | null, cek: CryptoKey | undefined, now = () => Date.now()): VerifyEngineCtx {
  return {
    collection: 'users',
    getEnvelope: async () => env,
    resolveCek: async () => cek,
    getDEK: () => generateDEK(), // engine only uses the DEK on the text path
    now,
  }
}

async function envWith(cek: CryptoKey, slots: Record<string, { value: string; policy: VdigFieldPolicy }>, id = 'r1'): Promise<EncryptedEnvelope> {
  const vdig: Record<string, string> = {}
  for (const [f, s] of Object.entries(slots)) {
    vdig[f] = await mintVdigSlot(s.value, s.policy, undefined, cek, 'users', id, f)
  }
  return { _noydb: 1, _v: 1, _ts: 't', _iv: 'x', _data: 'x', _cek: 'wrapped', _vdig: vdig }
}

describe('verifyDigestField', () => {
  it('round-trip: correct candidate → ok:true; wrong → exactly { ok: false }', async () => {
    const cek = await generateDEK()
    const env = await envWith(cek, { password: { value: 'correct-horse-battery', policy: pw } })
    const ctx = ctxFor(env, cek)
    expect(await verifyDigestField(ctx, 'r1', 'password', 'correct-horse-battery', pw)).toEqual({ ok: true })
    const bad = await verifyDigestField(ctx, 'r1', 'password', 'wrong-password-!!', pw)
    expect(bad).toEqual({ ok: false })
    expect('mustRotate' in bad).toBe(false)                    // I1: key ABSENT on false
  }, 120_000)

  it('normalization: secret-answer candidates match case/space-insensitively', async () => {
    const cek = await generateDEK()
    const env = await envWith(cek, { answer: { value: '  Fluffy The Cat ', policy: sa } })
    expect(await verifyDigestField(ctxFor(env, cek), 'r1', 'answer', 'fluffy   the cat', sa)).toEqual({ ok: true })
  }, 120_000)

  it('C1: a blob spliced from another record verifies { ok: false }, never a tamper throw', async () => {
    const cek = await generateDEK()
    const env1 = await envWith(cek, { password: { value: 'correct-horse-battery', policy: pw } }, 'r1')
    const spliced: EncryptedEnvelope = { ...env1 } // engine reads it as r2's envelope
    expect(await verifyDigestField(ctxFor(spliced, cek), 'r2', 'password', 'correct-horse-battery', pw)).toEqual({ ok: false })
  }, 120_000)

  it('I1: mustRotate decorates ONLY ok:true, when now() exceeds cur.at + rotateDays', async () => {
    const cek = await generateDEK()
    const rot: VdigFieldPolicy = { normalize: 'password', notLastN: 0, rotateDays: 30 }
    const env = await envWith(cek, { password: { value: 'correct-horse-battery', policy: rot } })
    const future = () => Date.now() + 31 * 86_400_000
    expect(await verifyDigestField(ctxFor(env, cek, future), 'r1', 'password', 'correct-horse-battery', rot))
      .toEqual({ ok: true, mustRotate: true })
    expect(await verifyDigestField(ctxFor(env, cek, future), 'r1', 'password', 'wrong-password-!!', rot))
      .toEqual({ ok: false })                                   // stale AND wrong → still bare false
  }, 120_000)

  it('R6 verify-side: _sealed[field] present with no _vdig[field] throws ClassifiedConfigError', async () => {
    const cek = await generateDEK()
    const env: EncryptedEnvelope = {
      _noydb: 1, _v: 1, _ts: 't', _iv: 'x', _data: 'x', _cek: 'w',
      _sealed: { password: 'iv:stale' },
    }
    await expect(verifyDigestField(ctxFor(env, cek), 'r1', 'password', 'anything-here', pw))
      .rejects.toBeInstanceOf(ClassifiedConfigError)
  })

  it('C4 timing parity: missing record / missing slot cost within the wrong-candidate envelope', async () => {
    const cek = await generateDEK()
    const env = await envWith(cek, { password: { value: 'correct-horse-battery', policy: pw } })
    const time = async (fn: () => Promise<unknown>) => {
      const t0 = performance.now(); await fn(); return performance.now() - t0
    }
    const wrong = await time(() => verifyDigestField(ctxFor(env, cek), 'r1', 'password', 'wrong-password-!!', pw))
    const missingRecord = await time(() => verifyDigestField(ctxFor(null, cek), 'r1', 'password', 'wrong-password-!!', pw))
    const missingSlot = await time(() => verifyDigestField(ctxFor({ ...env, _vdig: {} }, cek), 'r1', 'password', 'wrong-password-!!', pw))
    // The 600K PBKDF2 dominates (~100ms+); an unpadded miss returns in <5ms.
    expect(missingRecord).toBeGreaterThan(wrong * 0.4)
    expect(missingSlot).toBeGreaterThan(wrong * 0.4)
  }, 120_000)
})

describe('matchGroupFields (I2)', () => {
  async function groupFixture() {
    const cek = await generateDEK()
    const env = await envWith(cek, {
      a1: { value: 'Rex', policy: sa },
      a2: { value: 'Bangkok', policy: sa },
      a3: { value: 'Somsri', policy: sa },
    })
    const members = [
      { field: 'a1', policy: sa }, { field: 'a2', policy: sa }, { field: 'a3', policy: sa },
    ] as const
    return { ctx: ctxFor(env, cek), members: [...members] }
  }

  it('k-of-n: 2 of 3 correct passes min 2; 1 of 3 fails; per-member results never egress', async () => {
    const { ctx, members } = await groupFixture()
    const pass = await matchGroupFields(ctx, 'r1', { a1: 'rex', a2: 'bangkok', a3: 'wrong' }, members, { min: 2 })
    expect(pass).toEqual({ passed: true })
    expect(Object.keys(pass)).toEqual(['passed'])              // aggregate ONLY
    expect(await matchGroupFields(ctx, 'r1', { a1: 'rex', a2: 'no', a3: 'no' }, members, { min: 2 }))
      .toEqual({ passed: false })
  }, 240_000)

  it('missing answers contribute false (denominator = |groupMembers|); non-member keys silently ignored', async () => {
    const { ctx, members } = await groupFixture()
    expect(await matchGroupFields(ctx, 'r1', { a1: 'rex', notAMember: 'probe' }, members, { min: 1 }))
      .toEqual({ passed: true })
    expect(await matchGroupFields(ctx, 'r1', { a1: 'rex' }, members, { min: 2 }))
      .toEqual({ passed: false })
  }, 240_000)

  it('I2c: min bounds throw ClassifiedVerifyError uniformly BEFORE any PBKDF2 (fast)', async () => {
    const { ctx, members } = await groupFixture()
    const t0 = performance.now()
    await expect(matchGroupFields(ctx, 'r1', {}, members, { min: 0 })).rejects.toBeInstanceOf(ClassifiedVerifyError)
    await expect(matchGroupFields(ctx, 'r1', {}, members, { min: 4 })).rejects.toBeInstanceOf(ClassifiedVerifyError)
    expect(performance.now() - t0).toBeLessThan(50)            // ~0 elapsed — no member work leaked
  }, 240_000)
})

describe('verifyTextField', () => {
  it('caller-bug: this engine door never accepts a digest-only slot (no _sealed) → padded false', async () => {
    const cek = await generateDEK()
    const env = await envWith(cek, { password: { value: 'correct-horse-battery', policy: pw } })
    expect(await verifyTextField(ctxFor(env, cek), 'r1', 'password', 'correct-horse-battery', 'password'))
      .toEqual({ ok: false })
  }, 120_000)
})
```

(`verifyTextField`'s positive path — unseal a real `_sealed` slot and match — is covered end-to-end in Task 15 where a real recoverable collection exists; the engine-level suite pins its miss behavior.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/hub/__tests__/classified/verify-engine.test.ts`
Expected: FAIL — `Cannot find module .../classify/verify.js`.

- [ ] **Step 3: Write the implementation**

```ts
// packages/hub/src/kernel/enclave/classify/verify.ts
/**
 * The enclave verify oracle (spec §3). Verdict-only egress: no path
 * distinguishes "record missing" / "no digest" / "AAD-tamper" / "mismatch"
 * beyond { ok: false } — existence oracles are oracles too. Every path that
 * cannot run a real comparison runs ONE dummy PBKDF2 + ONE dummy tag-compare
 * first (C4), so wall-clock cannot enumerate records/fields/answers.
 * Throws are reserved for caller/config bugs (ClassifiedVerifyError /
 * ClassifiedConfigError) and are exempt from the pad by design (R6 note).
 * @module
 */
import { generateSalt, base64ToBuffer, type EnclaveKey } from '../crypto.js'
import { pbkdf2VerifyDigest, VDIG_ITERATIONS } from './digest.js'
import { normalizeForVerify, type VerifyNormalizeMode } from './normalize.js'
import { blindedEqual } from './compare.js'
import { evaluateKofN } from './kofn.js'
import { openVdigPayload, type VdigPayload } from './vdig.js'
import { dualReadSealedSlot } from '../record-keys/sealed-slot.js'
import { ClassifiedConfigError, ClassifiedVerifyError } from '../../errors.js'
import type { EncryptedEnvelope, VdigFieldPolicy, ClassifiedVerdict } from '../../types.js'

export interface VerifyEngineCtx {
  readonly collection: string
  getEnvelope(id: string): Promise<EncryptedEnvelope | null>
  resolveCek(env: EncryptedEnvelope): Promise<EnclaveKey | undefined>
  getDEK(): Promise<EnclaveKey>
  readonly now: () => number
}

/** C4 pad: one full-cost dummy digest + one dummy compare; result discarded. */
async function padOnce(): Promise<void> {
  const dummy = await pbkdf2VerifyDigest('noydb-classify-c4-pad', generateSalt(), VDIG_ITERATIONS)
  await blindedEqual(dummy, dummy)
}

async function padFalse(): Promise<ClassifiedVerdict> {
  await padOnce()
  return { ok: false }
}

/** R6 verify-side transition evidence — config bug, fail-loud, pad-exempt. */
function refuseSealedResidue(collection: string, field: string): never {
  throw new ClassifiedConfigError(collection,
    `field "${field}" carries a recoverable _sealed slot but no _vdig — storage-form ` +
    `transition detected (R6); refused fail-loud, never an ok:false masquerading as wrong-password`)
}

export async function verifyDigestField(
  ctx: VerifyEngineCtx,
  id: string,
  field: string,
  candidate: string,
  policy: VdigFieldPolicy,
): Promise<ClassifiedVerdict> {
  const env = await ctx.getEnvelope(id)
  if (env === null) return padFalse()
  const blob = env._vdig?.[field]
  if (blob === undefined) {
    if (env._sealed?.[field] !== undefined) refuseSealedResidue(ctx.collection, field)
    return padFalse()
  }
  const cek = await ctx.resolveCek(env)
  if (cek === undefined) return padFalse()

  let payload: VdigPayload
  try {
    payload = await openVdigPayload(blob, cek, ctx.collection, id, field)
  } catch {
    return padFalse() // AAD/tamper (C1) → padded false; no tamper oracle to the caller
  }

  const normalized = normalizeForVerify(policy.normalize, candidate)
  const digest = await pbkdf2VerifyDigest(normalized, base64ToBuffer(payload.cur.salt), payload.iter)
  const ok = await blindedEqual(digest, base64ToBuffer(payload.cur.hash))
  if (!ok) return { ok: false } // I1: bare false — mustRotate never computed here

  if (policy.rotateDays !== undefined
    && ctx.now() > Date.parse(payload.cur.at) + policy.rotateDays * 86_400_000) {
    // Disclosing write-age-vs-policy to a SUCCESSFUL verifier is intended (audit F6).
    return { ok: true, mustRotate: true }
  }
  return { ok: true }
}

export async function verifyTextField(
  ctx: VerifyEngineCtx,
  id: string,
  field: string,
  candidate: string,
  normalize: VerifyNormalizeMode,
): Promise<ClassifiedVerdict> {
  const env = await ctx.getEnvelope(id)
  if (env === null) return padFalse()
  const blob = env._sealed?.[field]
  if (blob === undefined) return padFalse()
  const cek = await ctx.resolveCek(env)
  const dek = await ctx.getDEK()
  let stored: unknown
  try {
    stored = JSON.parse(await dualReadSealedSlot(blob, field, ctx.collection, cek, dek))
  } catch {
    return padFalse()
  }
  // Plaintext exists microseconds inside this function; only the boolean leaves.
  const a = new TextEncoder().encode(normalizeForVerify(normalize, candidate))
  const b = new TextEncoder().encode(normalizeForVerify(normalize, String(stored)))
  return { ok: await blindedEqual(a, b) }
}

export async function matchGroupFields(
  ctx: VerifyEngineCtx,
  id: string,
  answers: Record<string, string>,
  members: ReadonlyArray<{ readonly field: string; readonly policy: VdigFieldPolicy }>,
  opts: { readonly min: number },
): Promise<{ readonly passed: boolean }> {
  // I2 step 1 — validate EVERYTHING up front, before any PBKDF2, throwing
  // uniformly at ~0 elapsed (no member-position leak via timing/throw type).
  if (!Number.isInteger(opts.min) || opts.min < 1 || opts.min > members.length) {
    throw new ClassifiedVerifyError(ctx.collection, '*',
      `matchGroup min ${opts.min} out of range 1..${members.length}`)
  }
  const normalized = new Map<string, string>()
  for (const m of members) {
    const answer = answers[m.field] // non-member answer keys: silently ignored
    if (answer === undefined) continue
    if (typeof answer !== 'string') {
      throw new ClassifiedVerifyError(ctx.collection, m.field, 'candidate must be a string')
    }
    normalized.set(m.field, normalizeForVerify(m.policy.normalize, answer))
  }

  const env = await ctx.getEnvelope(id)
  if (env !== null) {
    for (const m of members) { // R6 evidence — uniform, before any PBKDF2
      if (env._sealed?.[m.field] !== undefined && env._vdig?.[m.field] === undefined) {
        refuseSealedResidue(ctx.collection, m.field)
      }
    }
  }
  const cek = env !== null ? await ctx.resolveCek(env) : undefined

  // I2 step 2+3 — iterate RESOLVED GROUP MEMBERS (denominator = |members|),
  // evaluate EVERY member (collect, never break), pad every no-compare slot.
  const results: boolean[] = []
  for (const m of members) {
    const candidate = normalized.get(m.field)
    const blob = env?._vdig?.[m.field]
    if (env === null || cek === undefined || candidate === undefined || blob === undefined) {
      await padOnce()
      results.push(false)
      continue
    }
    try {
      const payload = await openVdigPayload(blob, cek, ctx.collection, id, m.field)
      const digest = await pbkdf2VerifyDigest(candidate, base64ToBuffer(payload.cur.salt), payload.iter)
      results.push(await blindedEqual(digest, base64ToBuffer(payload.cur.hash)))
    } catch {
      await padOnce()
      results.push(false)
    }
  }
  // Per-member results never appear in any return, error, or audit payload.
  return { passed: evaluateKofN(results, opts.min) }
}
```

- [ ] **Step 4: Run tests to verify GREEN**

Run: `pnpm vitest run packages/hub/__tests__/classified/verify-engine.test.ts`
Expected: PASS (slow — real 600K PBKDF2 throughout; ~1-3 min total).

- [ ] **Step 5: Commit**

```bash
git add packages/hub/src/kernel/enclave/classify/verify.ts packages/hub/__tests__/classified/verify-engine.test.ts
git commit -m "feat(classified): enclave verify oracle — digest/text/k-of-n with C4 pad, I1, I2, R6"
```

---

### Task 15: Layer C — strategy seam + `collection.verify()`/`verifyGroup()` + consent `'verify'`  ⚠ kernel-api golden, with-surface golden, kernel-surface

**Files:**
- Modify: `packages/hub/src/with-shape/classified/strategy.ts` (`ClassifiedVerdict` re-export, `ClassifiedVerifyCtx`, 3 new `ClassifiedStrategy` members, `NO_CLASSIFIED` throwing members)
- Modify: `packages/hub/src/with-shape/classified/active.ts` (delegating implementations via dynamic import)
- Modify: `packages/hub/src/with-shape/classified/index.ts` (+type exports `ClassifiedVerdict`, `ClassifiedVerifyCtx`)
- Modify: `packages/hub/src/index.ts` (root barrel +type `ClassifiedVerdict`)
- Modify: `packages/hub/src/kernel/collection.ts` (public `verify`/`verifyGroup`, `classifiedVerifyCtx` helper, digest-only reveal refusal, `onAccess` op union +`'verify'` at collection.ts:570)
- Modify: `packages/hub/src/with-audit/consent/consent.ts` (`ConsentOp` +`'verify'` at consent.ts:77)
- Modify: `packages/hub/__tests__/kernel-api.golden.json` (+`"verify"`, `"verifyGroup"` — **frozen golden**), `packages/hub/__tests__/with-surface.golden.json`, `packages/hub/__tests__/root-barrel-surface.golden.json` (**frozen goldens**)
- Modify: `scripts/check-architecture.mjs` (`collection.ts` ceiling bank, same style as Task 8)
- Test: `packages/hub/__tests__/classified/verify-public-surface.test.ts`

**Interfaces:**
- Consumes: Tasks 13 + 14.
- Produces:

```ts
// strategy.ts (stage-1 reveal member unchanged in THIS task; reworked in Task 16)
export type { ClassifiedVerdict } from '../../kernel/types.js'
export interface ClassifiedVerifyCtx {
  readonly collection: string
  readonly spec: ClassifiedFieldSpec
  getEnvelope(id: string): Promise<EncryptedEnvelope | null>       // raw envelope, NOT a decrypted view
  resolveCek(env: EncryptedEnvelope): Promise<EnclaveKey | undefined>
  getDEK(): Promise<EnclaveKey>
  readonly now: () => number                                        // injected (Q7)
  /** Group members resolved by the collection (matchGroup only). */
  readonly groupMembers?: ReadonlyArray<{ readonly field: string; readonly spec: ClassifiedFieldSpec }>
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

  - Public kernel API: `collection.verify(id, field, candidate): Promise<ClassifiedVerdict>` (routes digest-only → `strategy.verify`, recoverable → `strategy.verifyText`, `never`/unknown → `ClassifiedVerifyError`) and `collection.verifyGroup(id, answers, { min }): Promise<{ passed: boolean }>` (members = every `verifyGroupMember` digest-only field). Both gated by `withClassified()` (`NO_CLASSIFIED` throws `ClassifiedNotEnabledError`).
  - One `'verify'` consent op per `verify`/`verifyGroup` call (Q6), fired from `active.ts` AFTER the engine returns, regardless of verdict.
  - `collection.reveal` additionally refuses digest-only fields (`ClassifiedRevealError`, presets table §4).

- [ ] **Step 1: Write the failing test**

```ts
// packages/hub/__tests__/classified/verify-public-surface.test.ts
import { describe, it, expect } from 'vitest'
import { createNoydb } from '../../src/kernel/noydb.js'
import { inlineMemory } from './harness.js'
import { classified } from '../../src/with-shape/classified/presets.js'
import { withClassified } from '../../src/with-shape/classified/active.js'
import { withConsent } from '../../src/with-audit/consent/index.js'
import { ClassifiedNotEnabledError } from '../../src/kernel/errors.js'
import { ClassifiedVerifyError, ClassifiedRevealError } from '../../src/kernel/errors.js'

async function openWith(strategy?: ReturnType<typeof withClassified>, consent = false) {
  const store = inlineMemory()
  const db = await createNoydb({
    store, user: 'a', secret: 'pw-s2-15',
    ...(strategy !== undefined ? { classifiedStrategy: strategy } : {}),
    ...(consent ? { consentStrategy: withConsent() } : {}),
  })
  const v = await db.openVault('v1')
  const c = v.collection<Record<string, unknown>>('users', {
    perRecordKeys: true,
    classifiedFields: {
      password: classified.password(),
      a1: classified.secretAnswer(),
      a2: classified.secretAnswer(),
      email: classified.email(),
    },
  })
  return { store, v, c }
}
// NOTE: if consent is enabled differently on this branch (e.g. always-on via
// vault.withConsent), mirror the stage-1 consent test setup instead — grep
// packages/hub/__tests__ for "withConsent(" and copy its harness.

describe('collection.verify / verifyGroup (public surface)', () => {
  it('throws ClassifiedNotEnabledError without withClassified()', async () => {
    const { c } = await openWith(undefined)
    await c.put('u1', { password: 'correct-horse-battery' })
    await expect(c.verify('u1', 'password', 'x'.repeat(12))).rejects.toBeInstanceOf(ClassifiedNotEnabledError)
    await expect(c.verifyGroup('u1', {}, { min: 1 })).rejects.toBeInstanceOf(ClassifiedNotEnabledError)
  }, 60_000)

  it('digest path end-to-end: put → verify ok / wrong → bare false', async () => {
    const { c } = await openWith(withClassified())
    await c.put('u1', { password: 'correct-horse-battery', a1: 'Rex', a2: 'Bangkok' })
    expect(await c.verify('u1', 'password', 'correct-horse-battery')).toEqual({ ok: true })
    expect(await c.verify('u1', 'password', 'wrong-password-!!')).toEqual({ ok: false })
  }, 120_000)

  it('C3 vector at the public surface: rotateRecordCek / hard revoke → verify(correct) → ok:true', async () => {
    const { v, c } = await openWith(withClassified())
    await c.put('u1', { password: 'correct-horse-battery' })
    await v.rotateRecordCek('users', 'u1')
    expect(await c.verify('u1', 'password', 'correct-horse-battery')).toEqual({ ok: true })
    await v.revokeSealedRecord('users', 'u1', 'pid-x', { hard: true })
    expect(await c.verify('u1', 'password', 'correct-horse-battery')).toEqual({ ok: true })
  }, 120_000)

  it('recoverable path routes through verifyText (normalize per preset is password/NFC-strict here)', async () => {
    const { c } = await openWith(withClassified())
    await c.put('u1', { email: 'nok@example.com' })
    expect(await c.verify('u1', 'email', 'nok@example.com')).toEqual({ ok: true })
    expect(await c.verify('u1', 'email', 'other@example.com')).toEqual({ ok: false })
  }, 60_000)

  it('caller bugs throw ClassifiedVerifyError: unknown field, storage:never', async () => {
    const { c } = await openWith(withClassified())
    await expect(c.verify('u1', 'nope', 'x')).rejects.toBeInstanceOf(ClassifiedVerifyError)
  })

  it('verifyGroup: k-of-n over the secretAnswer members', async () => {
    const { c } = await openWith(withClassified())
    await c.put('u1', { password: 'correct-horse-battery', a1: 'Rex', a2: 'Bangkok' })
    expect(await c.verifyGroup('u1', { a1: 'rex', a2: 'nope' }, { min: 1 })).toEqual({ passed: true })
    expect(await c.verifyGroup('u1', { a1: 'rex', a2: 'nope' }, { min: 2 })).toEqual({ passed: false })
  }, 240_000)

  it('reveal refuses digest-only fields (presets table §4)', async () => {
    const { c } = await openWith(withClassified())
    await c.put('u1', { password: 'correct-horse-battery' })
    await expect(c.reveal('u1', 'password')).rejects.toBeInstanceOf(ClassifiedRevealError)
  }, 60_000)

  it("Q6: one 'verify' consent entry per verify call and per matchGroup call (not per member)", async () => {
    const { v, c } = await openWith(withClassified(), true)
    await c.put('u1', { password: 'correct-horse-battery', a1: 'Rex', a2: 'Bangkok' })
    await v.withConsent({ purpose: 'login', consentHash: 'h' }, async () => {
      await c.verify('u1', 'password', 'correct-horse-battery')
      await c.verifyGroup('u1', { a1: 'rex', a2: 'bangkok' }, { min: 2 })
    })
    const log = await v.consentAudit({})
    const verifyOps = log.filter((e: { op: string }) => e.op === 'verify')
    expect(verifyOps.length).toBe(2)   // 1 for verify + 1 for the whole group call
  }, 240_000)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/hub/__tests__/classified/verify-public-surface.test.ts`
Expected: FAIL — `c.verify is not a function`.

- [ ] **Step 3: Implement**

`strategy.ts` — add the interfaces from **Interfaces** above (`import type { EncryptedEnvelope, EnclaveKey — via kernel/types re-export or kernel/enclave — ClassifiedVerdict }`; keep `EnclaveKey` type import from `'../../kernel/enclave/index.js'`), and extend `NO_CLASSIFIED`:

```ts
export const NO_CLASSIFIED: ClassifiedStrategy = {
  async reveal() { throw new ClassifiedNotEnabledError() },
  async verify() { throw new ClassifiedNotEnabledError() },
  async verifyText() { throw new ClassifiedNotEnabledError() },
  async matchGroup() { throw new ClassifiedNotEnabledError() },
}
```

`active.ts`:

```ts
import type { ClassifiedStrategy, ClassifiedVerifyCtx } from './strategy.js'
import type { VdigFieldPolicy } from '../../kernel/types.js'
import type { ClassifiedFieldSpec } from './descriptor.js'

function policyOf(spec: ClassifiedFieldSpec): VdigFieldPolicy {
  return {
    normalize: spec.verifyNormalize ?? 'password',
    notLastN: spec.notLastN ?? 0,
    ...(spec.rotateDays !== undefined ? { rotateDays: spec.rotateDays } : {}),
  }
}

const engineCtx = (ctx: ClassifiedVerifyCtx) => ({
  collection: ctx.collection,
  getEnvelope: ctx.getEnvelope,
  resolveCek: ctx.resolveCek,
  getDEK: ctx.getDEK,
  now: ctx.now,
})

/** Opt-in factory: enables reveal + verify/verifyText/matchGroup (stage 2). */
export function withClassified(): ClassifiedStrategy {
  return {
    async reveal(ctx, id, field) {
      const { revealField } = await import('./reveal.js')   // reworked in Task 16
      return revealField(ctx, id, field)
    },
    async verify(ctx, id, field, candidate) {
      const { verifyDigestField } = await import('../../kernel/enclave/classify/verify.js')
      const verdict = await verifyDigestField(engineCtx(ctx), id, field, candidate, policyOf(ctx.spec))
      await ctx.onAccess?.('verify', id)                    // fires on ok AND fail (attempt audit)
      return verdict
    },
    async verifyText(ctx, id, field, candidate) {
      const { verifyTextField } = await import('../../kernel/enclave/classify/verify.js')
      const verdict = await verifyTextField(engineCtx(ctx), id, field, candidate, ctx.spec.verifyNormalize ?? 'password')
      await ctx.onAccess?.('verify', id)
      return verdict
    },
    async matchGroup(ctx, id, answers, opts) {
      const { matchGroupFields } = await import('../../kernel/enclave/classify/verify.js')
      const members = (ctx.groupMembers ?? []).map((m) => ({ field: m.field, policy: policyOf(m.spec) }))
      const result = await matchGroupFields(engineCtx(ctx), id, answers, members, opts)
      await ctx.onAccess?.('verify', id)                    // ONE entry per call (Q6)
      return result
    },
  }
}
```

`collection.ts` — beside `reveal()` (collection.ts:1100):

```ts
  /** Verify-without-reveal: verdict-only oracle for one classified field. Requires withClassified(). */
  async verify(id: string, field: string, candidate: string): Promise<ClassifiedVerdict> {
    const spec = this.classified?.byField[field]
    if (spec === undefined) throw new ClassifiedVerifyError(this.name, field, 'field is not classified')
    if (spec.storage === 'never') {
      throw new ClassifiedVerifyError(this.name, field, `storage:'never' — nothing is stored to verify against`)
    }
    const ctx = this.classifiedVerifyCtx(spec)
    return spec.storage === 'digest-only'
      ? this.classifiedStrategy.verify(ctx, id, field, candidate)
      : this.classifiedStrategy.verifyText(ctx, id, field, candidate)
  }

  /** k-of-n challenge over the collection's secretAnswer members. Requires withClassified(). */
  async verifyGroup(id: string, answers: Record<string, string>, opts: { readonly min: number }): Promise<{ readonly passed: boolean }> {
    const members = Object.entries(this.classified?.byField ?? {})
      .filter(([, s]) => s.storage === 'digest-only' && s.verifyGroupMember === true)
      .map(([field, spec]) => ({ field, spec }))
    if (members.length === 0) {
      throw new ClassifiedVerifyError(this.name, '*', 'no groupable digest-only (secretAnswer) fields declared')
    }
    const ctx = { ...this.classifiedVerifyCtx(members[0]!.spec), groupMembers: members }
    return this.classifiedStrategy.matchGroup(ctx, id, answers, opts)
  }

  private classifiedVerifyCtx(spec: ClassifiedFieldSpec): ClassifiedVerifyCtx {
    return {
      collection: this.name,
      spec,
      getEnvelope: (rid) => this.adapter.get(this.vault, this.name, rid),
      resolveCek: (env) => this.codec.resolveEnvelopeCek(env),
      getDEK: () => this.getDEK(),
      now: () => Date.now(), // Q7: injected here; engine tests inject their own
      ...(this.onAccess !== undefined
        ? { onAccess: async (_op: 'verify', rid: string) => { await this.onAccess!('verify', rid) } }
        : {}),
    }
  }
```

plus in `reveal()` after the `'never'` gate:

```ts
    if (spec.storage === 'digest-only') {
      throw new ClassifiedRevealError(this.name, field, `storage:'digest-only' — verify-only; nothing recoverable to reveal`)
    }
```

and widen the `onAccess` field type (collection.ts:570) to `(op: 'get' | 'put' | 'delete' | 'reveal' | 'verify', id: string) => Promise<void>`. `consent.ts:77`: `export type ConsentOp = 'get' | 'put' | 'delete' | 'reveal' | 'verify'`.

Imports for `collection.ts`: `ClassifiedVerifyError` (kernel errors), `type ClassifiedVerdict` (kernel types), `type ClassifiedVerifyCtx` + `type ClassifiedFieldSpec` (with-shape classified).

Barrels/goldens: `classified/index.ts` adds `export type { ClassifiedVerdict, ClassifiedVerifyCtx } from './strategy.js'`; `src/index.ts` adds `export type { ClassifiedVerdict } from ...`. Update `kernel-api.golden.json` (insert `"verify"` and `"verifyGroup"` alphabetically in the Collection methods array — near `"validateInput"`/`"warmIndex"` at kernel-api.golden.json:236-238), `with-surface.golden.json`, `root-barrel-surface.golden.json` per the golden tests' diff output. Bank the `collection.ts` ceiling in `KERNEL_SURFACE_BUDGET` (comment: `// Bumped (2026-07-04, classified stage 2): verify()/verifyGroup() public oracle doors — thin ctx builders; the oracle lives in kernel/enclave/classify/verify.ts.`).

- [ ] **Step 4: Run tests to verify GREEN**

Run: `pnpm vitest run packages/hub/__tests__/classified/ packages/hub/__tests__/kernel-api-surface-golden.test.ts packages/hub/__tests__/with-surface-golden.test.ts packages/hub/__tests__/root-barrel-surface-golden.test.ts && pnpm --filter @noy-db/hub typecheck && pnpm check:architecture`
Expected: all PASS. `check:architecture`'s `strategy-opt-in` check does not gate `.verify(` (not in `STRATEGY_GATED_APIS` — too generic a name; the runtime `NO_CLASSIFIED` throw is the gate, tested above).

- [ ] **Step 5: Commit**

```bash
git add packages/hub/src/with-shape/classified/strategy.ts packages/hub/src/with-shape/classified/active.ts packages/hub/src/with-shape/classified/index.ts packages/hub/src/index.ts packages/hub/src/kernel/collection.ts packages/hub/src/with-audit/consent/consent.ts packages/hub/__tests__/kernel-api.golden.json packages/hub/__tests__/with-surface.golden.json packages/hub/__tests__/root-barrel-surface.golden.json scripts/check-architecture.mjs packages/hub/__tests__/classified/verify-public-surface.test.ts
git commit -m "feat(classified): collection.verify/verifyGroup public oracle + 'verify' consent op"
```

---

### Task 16: Layer C — reveal rework onto raw-envelope (I6)  ⚠ check-bundle canary

**Files:**
- Create: `packages/hub/src/kernel/enclave/classify/reveal.ts` (`revealSealedField`)
- Delete: `packages/hub/src/with-shape/classified/reveal.ts`
- Modify: `packages/hub/src/with-shape/classified/strategy.ts` (`ClassifiedRevealCtx` → raw-envelope shape)
- Modify: `packages/hub/src/with-shape/classified/active.ts` (reveal delegates to the enclave module)
- Modify: `packages/hub/src/kernel/collection.ts` (`reveal()` builds the raw-envelope ctx — no more `this.get()`)
- Modify: `packages/hub/scripts/check-bundle.mjs` (classified scenario `eagerImports`: `'revealField'` → `'revealSealedField'` at check-bundle.mjs:128)
- Test: `packages/hub/__tests__/classified/reveal-rework-parity.test.ts` (stage-1 `reveal-gate.test.ts` must ALSO stay green — it is the behavioral-parity oracle)

**Interfaces:**
- Consumes: Task 15 ctx machinery; `dualReadSealedSlot`; `isTombstone`.
- Produces:

```ts
// strategy.ts — REPLACES the stage-1 getView shape (pre-1.0 type change; names unchanged)
export interface ClassifiedRevealCtx {
  readonly collection: string
  readonly spec: ClassifiedFieldSpec
  /** True on an encrypted collection — false selects the plaintext-body read. */
  readonly encrypted: boolean
  getEnvelope(id: string): Promise<EncryptedEnvelope | null>
  resolveCek(env: EncryptedEnvelope): Promise<EnclaveKey | undefined>
  getDEK(): Promise<EnclaveKey>
  readonly onAccess?: ((op: 'reveal', id: string) => Promise<void>) | undefined
}
// kernel/enclave/classify/reveal.ts
export interface RevealEngineCtx {
  readonly collection: string
  readonly encrypted: boolean
  getEnvelope(id: string): Promise<EncryptedEnvelope | null>
  resolveCek(env: EncryptedEnvelope): Promise<EnclaveKey | undefined>
  getDEK(): Promise<EnclaveKey>
}
export async function revealSealedField(ctx: RevealEngineCtx, id: string, field: string): Promise<unknown>
```

Fail-closed gates preserved (I6, behavioral-parity): (a) `storage:'never'` refused in `collection.reveal` BEFORE any strategy call (already there — unchanged); (b) record not found / tombstone → `ClassifiedRevealError`; (c) absent `_sealed[field]` slot → `ClassifiedRevealError`, never a raw `TypeError` from `parseSealedSlot(undefined)`. Plus: exactly ONE consent entry (`'reveal'`), zero `'get'` entries — reveal no longer materializes the record view.

- [ ] **Step 1: Write the failing test**

```ts
// packages/hub/__tests__/classified/reveal-rework-parity.test.ts
import { describe, it, expect } from 'vitest'
import { createNoydb } from '../../src/kernel/noydb.js'
import { inlineMemory } from './harness.js'
import { classified } from '../../src/with-shape/classified/presets.js'
import { withClassified } from '../../src/with-shape/classified/active.js'
import { withConsent } from '../../src/with-audit/consent/index.js'
import { ClassifiedRevealError } from '../../src/kernel/errors.js'

// Group form exactly as stage-1 reveal-gate.test.ts declares it:
async function openCards(consent = false) {
  const store = inlineMemory()
  const db = await createNoydb({
    store, user: 'a', secret: 'pw-s2-16b', classifiedStrategy: withClassified(),
    ...(consent ? { consentStrategy: withConsent() } : {}),
  })
  const v = await db.openVault('v1')
  const c = v.collection<Record<string, unknown>>('cards', {
    classifiedFields: { card: classified.creditCard({ pan: 'pan' }) },
  })
  return { store, v, c }
}

describe('I6 — reveal rework parity (three fail-closed gates + single consent op)', () => {
  it('reveals the sealed plaintext (byte-parity with stage 1)', async () => {
    const { c } = await openCards()
    await c.put('r1', { pan: '4242424242424242' })
    expect(await c.reveal('r1', 'pan')).toBe('4242424242424242')
  })

  it('gate (b): record not found → ClassifiedRevealError', async () => {
    const { c } = await openCards()
    await expect(c.reveal('ghost', 'pan')).rejects.toBeInstanceOf(ClassifiedRevealError)
  })

  it('gate (c): absent _sealed slot → ClassifiedRevealError, never a TypeError', async () => {
    const { c } = await openCards()
    await c.put('r1', {})                     // record exists, pan never written
    const err = await c.reveal('r1', 'pan').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ClassifiedRevealError)
    expect(err).not.toBeInstanceOf(TypeError)
  })

  it("consent: exactly one 'reveal' entry and ZERO 'get' entries per reveal", async () => {
    const { v, c } = await openCards(true)
    await c.put('r1', { pan: '4242424242424242' })
    await v.withConsent({ purpose: 'support', consentHash: 'h' }, async () => {
      await c.reveal('r1', 'pan')
    })
    const log = await v.consentAudit({})
    expect(log.filter((e: { op: string }) => e.op === 'reveal').length).toBe(1)
    expect(log.filter((e: { op: string }) => e.op === 'get').length).toBe(0)   // the I6 double-entry bug
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/hub/__tests__/classified/reveal-rework-parity.test.ts`
Expected: the consent test FAILS with a spurious `'get'` entry (the I6 bug); the others may already pass — that is the point of a parity suite: pin them BEFORE the rework, then rework under a green pin. If the consent test passes too, STOP and re-read how `onAccess('get')` fires in `collection.get` — the rework still proceeds, the pin protects it.

- [ ] **Step 3: Implement**

```ts
// packages/hub/src/kernel/enclave/classify/reveal.ts
/**
 * Single-point audited reveal, stage-2 rework (I6): decrypt ONE sealed slot
 * from the raw envelope — no full record view, no collection.get(), so no
 * spurious 'get' consent entry. Fail-closed gates (b)/(c) live here; gate
 * (a) (storage:'never') fires in collection.reveal before any strategy call.
 * @module
 */
import { dualReadSealedSlot } from '../record-keys/sealed-slot.js'
import { isTombstone } from '../record-keys/tombstone.js'
import { ClassifiedRevealError } from '../../errors.js'
import type { EncryptedEnvelope } from '../../types.js'
import type { EnclaveKey } from '../crypto.js'

export interface RevealEngineCtx {
  readonly collection: string
  readonly encrypted: boolean
  getEnvelope(id: string): Promise<EncryptedEnvelope | null>
  resolveCek(env: EncryptedEnvelope): Promise<EnclaveKey | undefined>
  getDEK(): Promise<EnclaveKey>
}

export async function revealSealedField(ctx: RevealEngineCtx, id: string, field: string): Promise<unknown> {
  const env = await ctx.getEnvelope(id)
  if (env === null || isTombstone(env, ctx.encrypted)) {
    throw new ClassifiedRevealError(ctx.collection, field, `record "${id}" not found in "${ctx.collection}"`)
  }
  if (!ctx.encrypted) {
    // Plaintext collection: nothing is sealed; the value sits in the open body.
    const record = JSON.parse(env._data || '{}') as Record<string, unknown>
    if (!(field in record)) {
      throw new ClassifiedRevealError(ctx.collection, field, `no stored value for "${field}"`)
    }
    return record[field]
  }
  const blob = env._sealed?.[field]
  if (blob === undefined) {
    // Gate (c): fail-closed error, never parseSealedSlot(undefined)'s TypeError.
    throw new ClassifiedRevealError(ctx.collection, field, `no sealed value stored for "${field}"`)
  }
  const cek = await ctx.resolveCek(env)
  const dek = await ctx.getDEK()
  return JSON.parse(await dualReadSealedSlot(blob, field, ctx.collection, cek, dek))
}
```

`active.ts` reveal member:

```ts
    async reveal(ctx, id, field) {
      const { revealSealedField } = await import('../../kernel/enclave/classify/reveal.js')
      const value = await revealSealedField({
        collection: ctx.collection, encrypted: ctx.encrypted,
        getEnvelope: ctx.getEnvelope, resolveCek: ctx.resolveCek, getDEK: ctx.getDEK,
      }, id, field)
      await ctx.onAccess?.('reveal', id)
      return value
    },
```

`collection.ts` `reveal()` ctx (replacing the `getView` block):

```ts
    return this.classifiedStrategy.reveal({
      collection: this.name,
      spec,
      encrypted: this.storeCiphertext,
      getEnvelope: (rid) => this.adapter.get(this.vault, this.name, rid),
      resolveCek: (env) => this.codec.resolveEnvelopeCek(env),
      getDEK: () => this.getDEK(),
      ...(this.onAccess !== undefined
        ? { onAccess: async (_op: 'reveal', rid: string) => { await this.onAccess!('reveal', rid) } }
        : {}),
    }, id, field)
```

(if the collection's ciphertext flag has a different private name, mirror whatever the codec ctx construction passes as `storeCiphertext`). Delete `with-shape/classified/reveal.ts`; update `check-bundle.mjs:128` canary to `'revealSealedField'` with the comment `// reveal engine must stay behind the dynamic import in classified/active.ts (now enclave-side)`.

- [ ] **Step 4: Run tests to verify GREEN**

Run: `pnpm vitest run packages/hub/__tests__/classified/ && pnpm --filter @noy-db/hub typecheck && pnpm check:architecture && pnpm --filter @noy-db/hub build && pnpm --filter @noy-db/hub bundle-check`
Expected: all PASS — including stage-1 `reveal-gate.test.ts` (parity) and the bundle gate (reveal engine still tree-shaken out of the eager bundle). Note: the enclave-body-only ratchet stays clean because the `_sealed`/`_data` reads moved INTO `kernel/enclave/**` (exempt) and `collection.ts` gained none.

- [ ] **Step 5: Commit**

```bash
git add packages/hub/src/kernel/enclave/classify/reveal.ts packages/hub/src/with-shape/classified/strategy.ts packages/hub/src/with-shape/classified/active.ts packages/hub/src/kernel/collection.ts packages/hub/scripts/check-bundle.mjs packages/hub/__tests__/classified/reveal-rework-parity.test.ts
git rm packages/hub/src/with-shape/classified/reveal.ts
git commit -m "refactor(classified): reveal onto raw-envelope enclave path — one consent op, gates preserved (I6)"
```

---

### Task 17: Layer D — `enclave-classify-only` identifier ratchet (M1)  ⚠ check-architecture

**Files:**
- Modify: `scripts/check-architecture.mjs` (new Check 12 after `checkEnclaveBodyOnly`, wired into the runner where the other checks are invoked)

**Interfaces:**
- Consumes: the final code layout (run after Task 16).
- Produces: a mechanical ban — outside `kernel/enclave/**`, no module in `packages/hub/src/**` may reference the identifiers `deriveVdigSlotKey`, `pbkdf2VerifyDigest`, `ctEqualTags`, or the `'noydb-classify-vdig'` salt literal. Allowlisted: `test-harnesses/enclave-conformance/**` (outside the scanned tree anyway) and `*.test.ts` (tests aren't architecture-bound — same carve-out as `enclave-body-only`). **Explicitly permitted and NOT scanned for:** opaque `_vdig` ciphertext-map transit — `_vdig` is deliberately NOT added to `BODY_FIELD_ACCESS_RE`; `collection.ts`/`vault.ts`/`backup.ts`/`history.ts` legitimately shuttle the blobs and C6's carry-forward requires the codec to copy them verbatim. Boundary: plaintext/digest/key ops = enclave-only; ciphertext plumbing = anywhere.

- [ ] **Step 1: Write the failing "test" (a deliberate violation file)**

```bash
cat > packages/hub/src/kernel/classify-violation-canary.ts << 'EOF'
// TEMP: enclave-classify-only negative canary — MUST be deleted in this task.
export const leak = 'noydb-classify-vdig'
EOF
```

- [ ] **Step 2: Run to verify the check does NOT yet fail (proving the gap)**

Run: `pnpm check:architecture`
Expected: PASSES (wrongly) — the identifier ratchet doesn't exist yet.

- [ ] **Step 3: Implement the check**

Append after `checkEnclaveBodyOnly()`'s definition:

```js
// ─── Check 12: enclave-classify-only (M1 — stage-2 identifier ratchet) ──
//
// Stage-2 classified: plaintext/digest/key operations live ONLY in
// kernel/enclave/** (the classify/ folder). Outside it, referencing the
// verify-crypto identifiers — or the vdig salt-domain literal — is a leak
// of enclave interior into service/kernel code. Opaque `_vdig`
// ciphertext-map TRANSIT is explicitly permitted (collection/vault/backup/
// history shuttle blobs; C6 carry-forward copies them verbatim inside the
// codec), which is why `_vdig` is deliberately absent from
// BODY_FIELD_ACCESS_RE above. Like enclave-body-only: stripComments (not
// strings — the salt literal IS a string), *.test.ts exempt. The
// enclave-conformance kit lives under test-harnesses/ (never scanned).
const CLASSIFY_ENCLAVE_ONLY_RE =
  /\bderiveVdigSlotKey\b|\bpbkdf2VerifyDigest\b|\bctEqualTags\b|noydb-classify-vdig/

function checkEnclaveClassifyOnly() {
  const hubSrc = join(PACKAGES_DIR, 'hub', 'src')
  const enclaveDir = join(hubSrc, 'kernel', 'enclave')
  walkTsFiles(hubSrc, (file, content) => {
    if (file.endsWith('.test.ts')) return
    const insideEnclave = !relative(enclaveDir, file).startsWith('..')
    if (insideEnclave) return
    const code = stripComments(content)
    const m = code.match(CLASSIFY_ENCLAVE_ONLY_RE)
    if (m) {
      fail(
        'enclave-classify-only',
        `${relative(ROOT, file)} references "${m[0]}" — verify-digest crypto identifiers and the ` +
        `'noydb-classify-vdig' salt domain are enclave-interior (M1). Call through the classified ` +
        `strategy seam (with-shape/classified/active.ts dynamic import) or the enclave barrel; ` +
        `opaque _vdig ciphertext transit needs no crypto identifier.`,
        file,
      )
    }
  })
}
```

and invoke `checkEnclaveClassifyOnly()` beside the other check invocations (grep for where `checkEnclaveBodyOnly()` is called and add the new call after it).

- [ ] **Step 4: Verify RED-then-GREEN**

Run: `pnpm check:architecture`
Expected: FAILS on `classify-violation-canary.ts` with the enclave-classify-only message. Then:

```bash
rm packages/hub/src/kernel/classify-violation-canary.ts
pnpm check:architecture
```

Expected: PASSES clean — proving `with-shape/classified/active.ts`'s dynamic imports and all transit sites are within the law.

- [ ] **Step 5: Commit**

```bash
git add scripts/check-architecture.mjs
git commit -m "chore(classified): enclave-classify-only identifier ratchet (M1)"
```

---

### Task 18: Layer D — enclave-conformance kit: classify group + vectors

**Files:**
- Modify: `test-harnesses/enclave-conformance/src/index.ts` (`EnclaveModule` optional classify group; `supports.classify`; classify vector suite in `runEnclaveConformance`)
- Modify: `test-harnesses/enclave-conformance/src/self-test.test.ts` (reference enclave declares `classify: true`)
- (The kit's `conformance.test.ts` needs no change — it passes the whole barrel through.)

**Interfaces:**
- Consumes: Task 5 barrel exports (the kit imports the reference barrel by relative path).
- Produces: `EnclaveModule` gains

```ts
  // ─── optional group: classify (stage-2 verify oracle primitives) ───
  deriveVdigSlotKey(cek: K, collectionName: string, field: string): Promise<K>
  pbkdf2VerifyDigest(value: string, salt: Uint8Array, iterations: number): Promise<Uint8Array>
  ctEqualTags(a: Uint8Array, b: Uint8Array): boolean
  evaluateKofN(results: readonly boolean[], min: number): boolean
```

`EnclaveConformanceOptions.supports` gains `readonly classify: boolean`; `ConformanceGroup` gains `'classify'` (a fork may refuse the group with `EnclaveNotSupportedError`, matching the existing optional-group pattern).

- [ ] **Step 1: Write the failing vectors** — add to `runEnclaveConformance`'s suite (follow the file's existing `describe`/optional-group structure; the refused-group branch mirrors sealing's):

```ts
  describe('classify (stage-2 verify primitives)', () => {
    if (!opts.supports.classify) {
      it('refuses the group with EnclaveNotSupportedError', () => {
        expect(() => enclave.ctEqualTags(new Uint8Array(32), new Uint8Array(32)))
          .toThrowError(expect.objectContaining({ code: NOT_SUPPORTED_CODE }))
      })
      return
    }

    it('pbkdf2VerifyDigest: 32 bytes, deterministic, salt-separated', async () => {
      const salt = new Uint8Array(32).fill(3)
      const a = await enclave.pbkdf2VerifyDigest('candidate', salt, 1_000)
      const b = await enclave.pbkdf2VerifyDigest('candidate', salt, 1_000)
      const c = await enclave.pbkdf2VerifyDigest('candidate', new Uint8Array(32).fill(4), 1_000)
      expect(a.length).toBe(32)
      expect([...a]).toEqual([...b])
      expect([...a]).not.toEqual([...c])
    })

    it('ctEqualTags: equal/unequal verdicts + exact-32 precondition', () => {
      const t = new Uint8Array(32).fill(9)
      expect(enclave.ctEqualTags(t, new Uint8Array(32).fill(9))).toBe(true)
      const off = new Uint8Array(32).fill(9); off[0] = 8
      expect(enclave.ctEqualTags(t, off)).toBe(false)
      expect(() => enclave.ctEqualTags(new Uint8Array(31), t)).toThrow()
    })

    it('evaluateKofN truth table + bounds', () => {
      expect(enclave.evaluateKofN([true, false, true], 2)).toBe(true)
      expect(enclave.evaluateKofN([true, false, false], 2)).toBe(false)
      expect(() => enclave.evaluateKofN([true], 0)).toThrow()
      expect(() => enclave.evaluateKofN([true], 2)).toThrow()
    })

    it('vdig slot key: AAD-bound round-trip + cross-record/field splice rejection (C1)', async () => {
      const cek = await enclave.generateDEK()
      const key = await enclave.deriveVdigSlotKey(cek, 'users', 'password')
      const aad = (rid: string, f: string) =>
        new TextEncoder().encode(JSON.stringify(['noydb-classify-vdig', 'users', rid, f]))
      const sealed = await enclave.encryptBytesWithAAD(
        new TextEncoder().encode('{"v":1}'), key as never, aad('r1', 'password'))
      const back = await enclave.decryptBytesWithAAD(sealed.iv, sealed.data, key as never, aad('r1', 'password'))
      expect(new TextDecoder().decode(back)).toBe('{"v":1}')
      await expect(enclave.decryptBytesWithAAD(sealed.iv, sealed.data, key as never, aad('r2', 'password')))
        .rejects.toThrow() // spliced to another record
      const keyOtherField = await enclave.deriveVdigSlotKey(cek, 'users', 'pin')
      await expect(enclave.decryptBytesWithAAD(sealed.iv, sealed.data, keyOtherField as never, aad('r1', 'pin')))
        .rejects.toThrow() // spliced to another field (key AND aad domain-separated)
    })
  })
```

(`encryptBytesWithAAD`/`decryptBytesWithAAD` may need adding to `EnclaveModule` if absent — check the interface; they are barrel exports, so add them beside the crypto-ops group if missing.)

- [ ] **Step 2: Run to verify RED**

Run: `pnpm --filter @noy-db/test-enclave-conformance test`
Expected: FAIL — TypeScript: `supports.classify` missing / `enclave.deriveVdigSlotKey` not on `EnclaveModule` (until the interface + self-test option are added). Add the interface members + `classify: boolean` + self-test `classify: true`, re-run to see the real vectors execute.

- [ ] **Step 3: Complete the implementation** — interface members from **Interfaces**, `'classify'` in `ConformanceGroup`, `classify: true` in `self-test.test.ts` and in `conformance.test.ts`'s `runEnclaveConformance(enclave, { supports: { ... } })` call.

- [ ] **Step 4: Run to verify GREEN**

Run: `pnpm --filter @noy-db/test-enclave-conformance test`
Expected: PASS — reference enclave satisfies the classify group.

- [ ] **Step 5: Commit**

```bash
git add test-harnesses/enclave-conformance/src/index.ts test-harnesses/enclave-conformance/src/self-test.test.ts test-harnesses/enclave-conformance/src/conformance.test.ts
git commit -m "test(classified): enclave-conformance classify group — C1/C2 primitive vectors"
```

---

### Task 19: Layer D — bundle-gate canaries for the verify engine  ⚠ check-bundle

**Files:**
- Modify: `packages/hub/scripts/check-bundle.mjs` (classified scenario, check-bundle.mjs:117-130)

**Interfaces:**
- Consumes: Tasks 15/16 shipped code (`verifyDigestField` / `matchGroupFields` / `revealSealedField` / `mintVdigSlot` names in dist output when eagerly bundled).
- Produces: the classified scenario's `eagerImports` canary list keeps the WHOLE stage-2 engine behind the dynamic-import seam (stage-1 negative-test methodology: the canary greps the eager bundle for engine identifiers; size tolerance is the secondary detector).

- [ ] **Step 1: Make it RED first (negative test — prove the canary detects a leak)**

Temporarily add to `packages/hub/src/with-shape/classified/active.ts` a static import: `import { verifyDigestField as _leak } from '../../kernel/enclave/classify/verify.js'` and `void _leak`. Update the scenario:

```js
    eagerImports: [
      'revealSealedField', // reveal engine (enclave-side since stage 2)
      'verifyDigestField', // verify oracle — MUST stay behind active.ts's dynamic import
      'matchGroupFields',
      'mintVdigSlot',      // write-side digest engine (codec-internal, never eager via the strategy)
    ],
```

Run: `pnpm --filter @noy-db/hub build && pnpm --filter @noy-db/hub bundle-check`
Expected: FAIL — `verifyDigestField` found in the eager classified bundle.

- [ ] **Step 2: Remove the leak**

Delete the temporary static import from `active.ts`.

- [ ] **Step 3: Verify GREEN**

Run: `pnpm --filter @noy-db/hub build && pnpm --filter @noy-db/hub bundle-check`
Expected: PASS — all four canaries absent from the eager bundle; size within tolerance. NOTE: `mintVdigSlot` reaches the bundle through `record-codec.ts` (statically imported by the kernel) — if the canary fires on the BASE scenario because the codec is eager, that is a REAL architectural finding: gate the codec's classify import behind a lazy `await import('../classify/write.js')` inside the C6 branch (mirror `active.ts`'s pattern), re-run Task 7/8 tests, and keep the canary. Do not simply delete the canary.

- [ ] **Step 4: Commit**

```bash
git add packages/hub/scripts/check-bundle.mjs
git commit -m "chore(classified): bundle-gate canaries for the stage-2 verify engine"
```

---

### Task 20: Layer D — SERVICES.md + goldens sweep + FULL cross-package gate + coverage audit

**Files:**
- Modify: `SERVICES.md` (row 25 `@noy-db/hub/classified`: description gains "verify-without-reveal (digest-only presets, k-of-n matchGroup)"; adjust the ~LOC column to the new count)
- Modify: `features.yaml` — ONLY IF the file exists on this branch (`ls features.yaml`); it was removed in the 0.3 reorg on some lines. If present: extend the classified feature entry with `verify`, `verifyGroup`, `password`, `secretAnswer` capabilities and run `pnpm validate:features`.
- No code changes — this is the integration gate.

- [ ] **Step 1: Docs**

Update `SERVICES.md` row 25 as above. If `docs/subsystems/classified.md` (or the docs repo pointer) exists in-tree, add the stage-2 section: digest-only storage form, verify/verifyGroup, rotateDays/notLastN (cap 8 — n × 600K PBKDF2 write cost), the M2 ring blast-radius note (a vdig-slot-key compromise exposes ≤8 correlated historical digests; `notLastN: 0`/omit keeps the current-only baseline), the M3 history/pod note (rotated-away digests persist in `_history` snapshots until prune — a shadow ring beyond the cap; `.noydb` pods carry every slot ciphertext-only, ZK holds; `getVersion()` never exposes digests; `diff()` is empty for rotation-only writes), and the §5 oracle-abuse note (no hub rate limiter this slice; enumeration math for low-entropy fields is the caller's problem — app-side rate hooks).

- [ ] **Step 2: The full gate (hub API changed ⇒ whole-repo suite)**

```bash
pnpm build && pnpm test && pnpm lint && pnpm typecheck && pnpm check:architecture && pnpm --filter @noy-db/hub bundle-check && pnpm knip
```

Expected: everything green. Fix regressions in place; if a fix touches a frozen surface, its golden moves in the same commit.

- [ ] **Step 3: Coverage audit** — walk the checklist below; every row must point at a merged test. Any gap = add the missing test NOW, in this task.

- [ ] **Step 4: Commit**

```bash
git add SERVICES.md features.yaml docs 2>/dev/null; git add -u
git commit -m "docs(classified): stage-2 verify oracle — service catalog + subsystem notes"
```

Then hand off to the spec's security-review gate (M-2..M-5 rhythm) before any merge/PR.

---

## Coverage checklist — Refusal matrix + §6 conformance vectors → tasks

Every row names the task(s) whose test files contain the concrete assertion.

| Requirement | Task(s) / test file |
|---|---|
| **R1** digest-only without `perRecordKeys` refused (both doors) | 13 — `refusal-matrix.test.ts` ("R1", "R1 second door") |
| **R2** digest-only/recoverable × crdt/conflictPolicy refused (both doors) | 13 — `refusal-matrix.test.ts` ("R2", "R2 second door") |
| **R3** digest-only ∈ deterministicFields refused + codec `_det` mirror | 13 — `refusal-matrix.test.ts` ("R3"); 7 — `codec-vdig-write.test.ts` ("I5") |
| **R4** digest-only ∈ indexes / text index / vector / subject-key refused | 13 — `refusal-matrix.test.ts` ("R4"; subject-key path via `subjectKeyField` guard — covered by the guard unit path in the same test's vector case; extend with a `withForgetCascade` case if the harness supports it cheaply) |
| **R5** storage-form exclusivity per field (double-claim + bare `sensitive[]` overlap) | 12 — `digest-presets.test.ts` ("R5"); 13 — `refusal-matrix.test.ts` ("R5-overlap") |
| **R6** transitions refused: session re-declaration / write-side `prev._sealed` evidence / verify-side `_sealed`-without-`_vdig` | 13 ("R6 session"); 7 ("R6 write-side"); 14 ("R6 verify-side", both verify + matchGroup up-front pass) |
| §6 vdig round-trip (write→verify ok/fail) | 14 — `verify-engine.test.ts` ("round-trip"); 15 — `verify-public-surface.test.ts` (end-to-end) |
| §6 AAD-mismatch rejection — spliced blob → `ok:false` (C1) | 4 — `vdig-slot.test.ts` (TamperedError, cross-record + cross-field); 14 ("spliced from another record → ok:false"); 18 — kit vector |
| §6 carry-forward — unrelated `put()` preserves verify; `field: null` clears; ledger hash byte-stable across pure carry-forward (C6) | 7 ("carry-forward … BYTE-VERBATIM", "clear branch"); 8 — `put-carry-forward.test.ts` (verbatim bytes ⇒ `envelopeBodyForHash` stability follows from 11's determinism tests); 11 — `vdig-ledger-hash.test.ts` |
| §6 rotate→verify ok — `rotateRecordCek` + `revokeSealedRecord({hard:true})` (C3) | 9 — `rotate-preserves-vdig.test.ts` (envelope level); 15 ("C3 vector at the public surface") |
| §6 timing parity — missing record/slot/answer vs wrong candidate (C4) | 14 ("C4 timing parity"; missing-answer pad exercised in the matchGroup "missing answers contribute false" case, which runs the pad per absent member) |
| §6 ct-equal fixed-tag — equal/unequal + length-invariance wall-time + tag-length preconditions (C2) | 2 — `ct-equal.test.ts` (all three); 18 — kit vector |
| §6 k-of-n truth table incl. `min` bounds, missing-answer pad, non-member-key ignore, uniform up-front validation (I2) | 3 — `kofn.test.ts` (table + bounds); 14 — matchGroup suite (pad, ignore, ~0-elapsed uniform throw); 18 — kit vector |
| §6 `mustRotate` absent on every `ok:false` (I1) | 14 ("I1", both the wrong-candidate and stale-AND-wrong cases) |
| §6 mutual exclusion — digest-only write emits no `_sealed[field]` (I4) | 7 ("rotate branch … no _sealed"); 8 (`put-carry-forward` asserts `_sealed?.password` undefined) |
| §6 ring rotation — `notLastN` reuse refusal (cap 8) | 7 ("notLastN ring"); 12 (cap validation in `password()`) |
| §6 ratchet (M1) — identifier ban + transit permission | 17 (negative canary RED → GREEN) |
| Goldens all additive — enclave barrel +4, kernel-api +verify/verifyGroup, root barrel +errors/verdict | 5, 12, 15 (goldens updated in-task, verified by their golden tests) |
| Bundle gate — verify engine behind the dynamic-import seam | 19 (negative test then green); 16 (reveal canary rename) |
| Consent — one `'verify'` op per verify AND per matchGroup call (Q6); reveal single-entry (I6) | 15 ("Q6"); 16 ("consent: exactly one 'reveal' … ZERO 'get'") |
| forget/tombstone — `_vdig` shreddable, no dekResidue class (I3) | 10 — `forget-vdig.test.ts` |
| Ledger conditional widen — legacy byte-compat + `_vdig` binding (C1 temporal) | 11 — `vdig-ledger-hash.test.ts` |

**Known spec tension flagged for the security review (do NOT silently resolve):** §3's C4 rule pads `verifyText`'s missing-slot paths with a dummy **PBKDF2**, while §3's residual note says verifyText's mandatory per-path work is the AES-GCM unseal — a padded miss is therefore *slower* than a real text compare (an inverted, not eliminated, distinguisher). Task 14 implements the rule as written (spec is authoritative); the review gate should confirm or amend.
