# Classified Fields Slice 2b — `_bidx` Equatable Blind Index + `findByDigest` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Opt-in **equatable blind index** for `digest-only` classified fields (`password()` / `secretAnswer()`), materialized as a store-visible keyed slow-tag per record (`_bidx`), plus `collection.findByDigest(field, candidate)` that scans the tags and returns **record ids** — every hit confirmed through the stage-2 `_vdig` verify path before its id leaves the hub. Per the SIGNED-OFF, post-audit spec `docs/superpowers/specs/2026-07-04-classified-slice2b-bidx-design.md` (return shape = ids · C-A config-drift guard back-ported to stage-2 `_vdig` in this slice · `acknowledgeEquatableRisk` name kept · 1-byte cost/version discriminator kept).

**Architecture:** Two new enclave modules `kernel/enclave/classify/bidx.ts` (`deriveClassifyIndexKey` / `deriveClassifyIndexSalt` / `mintBidxTag`) + `kernel/enclave/classify/find.ts` (`computeBidxTarget`) sit behind the Contract v1 barrel (**4 new barrel exports**). The tag is a **slow-tag**: `COST_BYTE ‖ HMAC(K_idx, PBKDF2(normalizeForVerify(value), salt_cf, 600K))` — it reuses the stage-2 `normalizeForVerify` + `pbkdf2VerifyDigest` primitives (one pipeline, never a second), under two DEK-rooted HKDF derivations (`K_idx` for the MAC, `salt_cf` for the fixed inner salt). The envelope gains an optional `_bidx` slot (store-visible, no inline integrity by construction). The codec write path gains monotonic-carry / rotate / clear branches mirroring the C6 `_vdig` block; the **C-A config-drift guard** (persisted `x-classified` marker + `ClassifiedConfigError` codec throw) is added AND **back-ported to stage-2 `_vdig`** in this slice. `findByDigest` lives on `Collection` + a `findByDigest` strategy member (`NO_CLASSIFIED` throwing stub), delegating the target derivation via the existing `active.ts` dynamic-import seam; confirm-by-verify calls the stage-2 `verifyDigestField` **inner** on the already-fetched scan envelope (never the re-fetching `strategy.verify` wrapper). Rotation carries `_bidx` verbatim; `forget()` drops it; the ledger hash conditionally widens; `scrubEquatableTags(field)` is the sole live-record tag drop-path. Governance (ratchet, conformance kit, goldens, bundle canary, two changesets, security-review gate) locks it in.

**Tech Stack:** TypeScript ESM, `crypto.subtle` only, vitest, pnpm + turbo. Worktree root: `/Users/vicio/lanna-db/.worktrees/classified-slice2b` — **all paths below are relative to it; run all commands from it.**

## Global Constraints (verbatim hard rules from the spec + repo law)

- **Hub stays portable** — no Node built-ins in `packages/hub/src/**`; `timingSafeEqual` is Node-only and therefore banned; every crypto op via `globalThis.crypto.subtle`, zero npm crypto deps.
- **Encryption happens inside `@noy-db/hub` before any storage backend is called.** Stores see ciphertext only — with the **single, deliberate exception of `_bidx`**, the only store-visible artifact in the entire classified design (a keyed MAC, never plaintext, never a bare hash).
- **Enclave Contract v1:** the barrel (`kernel/enclave/index.ts`) is additive-only; nothing outside `kernel/enclave/**` may reference `deriveClassifyIndexKey`, `deriveClassifyIndexSalt`, `mintBidxTag`, `computeBidxTarget`, or the literals `'noydb-classify-index-v1'` / `'noydb-classify-index-salt-v1'` (conformance-kit + `*.test.ts` allowlisted). Opaque `_bidx` tag-map transit is PERMITTED anywhere (codec carry-forward, `sealing.ts` verbatim carry, backup/history plumbing).
- **Goldens are frozen contracts** — any task that changes a surface updates the matching golden JSON **in the same task/commit** (flagged per task below). Same for `KERNEL_SURFACE_BUDGET` ceilings and check-bundle baselines. **One golden change here is NON-additive** (`classifySealedShred` return shape, Task 8) — flagged explicitly.
- **Never** add Claude attribution to commits/PRs/CHANGELOGs. **Never** reference the private pilot client (grep the diff before any commit). **Never** publish without explicit user confirmation.
- **Lint + typecheck before push** — CI runs ESLint too: `pnpm lint && pnpm typecheck` locally, not just typecheck.
- **Full cross-package suite for hub API changes:** `pnpm build && pnpm test && pnpm lint && pnpm typecheck && pnpm check:architecture` at the end of every layer, and mandatorily in Task 18.
- **TDD:** every task is failing test → verify RED → implement → verify GREEN → commit.

### Slice-2b-specific hard rules (from the spec — non-negotiable, each has a conformance vector)

- **≥1-PBKDF2 cost floor, ALWAYS — including an empty collection (I-1).** `findByDigest` computes the 600K-iteration `computeBidxTarget` **unconditionally BEFORE the scan**. A hoisted `if (ids.length === 0) return []` (or any early return preceding the target derivation) is **FORBIDDEN** — it is the F1 inverted-economics leak ("collection empty vs not" as a timing oracle). An empty-collection call runs **exactly one** PBKDF2, statistically wall-time-equal to a zero-hit populated call.
- **In-hand confirm / zero-extra-gets store-shape (C-B).** Confirm-by-verify reads `_vdig[field]` from the envelope **already fetched during the scan**, never a second `adapter.get`. `findByDigest` issues to the store exactly **`list` + N `get`** — zero additional gets regardless of hit count — byte-for-byte the same call sequence as `findByDet`. It MUST call `verifyDigestField` **INNER** (on the in-hand envelope), never `strategy.verify` (which re-fetches via `ctx.getEnvelope` and emits a per-id `'verify'` op).
- **Monotonic carry / no lazy scrub (I-3).** On a write where the field is ABSENT, `prev._bidx[field]` is copied **verbatim whenever `prev._vdig[field]` is carried — always, regardless of the writing handle's current `equatable` knob**. Coverage only ever grows on a secret-rotate; a handle with `equatable` removed can never silently retire another handle's tag. Retirement is explicit-only (`scrubEquatableTags` / clear / `forget()` / DEK-rotation).
- **R10 both-doors config-drift guard.** A write whose codec has `vdigFields === null` but whose target `prev` carries `_vdig`/`_bidx` (or whose collection's persisted `x-classified` marker is set) MUST throw `ClassifiedConfigError` — never a silent plaintext `_data` write, never a silent tag drop. Enforced for BOTH `_bidx` and (back-ported) stage-2 `_vdig`-only records.
- **The 1-byte discriminator.** Every tag is `COST_BYTE ‖ 32-byte MAC` (33 bytes base64-encoded). `COST_BYTE` encodes `(version, iteration-tier)` (`0x01` = v1/600K). `computeBidxTarget` mints at the **stored tag's** discriminator when scanning; a mismatched discriminator is a cheap non-match (no wrong-tier PBKDF2); the target is derived **once per call at step 2** (one extra derivation per distinct tier present on a mixed-tier scan, bounded and rare).
- **The `'*'` non-collision sentinel.** `findByDigest` emits its single `onAccess('find', '*')` consent op. `'*'` is a NEW consent-recordId sentinel ("no single record" / sweep marker); a golden asserts it can never collide with a real store id (ULID/user-id never equals `'*'`).
- **`_bidx ⇒ _vdig` invariant.** The writer never emits an orphan tag; `_bidx[field]` present ⇒ `_vdig[field]` present. A read-side orphan (store tamper) is inert — confirm-by-verify makes it unreturnable.
- **Security-review gate (spec §6):** after Task 18, the implementation goes through the final adversarial security review (focus: C-A guard completeness, C-B store-shape parity, I-3 monotonic soundness, honest GPU/ASIC cost band, the tag version-byte scan logic) before merge. Do not merge without it.

## Dependency layers & parallelization

| Layer | Tasks | Parallelizable within layer |
|---|---|---|
| A — enclave primitives (tag + target) | 1, 2, 3 | 1 first (spine); 2 after 1 (`find.ts` imports the derivations); 3 after 1+2 |
| B — envelope, codec, lifecycle | 4, 5, 6, 7, 8, 9 | 4 first (spine types); 5 after 4+1; 6 after 5 (guard is in the codec); 7, 8, 9 after 4 in parallel |
| C — surface, findByDigest, refusals, sweep | 10, 11, 12, 13, 14 | 10 after 4 (surface knobs); 11 after 4 (consent union, parallel to 10); 12 after 2+10; 13 after 5+10+11+12; 14 after 5 |
| D — governance | 15, 16, 17, 18 | 15 after 3; 16 after 3 (parallel to 15); 17 after 12+13; 18 last |

**Golden/budget-touching tasks (baseline update in the SAME task):**
- Task 3 — enclave-surface golden (+4 exports).
- Task 8 — **`classifySealedShred` return-shape golden CHANGES (NON-additive)**; kernel-surface ceiling `record-codec.ts` if tripped.
- Task 10 — with-surface / describe goldens if `x-classified.equatable` emission trips them; kernel-surface ceilings `collection-config.ts`.
- Task 11 — kernel-api golden (`'find'` in the `onAccess`/`ConsentOp` unions, three widening sites) + **`'*'`-non-collision golden** (new).
- Task 13 — kernel-api golden (+`findByDigest` on `Collection`) + kernel-surface ceiling `collection.ts`.
- Task 14 — kernel-api golden (+`scrubEquatableTags` on `Collection`) + kernel-surface ceiling `collection.ts`.
- Task 15 — check-architecture (new `enclave-classify-index-only` identifiers/literals in the ratchet).
- Task 17 — check-bundle canary (find engine behind the `active.ts` dynamic-import seam).

**File map (who owns what):**

- `packages/hub/src/kernel/enclave/classify/bidx.ts` — NEW: `deriveClassifyIndexKey`, `deriveClassifyIndexSalt`, `mintBidxTag`, `COST_BYTE` / discriminator helpers, the two salt-domain literals.
- `packages/hub/src/kernel/enclave/classify/find.ts` — NEW: `computeBidxTarget` (query side; normalize + same three steps at a chosen discriminator).
- `packages/hub/src/kernel/enclave/index.ts` — barrel +4 classify-index exports.
- `packages/hub/src/kernel/types.ts` — `_bidx` envelope slot; `equatable` on `VdigFieldPolicy`; the `x-classified` config-marker shape.
- `packages/hub/src/kernel/errors.ts` — reuse `ClassifiedConfigError` / `ClassifiedVerifyError` (both already exist, kernel-owned since stage 2 — no new class).
- `packages/hub/src/kernel/enclave/record-keys/record-codec.ts` — `_bidx` write branches (monotonic carry / rotate / clear / error); R10 config-drift throw; `classifySealedShred` third-category shape change.
- `packages/hub/src/kernel/enclave/record-keys/sealing.ts` — `rotateRecordCek` verbatim `_bidx` carry (beside `_det`/`_tier` at sealing.ts:216-217).
- `packages/hub/src/kernel/enclave/record-keys/envelope-body.ts` — `envelopeBodyForHash` fast-path guard extended to `_bidx === undefined` (line 112) + `_bidx` segment appended LAST.
- `packages/hub/src/with-shape/persisted-schemas/register.ts` — persist the `x-classified` marker on first classified write (reuse `persistSchemaIfNeeded`).
- `packages/hub/src/kernel/collection-config.ts` — `equatable` into `vdigFields` policy build; `onAccess` union +`'find'` (collection-config.ts:307); `acknowledgeEquatableRisk` flag into `ClassifiedGuardCtx`.
- `packages/hub/src/kernel/collection.ts` — `findByDigest()`, `scrubEquatableTags()`, the find algorithm + R9 runtime refusal.
- `packages/hub/src/with-shape/classified/` — `descriptor.ts` (`equatable?` on `ClassifiedFieldSpec` + policy), `presets.ts` (`equatable` passthrough on `password`/`secretAnswer`), `guards.ts` (R7/R8 both-door), `strategy.ts` (+`findByDigest` member, `NO_CLASSIFIED` throwing stub, ctx `onAccess` +`'find'` at strategy.ts:30), `active.ts` (`computeBidxTarget` dynamic import).
- `packages/hub/src/with-shape/introspection/json-schema.ts` — `x-classified.equatable` emission (json-schema.ts:44); `describe()` path in `collection.ts`.
- `packages/hub/src/with-audit/consent/consent.ts` — `ConsentOp` union +`'find'` (consent.ts:77).
- Governance: `scripts/check-architecture.mjs`, `packages/hub/scripts/check-bundle.mjs`, `test-harnesses/enclave-conformance/`, goldens under `packages/hub/__tests__/`, `SERVICES.md`, `features.yaml`, `.changeset/`.
- Tests: slice-2b tests in `packages/hub/__tests__/classified/` beside the stage-1/stage-2 suites (tests are exempt from the architecture ratchets, so they may deep-import `kernel/enclave/classify/*`).

**Shared test harness:** every integration test below reuses the **existing** stage-2 `inlineMemory()` helper at `packages/hub/__tests__/classified/harness.ts` (`InlineMemoryStore` with `_dump(vault, collection, id)` raw peek). Do NOT re-extract it. For the store-shape (C-B) vector, wrap `inlineMemory()` in a thin **spy store** that records the ordered `('list'|'get', …)` call sequence — define that spy once in `harness.ts` as `spyStore(inner)` (pure test util, no golden impact) in Task 13 and import it where needed.

---

### Task 1: Layer A — `bidx.ts`: index key + salt derivations + `mintBidxTag` slow-tag

**Files:**
- Create: `packages/hub/src/kernel/enclave/classify/bidx.ts`
- Test: `packages/hub/__tests__/classified/bidx-tag-primitive.test.ts`

**Interfaces:**
- Consumes: `globalThis.crypto.subtle`; stage-2 `pbkdf2VerifyDigest` + `VDIG_ITERATIONS` (`./digest.js`), `normalizeForVerify` + `VerifyNormalizeMode` (`./normalize.js`); `EnclaveKey` (`../crypto.js`).
- Produces:
  - `export const CLASSIFY_INDEX_KEY_DOMAIN = 'noydb-classify-index-v1'`
  - `export const CLASSIFY_INDEX_SALT_DOMAIN = 'noydb-classify-index-salt-v1'`
  - `export const COST_BYTE_V1 = 0x01` — `(version 1, iteration-tier 600K)`; `export const CURRENT_COST_BYTE = COST_BYTE_V1`
  - `export function iterationsForCostByte(b: number): number | null` — `0x01 → 600_000`; unknown → `null` (a mismatched/legacy discriminator ⇒ cheap non-match, never a wrong-tier PBKDF2)
  - `export async function deriveClassifyIndexKey(dek: EnclaveKey, collection: string, field: string): Promise<EnclaveKey>` — HKDF-SHA256(DEK, salt `'noydb-classify-index-v1'`, info `JSON.stringify(['noydb-classify-index-v1', collection, field])`) → **non-extractable HMAC-SHA256, `['sign']`**, 256-bit
  - `export async function deriveClassifyIndexSalt(dek: EnclaveKey, collection: string, field: string): Promise<Uint8Array>` — HKDF-**deriveBits**(DEK, salt `'noydb-classify-index-salt-v1'`, info `JSON.stringify(['noydb-classify-index-salt-v1', collection, field])`) → 32 raw bytes (a **separate** DEK derivation — sign-key hygiene, NOT `HMAC(K_idx, const)`)
  - `export async function mintBidxTag(normalized: string, dek: EnclaveKey, collection: string, field: string): Promise<string>` — composes the three steps at `CURRENT_COST_BYTE`: `inner = pbkdf2VerifyDigest(normalized, salt_cf, iterationsForCostByte(CURRENT_COST_BYTE)!)`; `mac = HMAC(K_idx, inner)`; `tag = base64(concat([CURRENT_COST_BYTE], mac))` (33 bytes). **Consumes an already-normalized value** — the caller normalizes once (shared pipeline with `mintVdigSlot`); `mintBidxTag` never re-normalizes.

- [ ] **Step 1: Write the failing test**

```ts
// packages/hub/__tests__/classified/bidx-tag-primitive.test.ts
import { describe, it, expect } from 'vitest'
import { generateDEK } from '../../src/kernel/enclave/index.js'
import { normalizeForVerify } from '../../src/kernel/enclave/classify/normalize.js'
import {
  CLASSIFY_INDEX_KEY_DOMAIN, CLASSIFY_INDEX_SALT_DOMAIN, COST_BYTE_V1, CURRENT_COST_BYTE,
  iterationsForCostByte, deriveClassifyIndexKey, deriveClassifyIndexSalt, mintBidxTag,
} from '../../src/kernel/enclave/classify/bidx.js'

const b64 = (s: string) => Uint8Array.from(atob(s), c => c.charCodeAt(0))

describe('bidx salt/key domains + discriminator', () => {
  it('pins the two HKDF salt-domain literals and the v1 cost byte', () => {
    expect(CLASSIFY_INDEX_KEY_DOMAIN).toBe('noydb-classify-index-v1')
    expect(CLASSIFY_INDEX_SALT_DOMAIN).toBe('noydb-classify-index-salt-v1')
    expect(COST_BYTE_V1).toBe(0x01)
    expect(CURRENT_COST_BYTE).toBe(0x01)
    expect(iterationsForCostByte(0x01)).toBe(600_000)
    expect(iterationsForCostByte(0x7f)).toBeNull() // unknown tier → cheap non-match
  })

  it('salt is 32 raw bytes and separated per (collection, field)', async () => {
    const dek = await generateDEK()
    const s1 = await deriveClassifyIndexSalt(dek, 'users', 'password')
    const s2 = await deriveClassifyIndexSalt(dek, 'users', 'pin')
    const s3 = await deriveClassifyIndexSalt(dek, 'admins', 'password')
    expect(s1.length).toBe(32)
    expect([...s1]).not.toEqual([...s2]) // per-field
    expect([...s1]).not.toEqual([...s3]) // per-collection
  })
})

describe('mintBidxTag slow-tag (COST_BYTE ‖ HMAC(K_idx, PBKDF2(...)))', () => {
  it('equal normalized values → equal 33-byte tags (equatability); cost byte prefix', async () => {
    const dek = await generateDEK()
    const n = normalizeForVerify('secret-answer', 'Fluffy The Cat')
    const t1 = await mintBidxTag(n, dek, 'users', 'answer')
    const t2 = await mintBidxTag(n, dek, 'users', 'answer')
    expect(t1).toBe(t2)                              // deterministic ⇒ equatable
    const raw = b64(t1)
    expect(raw.length).toBe(33)                      // 1-byte discriminator ‖ 32-byte MAC
    expect(raw[0]).toBe(CURRENT_COST_BYTE)
  }, 30_000)

  it('join-attack separation: same value, different field OR collection → different tags', async () => {
    const dek = await generateDEK()
    const n = normalizeForVerify('password', 'correct horse battery')
    const a = await mintBidxTag(n, dek, 'users', 'password')
    const b = await mintBidxTag(n, dek, 'users', 'pin')       // different field
    const c = await mintBidxTag(n, dek, 'admins', 'password') // different collection
    expect(a).not.toBe(b)
    expect(a).not.toBe(c)
  }, 30_000)

  it('different DEK → different tag (key-less store cannot mint)', async () => {
    const d1 = await generateDEK(); const d2 = await generateDEK()
    const n = normalizeForVerify('password', 'hunter2-hunter2')
    expect(await mintBidxTag(n, d1, 'users', 'password'))
      .not.toBe(await mintBidxTag(n, d2, 'users', 'password'))
  }, 30_000)
})
```

- [ ] **Step 2: Run test to verify it fails** — `pnpm vitest run packages/hub/__tests__/classified/bidx-tag-primitive.test.ts` → FAIL (`Cannot find module .../classify/bidx.js`).

- [ ] **Step 3: Write the implementation** — `bidx.ts`. Both derivations follow L-1 (dedicated HKDF keys from day one; no legacy form, no dual-query). `deriveClassifyIndexKey` exports the DEK raw, imports as HKDF, derives 256 bits, imports as non-extractable `HMAC`/`['sign']`. `deriveClassifyIndexSalt` derives 32 raw bytes via `deriveBits`. `mintBidxTag` calls stage-2 `pbkdf2VerifyDigest(normalized, salt_cf, 600_000)` → `subtle.sign('HMAC', K_idx, inner)` → `base64(concat([CURRENT_COST_BYTE], mac))`. Add a `@module` docblock naming the M-2/I3 rationale (keyed HMAC blocks key-less dictionary; inner PBKDF2 is the cost floor for a DEK holder; **the door is the real control**, per §4/Crypto #1).

- [ ] **Step 4: Run test to verify it passes** — `pnpm vitest run packages/hub/__tests__/classified/bidx-tag-primitive.test.ts` → PASS (all). Also `pnpm check:architecture` clean (change inside the enclave).

- [ ] **Step 5: Commit**

```bash
git add packages/hub/src/kernel/enclave/classify/bidx.ts packages/hub/__tests__/classified/bidx-tag-primitive.test.ts
git commit -m "feat(classified): bidx slow-tag primitive — DEK-rooted K_idx/salt_cf + COST_BYTE discriminator"
```

**Dependencies:** stage-2 `digest.ts` + `normalize.ts` (present). No task deps.

---

### Task 2: Layer A — `find.ts`: `computeBidxTarget` (query side, discriminator-aware)

**Files:**
- Create: `packages/hub/src/kernel/enclave/classify/find.ts`
- Test: `packages/hub/__tests__/classified/bidx-target.test.ts`

**Interfaces:**
- Consumes: Task 1 (`deriveClassifyIndexKey`, `deriveClassifyIndexSalt`, `iterationsForCostByte`, `CURRENT_COST_BYTE`); stage-2 `normalizeForVerify`; `EnclaveKey`; `VdigFieldPolicy` (`../../types.js`, gains `equatable` in Task 4 — for now `find.ts` needs only `policy.normalize`).
- Produces:
  - `export async function computeBidxTarget(candidate: string, normalize: VerifyNormalizeMode, dek: EnclaveKey, collection: string, field: string, costByte?: number): Promise<string | null>` — normalize the candidate, then mint at the requested `costByte` (default `CURRENT_COST_BYTE`). Returns the base64 33-byte target tag to string-compare against a stored `_bidx` value, **or `null`** when `iterationsForCostByte(costByte) === null` (an unknown/legacy discriminator → cheap non-match, **no PBKDF2 attempted at a wrong tier**).
  - The discriminator-scan contract (documented in the module + pinned by the Oracle #4 vector): a caller scanning tags reads each stored tag's leading byte; `findByDigest` (Task 13) derives the target **once per distinct discriminator present**, at step 2, never per-record.

- [ ] **Step 1: Write the failing test**

```ts
// packages/hub/__tests__/classified/bidx-target.test.ts
import { describe, it, expect } from 'vitest'
import { generateDEK } from '../../src/kernel/enclave/index.js'
import { normalizeForVerify } from '../../src/kernel/enclave/classify/normalize.js'
import { mintBidxTag, CURRENT_COST_BYTE } from '../../src/kernel/enclave/classify/bidx.js'
import { computeBidxTarget } from '../../src/kernel/enclave/classify/find.js'

describe('computeBidxTarget', () => {
  it('target for the right candidate equals the minted tag (round-trip)', async () => {
    const dek = await generateDEK()
    const tag = await mintBidxTag(normalizeForVerify('password', 'hunter2-hunter2'), dek, 'users', 'password')
    const hit = await computeBidxTarget('hunter2-hunter2', 'password', dek, 'users', 'password')
    const miss = await computeBidxTarget('wrong-password!', 'password', dek, 'users', 'password')
    expect(hit).toBe(tag)
    expect(miss).not.toBe(tag)
  }, 30_000)

  it('normalization-equivalence: casefold/whitespace variants → the same target', async () => {
    const dek = await generateDEK()
    const tag = await mintBidxTag(normalizeForVerify('secret-answer', 'Fluffy The Cat'), dek, 'u', 'a')
    expect(await computeBidxTarget('  fluffy   the cat ', 'secret-answer', dek, 'u', 'a')).toBe(tag)
  }, 30_000)

  it('Oracle #4: an unknown/legacy discriminator returns null (no wrong-tier PBKDF2)', async () => {
    const dek = await generateDEK()
    expect(await computeBidxTarget('x', 'password', dek, 'u', 'a', 0x7f)).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails** — RED (`Cannot find module .../classify/find.js`).

- [ ] **Step 3: Write the implementation** — `find.ts`: guard `iterationsForCostByte(costByte ?? CURRENT_COST_BYTE)`; if `null` return `null`; else `normalizeForVerify(normalize, candidate)` → mint via the same composition as `mintBidxTag` but at the requested `costByte` (extract a shared `mintAt(normalized, dek, collection, field, costByte)` helper in `bidx.ts` if cleaner — keep `mintBidxTag` as `mintAt(..., CURRENT_COST_BYTE)`; do NOT duplicate the crypto). Document that legacy tags of a known-but-older tier are still matchable by deriving the target at THAT tier (future-proofing hook; v1-only today).

- [ ] **Step 4: Run test to verify it passes** — PASS. `pnpm check:architecture` clean.

- [ ] **Step 5: Commit**

```bash
git add packages/hub/src/kernel/enclave/classify/find.ts packages/hub/__tests__/classified/bidx-target.test.ts
git commit -m "feat(classified): computeBidxTarget query-side derivation (discriminator-aware, Oracle #4)"
```

**Dependencies:** Task 1.

---

### Task 3: Layer A — enclave barrel +4 exports + enclave-surface golden  ⚠ golden

**Files:**
- Modify: `packages/hub/src/kernel/enclave/index.ts` (extend the `─── classify ───` section)
- Modify: `packages/hub/__tests__/enclave-surface.golden.json` (**frozen golden — additive update in this task**)
- Test: existing `packages/hub/__tests__/enclave-surface-golden.test.ts`

**Interfaces:**
- Produces (the ADDITIVE Contract v1 barrel delta, spec §1): `deriveClassifyIndexKey`, `deriveClassifyIndexSalt`, `mintBidxTag`, `computeBidxTarget` importable from `kernel/enclave/index.js`. (The discriminator helpers stay module-local; only these 4 are fork-contract primitives — `computeBidxTarget` is on the barrel because the conformance kit exercises it in Task 16.)

- [ ] **Step 1: Write the failing test (golden expectation first)** — edit `enclave-surface.golden.json`: insert `"computeBidxTarget"`, `"deriveClassifyIndexKey"`, `"deriveClassifyIndexSalt"`, `"mintBidxTag"` into the `"values"` array in its existing alphabetical position (confirm exact sort against the test's diff output).

- [ ] **Step 2: Run test to verify it fails** — `pnpm vitest run packages/hub/__tests__/enclave-surface-golden.test.ts` → FAIL (golden lists 4 exports the barrel lacks).

- [ ] **Step 3: Add the barrel exports** — append to the existing classify section of `kernel/enclave/index.ts`:

```ts
// ─── classify (slice-2b equatable blind index) ──────────────────────
// ADDITIVE per Enclave Contract v1. A fork must provide these four; the
// findByDigest orchestration (collection.ts) sits behind the with-shape
// dynamic-import seam and is not part of the fork contract.
export { deriveClassifyIndexKey, deriveClassifyIndexSalt, mintBidxTag } from './classify/bidx.js'
export { computeBidxTarget } from './classify/find.js'
```

- [ ] **Step 4: Run test to verify it passes** — golden test PASS; `pnpm check:architecture` clean.

- [ ] **Step 5: Commit**

```bash
git add packages/hub/src/kernel/enclave/index.ts packages/hub/__tests__/enclave-surface.golden.json
git commit -m "feat(classified): enclave barrel +4 classify-index primitives (Contract v1 additive)"
```

**Dependencies:** Tasks 1, 2. **Golden:** enclave-surface (additive).

---

### Task 4: Layer B — spine: `_bidx` envelope slot + `equatable` policy + `x-classified` marker type

**Files:**
- Modify: `packages/hub/src/kernel/types.ts` (`_bidx` on `EncryptedEnvelope`; `equatable` on `VdigFieldPolicy`; the `ClassifiedMarker` shape)
- Test: `packages/hub/__tests__/classified/slice2b-spine.test.ts`

**Interfaces:**

```ts
// kernel/types.ts — on EncryptedEnvelope, directly after the _vdig member:
/**
 * Equatable blind-index tags (classified slice 2b). Map of digest-only field
 * name → base64 33-byte tag (1-byte cost/version discriminator ‖ 32-byte keyed
 * MAC), CURRENT VALUE ONLY (the _vdig ring is never indexed). This is the ONLY
 * store-visible classified artifact: a keyed MAC, comparable without a key
 * ceremony, with NO inline cryptographic integrity by construction. Invariant:
 * _bidx[field] present ⇒ _vdig[field] present. Confirm-by-verify (findByDigest)
 * makes any read-side orphan/splice unreturnable.
 */
readonly _bidx?: Record<string, string>
```

```ts
// VdigFieldPolicy gains (spec §4):
readonly equatable: boolean   // default false — refused unless the double door is open (R8)
```

```ts
// The persisted config marker (C-A / R10). Reuse the stage-2 persisted-schema
// record; this is the shape of the classified-fields marker stored there.
export interface ClassifiedMarker {
  /** field names declared digest-only (have _vdig); non-empty ⇒ writes need the classified codec */
  readonly digestOnly: readonly string[]
  /** field names additionally declared equatable (have _bidx when covered) */
  readonly equatable: readonly string[]
}
```

- [ ] **Step 1: Write the failing test**

```ts
// packages/hub/__tests__/classified/slice2b-spine.test.ts
import { describe, it, expect } from 'vitest'
import type { EncryptedEnvelope, VdigFieldPolicy, ClassifiedMarker } from '../../src/kernel/types.js'

describe('slice-2b spine', () => {
  it('EncryptedEnvelope accepts a _bidx tag map beside _vdig', () => {
    const env: EncryptedEnvelope = {
      _noydb: 1, _v: 1, _ts: 't', _iv: 'i', _data: 'd',
      _vdig: { password: 'iv:data' }, _bidx: { password: 'AbCd...==' },
    }
    expect(env._bidx?.password).toBeTypeOf('string')
  })
  it('VdigFieldPolicy gains equatable; ClassifiedMarker shape typechecks', () => {
    const p: VdigFieldPolicy = { normalize: 'password', notLastN: 0, equatable: true }
    const m: ClassifiedMarker = { digestOnly: ['password'], equatable: ['password'] }
    expect(p.equatable && m.equatable.length).toBe(1)
  })
})
```

- [ ] **Step 2: Run to verify RED** — `_bidx` unknown on `EncryptedEnvelope`, `equatable` missing on `VdigFieldPolicy`, `ClassifiedMarker` unexported.

- [ ] **Step 3: Implement** — the three type edits above.

- [ ] **Step 4: Verify GREEN** — `pnpm vitest run packages/hub/__tests__/classified/slice2b-spine.test.ts && pnpm --filter @noy-db/hub typecheck` (stage-2 suite still green; `equatable` is a new REQUIRED field on `VdigFieldPolicy` — every construction site in `collection-config.ts` must set it, wired in Task 10; until then the typecheck flags them, which is expected and fixed there. If sequencing pain, default `equatable: false` at the single build site now and let Task 10 thread the real value).

- [ ] **Step 5: Commit**

```bash
git add packages/hub/src/kernel/types.ts packages/hub/__tests__/classified/slice2b-spine.test.ts
git commit -m "feat(classified): _bidx envelope slot + equatable policy flag + ClassifiedMarker shape"
```

**Dependencies:** none (spine). **Note:** to avoid a broken typecheck between Task 4 and Task 10, set `equatable: false` at the lone `vdigFields` build site in `collection-config.ts` in this task; Task 10 replaces the literal with the resolved value.

---

### Task 5: Layer B — codec write path: `_bidx` monotonic-carry / rotate / clear / error branches

**Files:**
- Modify: `packages/hub/src/kernel/enclave/record-keys/record-codec.ts` (extend the C6 `_vdig` block at record-codec.ts:246-288 per equatable field; `_bidx` output map)
- Test: `packages/hub/__tests__/classified/codec-bidx-write.test.ts`

**Interfaces:**
- Consumes: Task 1 (`mintBidxTag`), the codec's existing `mintVdigSlot` path (which already computes `normalized` once inside the enclave — reuse it, never re-normalize), Task 4 (`_bidx`, `VdigFieldPolicy.equatable`).
- Produces, per digest-only field with `policy.equatable === true`, **exactly one of four branches** mirroring the `_vdig` C6 block (§2 write path):
  1. **Field ABSENT → monotonic carry:** copy `prev._bidx?.[field]` **verbatim** whenever `prev._vdig[field]` is being carried — **regardless of `policy.equatable` of the writing handle** (I-3). If the spec is equatable but `prev._bidx[field]` is missing → nothing to mint (no plaintext) → stays uncovered.
  2. **Field present with a string → rotate:** feed the **same `normalized`** already computed for `mintVdigSlot` into `mintBidxTag`; new tag replaces old. **Branch-2 knob disposition (plan decision — see §Implementation choices):** mint the fresh tag **only when `policy.equatable === true`**; if the field is present-and-changing but `policy.equatable === false` (knob removed on this handle), **drop the stale `_bidx[field]`** (it points at the now-superseded value; carrying it verbatim would be wrong, minting is disallowed). This is explicit-value-change retirement, consistent with I-3 (which governs the ABSENT branch only); confirm-by-verify keeps it sound either way.
  3. **Field explicitly `null` → clear:** drop `_bidx[field]` together with `_vdig[field]`.
  4. **Any other type → `ValidationError`** (shared branch with `_vdig`, unchanged).
- Emit `_bidx` on the envelope **only when the map is non-empty** (mirror the `vdigOut ? {...} : {}` spread at record-codec.ts:288). Enforce `_bidx ⇒ _vdig` structurally (a tag is only ever written in the same iteration that writes/carries the `_vdig` slot).

- [ ] **Step 1: Write the failing test** (drives the codec directly; collection plumbing is later). Uses real 600K PBKDF2 only where a tag is asserted (~1-2 s each).

```ts
// packages/hub/__tests__/classified/codec-bidx-write.test.ts
import { describe, it, expect } from 'vitest'
import { RecordCodec, generateDEK } from '../../src/kernel/enclave/index.js'
import { computeBidxTarget } from '../../src/kernel/enclave/classify/find.js'
import { NO_CRDT } from '../../src/kernel/collection-config.js'
import type { VdigFieldPolicy } from '../../src/kernel/types.js'
import { ValidationError } from '../../src/kernel/errors.js'
// makeCodec: mirror codec-vdig-write.test.ts's helper (Task 7 stage-2), passing vdigFields.

const eq: VdigFieldPolicy = { normalize: 'password', notLastN: 0, equatable: true }
const noEq: VdigFieldPolicy = { normalize: 'password', notLastN: 0, equatable: false }

describe('encryptRecord _bidx branches (C6 mirror)', () => {
  it('rotate: string value → _bidx tag present AND matches computeBidxTarget; _bidx ⇒ _vdig', async () => {
    const { codec, dek } = await makeCodec(new Map([['password', eq]]))
    const cek = await generateDEK()
    const env = await codec.encryptRecord({ password: 'hunter2-hunter2' }, 1, cek, undefined, undefined, { id: 'r1', prev: null })
    expect(env._vdig?.password).toBeDefined()
    expect(env._bidx?.password).toBeDefined()             // invariant _bidx ⇒ _vdig
    const target = await computeBidxTarget('hunter2-hunter2', 'password', dek, 'users', 'password')
    expect(env._bidx!.password).toBe(target)
  }, 30_000)

  it('monotonic carry: field absent → prev._bidx copied BYTE-VERBATIM, even from a non-equatable handle (I-3)', async () => {
    const { codec } = await makeCodec(new Map([['password', eq]]))
    const cek = await generateDEK()
    const v1 = await codec.encryptRecord({ password: 'hunter2-hunter2', name: 'A' }, 1, cek, undefined, undefined, { id: 'r1', prev: null })
    // a later write by a handle with equatable OFF, field absent → tag preserved
    const { codec: codecNoEq } = await makeCodec(new Map([['password', noEq]]))
    const v2 = await codecNoEq.encryptRecord({ name: 'B' }, 2, cek, undefined, undefined, { id: 'r1', prev: v1 })
    expect(v2._bidx?.password).toBe(v1._bidx?.password)   // verbatim, not scrubbed
  }, 30_000)

  it('branch-2 non-equatable rotate: field present, knob OFF → stale tag DROPPED (plan decision)', async () => {
    const { codec } = await makeCodec(new Map([['password', eq]]))
    const cek = await generateDEK()
    const v1 = await codec.encryptRecord({ password: 'old-secret-1234' }, 1, cek, undefined, undefined, { id: 'r1', prev: null })
    const { codec: codecNoEq } = await makeCodec(new Map([['password', noEq]]))
    const v2 = await codecNoEq.encryptRecord({ password: 'new-secret-5678' }, 2, cek, undefined, undefined, { id: 'r1', prev: v1 })
    expect(v2._vdig?.password).toBeDefined()              // digest rotates as usual
    expect(v2._bidx?.password).toBeUndefined()            // no mint (knob off), no stale carry
  }, 30_000)

  it('clear: field null → both _vdig and _bidx dropped', async () => {
    const { codec } = await makeCodec(new Map([['password', eq]]))
    const cek = await generateDEK()
    const v1 = await codec.encryptRecord({ password: 'hunter2-hunter2' }, 1, cek, undefined, undefined, { id: 'r1', prev: null })
    const v2 = await codec.encryptRecord({ password: null }, 2, cek, undefined, undefined, { id: 'r1', prev: v1 })
    expect(v2._vdig?.password).toBeUndefined()
    expect(v2._bidx?.password).toBeUndefined()
  }, 30_000)

  it('carry-forward byte-stability: unrelated put on an equatable handle leaves tag bytes unchanged', async () => {
    const { codec } = await makeCodec(new Map([['password', eq]]))
    const cek = await generateDEK()
    const v1 = await codec.encryptRecord({ password: 'hunter2-hunter2', name: 'A' }, 1, cek, undefined, undefined, { id: 'r1', prev: null })
    const v2 = await codec.encryptRecord({ name: 'B' }, 2, cek, undefined, undefined, { id: 'r1', prev: v1 })
    expect(v2._bidx?.password).toBe(v1._bidx?.password)
  }, 30_000)
})
```

- [ ] **Step 2: Run to verify RED** — no `_bidx` emitted yet.

- [ ] **Step 3: Implement** — inside the existing `for (const [field, policy] of this.ctx.vdigFields)` loop (record-codec.ts:246), after the `_vdig` slot is resolved, compute the `_bidx` disposition using the SAME `normalized`/`prevBlob`/present-ness the `_vdig` branch already decided, per the four branches above. Accumulate into a `bidxOut` map; spread onto the envelope at record-codec.ts:288 (`...(bidxOut && Object.keys(bidxOut).length ? { _bidx: bidxOut } : {})`). Do NOT re-normalize; do NOT emit a tag without its `_vdig` slot.

- [ ] **Step 4: Verify GREEN** — the file test passes; `pnpm --filter @noy-db/hub test -t "codec-bidx"`.

- [ ] **Step 5: Commit**

```bash
git add packages/hub/src/kernel/enclave/record-keys/record-codec.ts packages/hub/__tests__/classified/codec-bidx-write.test.ts
git commit -m "feat(classified): codec _bidx branches — monotonic carry / rotate / clear (C6 mirror, I-3)"
```

**Dependencies:** Tasks 1, 4.

---

### Task 6: Layer B — C-A / R10 config-drift guard + stage-2 `_vdig` back-port

**Files:**
- Modify: `packages/hub/src/with-shape/persisted-schemas/register.ts` (persist the `x-classified` marker on first classified write; reuse `persistSchemaIfNeeded`)
- Modify: `packages/hub/src/kernel/enclave/record-keys/record-codec.ts` (R10 throw for a `vdigFields === null` codec writing over a `_vdig`/`_bidx`-bearing `prev`, or when the persisted marker is set)
- Modify: `packages/hub/src/kernel/collection-config.ts` (thread the persisted-marker presence into the codec ctx so a naive handle can detect drift)
- Test: `packages/hub/__tests__/classified/config-drift-guard.test.ts`

**Interfaces:**
- The guard is symmetric to the existing `prev._sealed` R6 check at record-codec.ts:249. A codec with `vdigFields === null` (naive handle — opened `vault.collection('users')` **without** `classifiedFields`) on a `put` whose target `prev` carries `_vdig` **or** `_bidx`, OR whose collection's persisted `x-classified` marker is set, MUST throw `ClassifiedConfigError(collection, 'this collection has classified digest-only fields but this handle was opened without classifiedFields — refusing to write (would drop tags or serialize the secret as plaintext)')`. **R10.**
- **Back-port:** the identical hole exists for stage-2 `_vdig`-only collections on shipped `0.3.0-pre.3`. The `prev._vdig`-present arm of the guard closes it. **This ships with its OWN changeset** (hub patch, behavior-change migration note) — see Task 18.

- [ ] **Step 1: Write the failing test** — TWO regression vectors (the back-port needs its own):

```ts
// packages/hub/__tests__/classified/config-drift-guard.test.ts
import { describe, it, expect } from 'vitest'
import { createNoydb } from '../../src/index.js'
import { withClassified, classified } from '../../src/with-shape/classified/index.js'
import { inlineMemory } from './harness.js'
import { ClassifiedConfigError } from '../../src/kernel/errors.js'

describe('C-A / R10 config-drift guard', () => {
  it('_bidx path: a naive handle writing over an equatable record throws ClassifiedConfigError', async () => {
    const store = inlineMemory()
    const db = createNoydb({ store, /* strategies */ })
    const v = await db.openVault('v', /* keys */)
    const users = v.collection('users', {
      perRecordKeys: true, acknowledgeEquatableRisk: true,
      classifiedFields: { password: classified.password({ equatable: true }) },
    }, withClassified())
    await users.put('r1', { password: 'hunter2-hunter2', name: 'A' } as never)
    // second handle, SAME collection, no classifiedFields — the drift
    const naive = v.collection('users', { perRecordKeys: true } as never)
    await expect(naive.put('r1', { name: 'B' } as never)).rejects.toBeInstanceOf(ClassifiedConfigError)
  }, 30_000)

  it('stage-2 _vdig-only back-port: naive handle over a digest-only (non-equatable) record throws too', async () => {
    const store = inlineMemory()
    const db = createNoydb({ store, /* strategies */ })
    const v = await db.openVault('v', /* keys */)
    const users = v.collection('users', {
      perRecordKeys: true,
      classifiedFields: { password: classified.password() }, // digest-only, NOT equatable
    }, withClassified())
    await users.put('r1', { password: 'hunter2-hunter2' } as never)
    const naive = v.collection('users', { perRecordKeys: true } as never)
    await expect(naive.put('r1', { name: 'B' } as never)).rejects.toBeInstanceOf(ClassifiedConfigError)
  }, 30_000)
})
```

- [ ] **Step 2: Run to verify RED** — the naive handle currently writes silently (plaintext or tag-drop). Both vectors FAIL (no throw).

- [ ] **Step 3: Implement** — (a) on first classified write persist/extend the `x-classified` marker in the persisted-schema record (`ClassifiedMarker` shape from Task 4). (b) In `encryptRecord`, when `this.ctx.vdigFields === null` (or empty) and the write supplies a `prev` carrying `_vdig`/`_bidx`, or the ctx signals the persisted marker is present, throw `ClassifiedConfigError`. Thread a `readonly classifiedMarkerPresent: boolean` (or a lazy marker lookup) into `RecordCodecContext` from `collection-config.ts` so the naive codec has the cross-session signal even when `prev` is momentarily unavailable. Keep it symmetric to the record-codec.ts:249 `prev._sealed` check.

- [ ] **Step 4: Verify GREEN** — both vectors throw `ClassifiedConfigError`; stage-2 suite still green (a correctly-configured classified handle is unaffected).

- [ ] **Step 5: Commit**

```bash
git add packages/hub/src/with-shape/persisted-schemas/register.ts packages/hub/src/kernel/enclave/record-keys/record-codec.ts packages/hub/src/kernel/collection-config.ts packages/hub/__tests__/classified/config-drift-guard.test.ts
git commit -m "fix(classified): R10 config-drift guard — fail loud on naive-handle writes over _vdig/_bidx (C-A + stage-2 back-port)"
```

**Dependencies:** Task 5. **Governance note (Task 18):** this back-port ships as a **separate changeset** with a behavior-change migration note.

---

### Task 7: Layer B — `rotateRecordCek` / `revokeSealedRecord` verbatim `_bidx` carry (+ DEK-rotation forward requirement)

**Files:**
- Modify: `packages/hub/src/kernel/enclave/record-keys/sealing.ts` (`rotateRecordCek` rebuilt envelope carries `_bidx` verbatim, beside `_det`/`_tier` at sealing.ts:216-217)
- Test: `packages/hub/__tests__/classified/rotate-preserves-bidx.test.ts`

**Interfaces:**
- Produces: `rotateRecordCek` appends `...(live._bidx !== undefined ? { _bidx: live._bidx } : {})` to the rebuilt envelope (DEK-rooted tag is CEK-independent — carry, do not recompute; omitting the line replays the #306 Slice-A data-loss bug on the index). `revokeSealedRecord({ hard: true })` funnels through `rotateRecordCek` (sealing.ts:148) so it inherits the carry — pin it with its own vector.
- **DEK-rotation forward requirement (documented, NOT implemented here):** add a comment at the `rotateKeys` DEK-rotation path (`with-party/team/keyring.ts` ~keyring.ts:806-822) stating that a future perRecordKeys-aware DEK rotation MUST **drop `_bidx`** (stale tags under a dead key are unreturnable garbage that still leak the old partition) and MUST document that index coverage regrows only per-record on secret rotation. Also note the pre-existing **mixed-collection `rotateKeys` hazard** (D-5): bare records re-encrypted before the first `_cek` throw are left under an unsaved DEK — flagged, not fixed here.

- [ ] **Step 1: Write the failing test**

```ts
// packages/hub/__tests__/classified/rotate-preserves-bidx.test.ts
// End-to-end via the public surface (findByDigest is Task 13; here assert the
// envelope-level carry via store._dump, so this task stands alone).
import { describe, it, expect } from 'vitest'
// ... open a vault + equatable collection, put r1, capture _dump tag ...
describe('rotateRecordCek / revokeSealedRecord carry _bidx', () => {
  it('rotateRecordCek preserves the _bidx tag verbatim', async () => {
    // const before = store._dump('v','users','r1')!._bidx!.password
    // await vault.rotateRecordCek('users','r1')
    // const after = store._dump('v','users','r1')!._bidx!.password
    // expect(after).toBe(before)  // and _cek changed
  }, 30_000)
  it('revokeSealedRecord({hard:true}) preserves the _bidx tag verbatim', async () => {
    // same, via vault.revokeSealedRecord('users','r1',{hard:true})
  }, 30_000)
})
```

- [ ] **Step 2: Run to verify RED** — `after` is `undefined` (carry line missing) → assertion fails.

- [ ] **Step 3: Implement** — the one-line `_bidx` spread in `rotateRecordCek`'s rebuilt-envelope object (sealing.ts:~216); add the `rotateKeys` forward-requirement + D-5 caveat comment.

- [ ] **Step 4: Verify GREEN** — both vectors pass; `_cek` differs, `_bidx` identical.

- [ ] **Step 5: Commit**

```bash
git add packages/hub/src/kernel/enclave/record-keys/sealing.ts packages/hub/src/kernel/enclave/team/keyring.ts packages/hub/__tests__/classified/rotate-preserves-bidx.test.ts
git commit -m "feat(classified): rotateRecordCek/revokeSealedRecord carry _bidx verbatim; document DEK-rotation drop requirement"
```

**Dependencies:** Task 4 (uses `_bidx`); Task 5 (to mint a tag to carry).

---

### Task 8: Layer B — forget/tombstone `_bidx` drop + `classifySealedShred` third-category shape change  ⚠ golden (NON-additive)

**Files:**
- Modify: `packages/hub/src/kernel/enclave/record-keys/record-codec.ts` (`classifySealedShred` return shape — record-codec.ts:407-433)
- Modify any consumers of `classifySealedShred`'s return (grep) to the new shape
- Modify: the `classifySealedShred` golden/shape assertion (grep `packages/hub/__tests__` for its shape test)
- Test: `packages/hub/__tests__/classified/forget-bidx.test.ts`

**Interfaces:**
- **forget/tombstone:** `buildTombstone`/`tombstoneHistory` already drop all body slots incl. `_bidx` for free (verified in stage 2) — add a vector confirming the post-forget envelope carries no `_bidx` and `findByDigest` misses (the findByDigest half is asserted in Task 13; here assert the envelope via `_dump`).
- **`classifySealedShred` shape change (SM #4 — NON-additive golden).** The current `{ shreddable: string[]; dekResidue: string[] }` cannot express `_bidx`, which is BOTH live-shreddable (tombstone drops it) AND dekResidue-in-backups. Change the return to a per-slot shape (recommended): `{ readonly slots: readonly { readonly field: string; readonly class: 'shreddable' | 'dekResidue' | 'live-shreddable+dekResidue-in-backups' }[] }`, OR add a third array `bidxResidue: string[]`. Pick the per-slot shape (SM #4 wording); update every caller. A `_bidx` slot reports `class: 'live-shreddable+dekResidue-in-backups'`. **Flag this golden change as NON-additive in the commit and in Task 18's sweep.**

- [ ] **Step 1: Write the failing test**

```ts
// packages/hub/__tests__/classified/forget-bidx.test.ts
import { describe, it, expect } from 'vitest'
import { RecordCodec, generateDEK } from '../../src/kernel/enclave/index.js'
// ... build an envelope with _vdig + _bidx on a _cek body ...
describe('forget + classifySealedShred (_bidx)', () => {
  it('classifySealedShred reports the _bidx slot as live-shreddable+dekResidue-in-backups', async () => {
    // const report = await codec.classifySealedShred(live, sealedInfo)
    // expect(report.slots).toContainEqual({ field: 'password', class: 'live-shreddable+dekResidue-in-backups' })
  }, 30_000)
  it('tombstone drops _bidx from the live envelope', async () => {
    // build tombstone; expect result._bidx === undefined
  })
})
```

- [ ] **Step 2: Run to verify RED** — old two-bucket shape; `.slots` undefined.

- [ ] **Step 3: Implement** — rewrite `classifySealedShred` to the per-slot shape; when `live._bidx?.[field]` exists, emit `class: 'live-shreddable+dekResidue-in-backups'`; keep `_vdig`-only as `'shreddable'` and sealed dekResidue as `'dekResidue'`. Update callers + the shape golden.

- [ ] **Step 4: Verify GREEN** — file test + the updated shape golden; grep-verified callers compile.

- [ ] **Step 5: Commit**

```bash
git add packages/hub/src/kernel/enclave/record-keys/record-codec.ts packages/hub/__tests__/classified/forget-bidx.test.ts <golden + callers>
git commit -m "feat(classified)!: classifySealedShred per-slot shape reports _bidx third category; forget drops _bidx"
```

**Dependencies:** Task 4, Task 5. **Golden:** `classifySealedShred` shape (NON-additive — the sole breaking golden in this slice).

---

### Task 9: Layer B — ledger hash conditional widen for `_bidx`

**Files:**
- Modify: `packages/hub/src/kernel/enclave/record-keys/envelope-body.ts` (`envelopeBodyForHash` — fast-path guard at envelope-body.ts:112; `_bidx` segment appended LAST)
- Test: `packages/hub/__tests__/classified/bidx-ledger-hash.test.ts`

**Interfaces:**
- Extend the fast-path guard `env._sealed === undefined && env._vdig === undefined` → `&& env._bidx === undefined` (line 112) so a `_bidx`-absent envelope keeps its stage-2 byte-identical hash. Append the `_bidx` segment **LAST**, after the `_vdig` segment, so a legacy `_vdig`-only / `_bidx`-absent envelope hashes **byte-identically to its stage-2 value** (SM #5). Same conditional-widen law as stage 2 — bind only when present; no existing envelope carries `_bidx`, so no flag-day provided the widen ships in the same slice as the first writer (it does).

- [ ] **Step 1: Write the failing test**

```ts
// packages/hub/__tests__/classified/bidx-ledger-hash.test.ts
import { describe, it, expect } from 'vitest'
import { envelopeBodyForHash } from '../../src/kernel/enclave/record-keys/envelope-body.js'
import type { EncryptedEnvelope } from '../../src/kernel/types.js'

const base: EncryptedEnvelope = { _noydb: 1, _v: 1, _ts: 't', _iv: 'i', _data: 'd' }

describe('envelopeBodyForHash _bidx widen (SM #5)', () => {
  it('a _bidx-absent, _vdig-only envelope hashes BYTE-IDENTICALLY to its stage-2 value', () => {
    const vdigOnly: EncryptedEnvelope = { ...base, _vdig: { password: 'iv:data' } }
    // Snapshot the pre-widen string (record it as the stage-2 golden constant),
    // then assert the widened code still produces it.
    expect(envelopeBodyForHash(vdigOnly)).toBe(/* the exact stage-2 body string */ expect.any(String))
  })
  it('binds _bidx when present, appended after _vdig (order-stable)', () => {
    const withBidx: EncryptedEnvelope = { ...base, _vdig: { password: 'iv:data' }, _bidx: { password: 'AbCd==' } }
    const s = envelopeBodyForHash(withBidx)
    expect(s.indexOf('_vdig')).toBeLessThan(s.indexOf('_bidx')) // _bidx segment LAST
  })
  it('a bare envelope (no _sealed/_vdig/_bidx) still fast-paths to _data alone', () => {
    expect(envelopeBodyForHash(base)).toBe('d')
  })
})
```

(Capture the exact stage-2 body string for the `_vdig`-only case from the pre-change build and assert equality — this is the byte-identical vector.)

- [ ] **Step 2: Run to verify RED** — the `_bidx`-present case has no segment / wrong order; write the byte-identical assertion first against the current output to lock it.

- [ ] **Step 3: Implement** — the guard extension + the trailing `_bidx` segment (deterministic key order, same serialization style as the `_vdig` segment).

- [ ] **Step 4: Verify GREEN** — all three; and run the existing ledger/integrity suite to confirm no stage-2 hash drift.

- [ ] **Step 5: Commit**

```bash
git add packages/hub/src/kernel/enclave/record-keys/envelope-body.ts packages/hub/__tests__/classified/bidx-ledger-hash.test.ts
git commit -m "feat(classified): ledger hash conditional widen for _bidx (segment last, stage-2 byte-identical)"
```

**Dependencies:** Task 4.

---

### Task 10: Layer C — surface: `equatable` knob + `acknowledgeEquatableRisk` door + R7/R8 + describe/json-schema  ⚠ goldens

**Files:**
- Modify: `packages/hub/src/with-shape/classified/descriptor.ts` (`equatable?: true` on `ClassifiedFieldSpec`)
- Modify: `packages/hub/src/with-shape/classified/presets.ts` (`password()` / `secretAnswer()` pass `equatable` through)
- Modify: `packages/hub/src/with-shape/classified/guards.ts` (R7, R8 — both doors; `ClassifiedGuardCtx` gains `acknowledgeEquatableRisk`)
- Modify: `packages/hub/src/kernel/collection-config.ts` (accept `acknowledgeEquatableRisk`; thread the real `equatable` into `vdigFields` policy build, replacing the Task-4 placeholder; pass the flag into `classifiedGuardCtx` at collection-config.ts:525)
- Modify: `packages/hub/src/with-shape/introspection/json-schema.ts` (json-schema.ts:44 — emit `x-classified.equatable`); `describe()` path in `collection.ts`
- Test: `packages/hub/__tests__/classified/equatable-surface.test.ts`

**Interfaces:**
- `ClassifiedFieldSpec` gains `readonly equatable?: true`; `VdigFieldPolicy.equatable` (Task 4) is fed from it. Default absent/false → **refused by default**.
- **Double door (R8)** mirroring `deterministicFields × acknowledgeDeterministicRisk`: field-level `equatable: true` + collection-level `acknowledgeEquatableRisk: true`. Either alone → `ClassifiedConfigError` (R8). `acknowledgeEquatableRisk: true` with zero equatable members is a **silent no-op** (R8 one-directional — det precedent, Oracle #8). Coverage resolved by `_applyClassifiedFields` **first-wins** (per-process, not per-handle).
- **R7:** `equatable: true` on a spec whose `storage !== 'digest-only'` → `ClassifiedConfigError` (equatable is a digest-only knob; recoverable equality is `_det`'s job). Enforced at both doors via `guardClassifiedCompat`.
- `describe()` / `toJSONSchema()`: `x-classified` emission gains `equatable: true` (additive metadata). **Boundary note (Oracle #6):** `describe()` needs no `withClassified()` and `toJSONSchema()` emits `x-classified` ungated, so `equatable: true` advertises beyond the DEK-consent boundary. This is **intended** (structural property a schema consumer legitimately needs; discloses only *that* the field is equatable). Add a code comment + docs note: a deployment that wants it gated can gate `x-classified.equatable` behind the same door as value-bearing metadata (default-emit).
- **Mandated docs language** on both preset knobs (Crypto #1 + M-2 candor) — the honest GPU/ASIC cost band from spec §4 (see Task 18 for the verbatim text; the JSDoc on `password`/`secretAnswer` `equatable` links to it).

- [ ] **Step 1: Write the failing test**

```ts
// packages/hub/__tests__/classified/equatable-surface.test.ts
import { describe, it, expect } from 'vitest'
import { classified } from '../../src/with-shape/classified/index.js'
import { ClassifiedConfigError } from '../../src/kernel/errors.js'
// helper openEquatable(specs, { ack }) opens a vault+collection

describe('equatable double door + R7/R8', () => {
  it('R8: equatable field without acknowledgeEquatableRisk → ClassifiedConfigError', async () => {
    await expect(openEquatable(
      { password: classified.password({ equatable: true }) }, { ack: false },
    )).rejects.toBeInstanceOf(ClassifiedConfigError)
  })
  it('R8: acknowledge with zero equatable members is a silent no-op', async () => {
    await expect(openEquatable(
      { password: classified.password() }, { ack: true },
    )).resolves.toBeDefined()
  })
  it('R7: equatable on a non-digest-only field → ClassifiedConfigError', async () => {
    await expect(openEquatable(
      { note: classified.recoverable({ equatable: true } as never) }, { ack: true },
    )).rejects.toBeInstanceOf(ClassifiedConfigError)
  })
  it('describe()/toJSONSchema emit x-classified.equatable (ungated, boundary-noted)', async () => {
    const col = await openEquatable({ password: classified.password({ equatable: true }) }, { ack: true })
    const d = await col.describe()
    expect(d.fields.find(f => f.name === 'password')?.classified?.equatable).toBe(true)
    // toJSONSchema likewise
  })
})
```

- [ ] **Step 2: Run to verify RED** — `equatable` unknown on the preset options; no R7/R8; no `x-classified.equatable`.

- [ ] **Step 3: Implement** — the descriptor/preset passthrough; R7/R8 in `guards.ts` + `ClassifiedGuardCtx.acknowledgeEquatableRisk`; thread the resolved `equatable` into the `vdigFields` build (replace the Task-4 `false` placeholder); `x-classified.equatable` in `json-schema.ts:44` + the `describe()` mapper. Update any with-surface/describe golden the emission trips (flag in-task).

- [ ] **Step 4: Verify GREEN** — file test + affected goldens; `pnpm --filter @noy-db/hub typecheck` (the Task-4 placeholder is now gone).

- [ ] **Step 5: Commit**

```bash
git add packages/hub/src/with-shape/classified/descriptor.ts packages/hub/src/with-shape/classified/presets.ts packages/hub/src/with-shape/classified/guards.ts packages/hub/src/kernel/collection-config.ts packages/hub/src/with-shape/introspection/json-schema.ts packages/hub/src/kernel/collection.ts packages/hub/__tests__/classified/equatable-surface.test.ts <goldens>
git commit -m "feat(classified): equatable knob + acknowledgeEquatableRisk door (R7/R8) + x-classified.equatable emission"
```

**Dependencies:** Task 4. **Goldens:** with-surface/describe (additive) if tripped; kernel-surface ceiling `collection-config.ts` if tripped.

---

### Task 11: Layer C — `'find'` consent op: three union-widening sites + `'*'`-non-collision golden  ⚠ goldens

**Files:**
- Modify: `packages/hub/src/with-audit/consent/consent.ts` (`ConsentOp` union — consent.ts:77)
- Modify: `packages/hub/src/kernel/collection-config.ts` (`onAccess` union — collection-config.ts:307)
- Modify: `packages/hub/src/with-shape/classified/strategy.ts` (classified ctx `onAccess` type — strategy.ts:30)
- Modify/verify: the kernel-api golden that snapshots the `ConsentOp`/`onAccess` union + a NEW `'*'`-non-collision golden
- Test: `packages/hub/__tests__/classified/find-consent-op.test.ts`

**Interfaces:**
- **Union-widening checklist (I-2 — all three widen together or a downstream exhaustive switch breaks at its next in-range minor):**
  1. `ConsentOp` at `consent.ts:77` → `'get' | 'put' | 'delete' | 'reveal' | 'verify' | 'find'` (public, re-exported; klum-db + ui have exhaustive switches).
  2. `onAccess` on `collection-config.ts:307` → add `'find'`.
  3. classified ctx `onAccess` on `strategy.ts:30` → widen to include `'find'` (the ctx used by `findByDigest`; the existing `'verify'`-only type becomes `'verify' | 'find'`).
- **`'*'` sentinel:** `findByDigest` emits `onAccess('find', '*')` (Task 13). `'*'` is a NEW consent-recordId sentinel ("no single record" / sweep marker) — the cited `verifyGroup`/`matchGroup` precedent used `'*'` only as an *error* id, never a consent op, so this is the first consent use. A golden asserts `'*'` **cannot collide with a real store id** (ULIDs/user ids never equal `'*'`).

- [ ] **Step 1: Write the failing test**

```ts
// packages/hub/__tests__/classified/find-consent-op.test.ts
import { describe, it, expect } from 'vitest'
import type { ConsentOp } from '../../src/with-audit/consent/consent.js'
import { isULID } from '../../src/kernel/id.js' // or whatever the id validator is

describe("'find' consent op + '*' sentinel", () => {
  it("'find' is assignable to ConsentOp", () => {
    const op: ConsentOp = 'find'
    expect(op).toBe('find')
  })
  it("the '*' sweep marker can never equal a real store id (ULID)", () => {
    expect(isULID('*')).toBe(false)
    // and a generated id is never '*'
  })
})
```

(The three-site widening is enforced by the kernel-api golden test + typecheck across the widened switches; add an explicit comment listing the three sites.)

- [ ] **Step 2: Run to verify RED** — `'find'` not assignable; `'*'` golden absent.

- [ ] **Step 3: Implement** — widen all three unions; add the `'*'`-non-collision golden; update the kernel-api golden snapshot of the union.

- [ ] **Step 4: Verify GREEN** — file test + goldens; `pnpm --filter @noy-db/hub typecheck` (downstream exhaustive switches inside hub still compile). NOTE: klum-db/ui switches are in sibling repos — record the `ConsentOp` additive widen in the changeset (Task 18) so those repos widen on adoption; it is additive so it does not break them until they add exhaustive handling.

- [ ] **Step 5: Commit**

```bash
git add packages/hub/src/with-audit/consent/consent.ts packages/hub/src/kernel/collection-config.ts packages/hub/src/with-shape/classified/strategy.ts packages/hub/__tests__/classified/find-consent-op.test.ts <goldens>
git commit -m "feat(classified): 'find' consent op — three union-widening sites + '*' sweep-marker non-collision golden"
```

**Dependencies:** none beyond Task 4 (parallel to Task 10). **Goldens:** kernel-api union snapshot + new `'*'`-non-collision golden.

---

### Task 12: Layer C — strategy `findByDigest` member + `NO_CLASSIFIED` stub + `active.ts` target-derivation seam

**Files:**
- Modify: `packages/hub/src/with-shape/classified/strategy.ts` (`ClassifiedStrategy` gains `findByDigest`; `NO_CLASSIFIED` throwing stub)
- Modify: `packages/hub/src/with-shape/classified/active.ts` (dynamic-import `computeBidxTarget`; expose the target-derivation the collection needs)
- Test: `packages/hub/__tests__/classified/find-strategy-seam.test.ts`

**Interfaces:**
- `ClassifiedStrategy` gains a member the collection calls to derive the target behind the dynamic-import seam, e.g. `computeTarget(ctx: ClassifiedVerifyCtx, field: string, candidate: string, costByte?: number): Promise<string | null>`. `active.ts`'s implementation does `const { computeBidxTarget } = await import('../../kernel/enclave/classify/find.js')` and calls it with the DEK + collection + field + `policyOf(ctx.spec).normalize`. (The confirm step in Task 13 reuses the stage-2 `verifyDigestField` INNER, also already dynamically imported by `active.ts` — no new import there.)
- `NO_CLASSIFIED` gains a `computeTarget` that throws `ClassifiedNotEnabledError` (mirrors the existing `verify`/`verifyText` stubs at strategy.ts:43-44).

- [ ] **Step 1: Write the failing test** — assert `NO_CLASSIFIED.computeTarget()` throws `ClassifiedNotEnabledError`; assert `withClassified()` returns a strategy exposing `computeTarget` that, given a ctx, produces the same tag as `mintBidxTag` for the matching candidate (end-to-end target parity, low-level).

- [ ] **Step 2: Run to verify RED** — member missing.

- [ ] **Step 3: Implement** — the strategy member + stub + `active.ts` seam.

- [ ] **Step 4: Verify GREEN** — file test; `pnpm check:architecture` (the enclave-classify-index-only ratchet lands in Task 15 — this task must route the identifier through the dynamic import, never a static import, so Task 15 passes clean).

- [ ] **Step 5: Commit**

```bash
git add packages/hub/src/with-shape/classified/strategy.ts packages/hub/src/with-shape/classified/active.ts packages/hub/__tests__/classified/find-strategy-seam.test.ts
git commit -m "feat(classified): findByDigest strategy seam — computeTarget via active.ts dynamic import + NO_CLASSIFIED stub"
```

**Dependencies:** Task 2, Task 10.

---

### Task 13: Layer C — `collection.findByDigest` algorithm + R9 + store-shape / empty / TOCTOU vectors  ⚠ kernel-api golden

**Files:**
- Modify: `packages/hub/src/kernel/collection.ts` (`findByDigest(field, candidate): Promise<readonly string[]>` + the exact algorithm; R9 runtime refusal)
- Modify: `packages/hub/__tests__/classified/harness.ts` (add `spyStore(inner)` — records the ordered `('list'|'get', args)` sequence)
- Modify: the kernel-api golden (`findByDigest` on `Collection`)
- Test: `packages/hub/__tests__/classified/find-by-digest.test.ts`

**Interfaces — the algorithm, EXACT ORDER (spec §3):**
1. **Caller-bug refusals, thrown at ~0 elapsed, pad-exempt:** field not declared classified / not `digest-only` / not `equatable` → `ClassifiedVerifyError` (**R9 — pinned to ONE indistinguishable message across all three sub-cases**, Oracle #6); candidate not a string → `ClassifiedVerifyError`; classified not enabled → `ClassifiedNotEnabledError` (the `NO_CLASSIFIED` stub).
2. `target = strategy.computeTarget(ctx, field, candidate)` — **structurally one full 600K PBKDF2, run UNCONDITIONALLY BEFORE the scan** (I-1). No `if (ids.length === 0) return []` may precede this. (For the discriminator: derive the target once per distinct `COST_BYTE` present among the scanned tags — v1-only today, so exactly one derivation; the multi-tier hook is Task 2's `costByte` param.)
3. **Scan:** `adapter.list` + one `adapter.get` per id; string-compare `env._bidx?.[field] === target` (**no envelope body decrypted during the scan**), **retaining each hit's already-fetched envelope**. No early return may precede step 2.
4. **Emit the single consent op now — after the scan, before confirm (Oracle #5):** `onAccess('find', '*')`, exactly once, fixing its store-write timestamp to a post-scan time independent of hit count.
5. **Confirm-by-verify on the ALREADY-FETCHED envelope (C-B):** for each tag-hit, run the stage-2 `verifyDigestField` **INNER** on the in-hand envelope (decrypt `_vdig[field]` under its AAD, PBKDF2 the candidate at the payload's own salt/iter, blinded compare). **MUST NOT** call `strategy.verify` (it re-fetches via `ctx.getEnvelope` + emits a per-id `'verify'` op — reintroduces the pushdown leak + TOCTOU). Collect the id iff `ok: true`; discard `mustRotate`. Tag-hits that fail confirmation are dropped silently (a splice is indistinguishable from a stale tag). Confirm emits **no** per-hit consent op. Return the confirmed ids (store enumeration order, unspecified).

- [ ] **Step 1: Write the failing test** — the audit-critical vectors:

```ts
// packages/hub/__tests__/classified/find-by-digest.test.ts
import { describe, it, expect } from 'vitest'
import { inlineMemory, spyStore } from './harness.js'
import { ClassifiedVerifyError } from '../../src/kernel/errors.js'
// openEquatable(store) → { vault, users } equatable collection over `store`

describe('findByDigest', () => {
  it('round-trip: hit returns the matching id; wrong candidate → []', async () => {
    // put r1 password X, r2 password Y
    // expect(await users.findByDigest('password', 'X-value')).toEqual(['r1'])
    // expect(await users.findByDigest('password', 'nope')).toEqual([])
  }, 60_000)

  it('R9: not-classified / not-digest-only / not-equatable all throw ONE indistinguishable message', async () => {
    // three calls, assert same error class + identical message string
  })

  it('C-B store-shape: exactly list + N get, ZERO extra gets regardless of hit count', async () => {
    const spy = spyStore(inlineMemory())
    // open over spy, put r1,r2,r3 all sharing the same password (3 hits)
    spy.calls.length = 0
    await users.findByDigest('password', 'shared-secret')
    const kinds = spy.calls.map(c => c.op)
    expect(kinds.filter(k => k === 'list')).toHaveLength(1)
    expect(kinds.filter(k => k === 'get')).toHaveLength(3) // == N, not N+hits
    expect(kinds).not.toContain('get-after-list-extra') // no second get burst
  }, 60_000)

  it('I-1 empty-collection: runs exactly one PBKDF2, no pre-target early return', async () => {
    // spy an empty collection; assert list happens AFTER a real target derivation.
    // Structural proxy: monkeypatch/spy computeTarget to record it was invoked
    // even with zero ids; assert order (target before list).
    // Also a coarse wall-time floor ~ one 600K PBKDF2.
  }, 60_000)

  it('C-B TOCTOU: a rotate interleaved between scan and confirm does not drop a scan-time match', async () => {
    // put r1; capture scan snapshot; rotate r1's secret concurrently;
    // assert the in-hand-envelope confirm still returns r1 (one snapshot).
  }, 60_000)

  it('splice: a tag copied A→B returns only A (confirm-by-verify rejects the forged B)', async () => {
    // put r1 (X), r2 (Y); manually copy r1._bidx.password onto r2 via store._dump mutation;
    // findByDigest('password','X') → ['r1'] only (B fails _vdig confirm)
  }, 60_000)

  it('ring-not-indexed: after a rotate, findByDigest(oldSecret) → []', async () => {
    // put r1 old; rotate to new; findByDigest(old) → []
  }, 60_000)
})
```

- [ ] **Step 2: Run to verify RED** — `findByDigest` absent.

- [ ] **Step 3: Implement** — `findByDigest` on `Collection` in the exact 5-step order; wire the R9 single-message refusal; call `strategy.computeTarget` (Task 12) then scan via the adapter, retaining hit envelopes; emit `onAccess('find','*')` once, before confirm; confirm via `verifyDigestField` INNER on the in-hand envelope. Add `spyStore` to `harness.ts`. Update the kernel-api golden (+`findByDigest`).

- [ ] **Step 4: Verify GREEN** — all vectors; kernel-api golden updated; `pnpm --filter @noy-db/hub test -t "findByDigest"`.

- [ ] **Step 5: Commit**

```bash
git add packages/hub/src/kernel/collection.ts packages/hub/__tests__/classified/harness.ts packages/hub/__tests__/classified/find-by-digest.test.ts <kernel-api golden>
git commit -m "feat(classified): collection.findByDigest — target-before-scan, in-hand confirm-by-verify (C-B/I-1/R9)"
```

**Dependencies:** Tasks 5, 10, 11, 12 + stage-2 `verifyDigestField` (present). **Goldens:** kernel-api (+`findByDigest`); kernel-surface ceiling `collection.ts`.

---

### Task 14: Layer C — `scrubEquatableTags(field)` maintenance sweep + monotonic-carry vector  ⚠ kernel-api golden

**Files:**
- Modify: `packages/hub/src/kernel/collection.ts` (`scrubEquatableTags(field): Promise<number>` — envelope-rewrite, no crypto)
- Modify: the kernel-api golden (+`scrubEquatableTags` on `Collection`)
- Test: `packages/hub/__tests__/classified/scrub-equatable.test.ts`

**Interfaces:**
- `scrubEquatableTags(field)` is the **sole lazy-write-independent drop-path** for a still-live record's tag (besides clear/`forget()`/DEK-rotation). It rewrites each envelope carrying `_bidx[field]`, dropping that slot (leaving `_vdig[field]` intact — the field stays `digest-only`, only index coverage is retired). No crypto — an envelope rewrite. Returns the count scrubbed. Emits no `'find'` op (it is a maintenance write, not a read-egress).
- **Monotonic-carry (I-3) vector** proves scrub is the ONLY retirement: Handle A (equatable) mints r1's tag → Handle B (equatable removed) does an unrelated `put` on r1 → Handle A's `findByDigest(r1-secret)` **still hits** (tag carried verbatim). Then `scrubEquatableTags('password')` → `findByDigest` misses.

- [ ] **Step 1: Write the failing test**

```ts
// packages/hub/__tests__/classified/scrub-equatable.test.ts
import { describe, it, expect } from 'vitest'
describe('scrubEquatableTags + monotonic carry (I-3)', () => {
  it('flip-flop: unrelated put by a non-equatable handle does NOT drop the tag', async () => {
    // A puts r1 (equatable); B (equatable off) puts unrelated field on r1;
    // A.findByDigest(secret) → ['r1']  (carried verbatim)
  }, 60_000)
  it('scrubEquatableTags(field) is the only lazy-independent drop-path', async () => {
    // continue: await col.scrubEquatableTags('password')  → returns 1
    // A.findByDigest(secret) → []   ;  and _vdig still present (verify still works)
  }, 60_000)
})
```

- [ ] **Step 2: Run to verify RED** — `scrubEquatableTags` absent; the flip-flop half already passes if Task 5's monotonic carry is correct (keep it as a regression pin).

- [ ] **Step 3: Implement** — `scrubEquatableTags` on `Collection` (list → for each record carrying `_bidx[field]`, rewrite the envelope without that slot via the normal put/codec path so the ledger hash re-widens correctly). Update the kernel-api golden.

- [ ] **Step 4: Verify GREEN** — both vectors; `_vdig` survives (verify still works).

- [ ] **Step 5: Commit**

```bash
git add packages/hub/src/kernel/collection.ts packages/hub/__tests__/classified/scrub-equatable.test.ts <kernel-api golden>
git commit -m "feat(classified): scrubEquatableTags maintenance sweep — sole live-record _bidx drop-path (I-3)"
```

**Dependencies:** Task 5 (monotonic carry), Task 13 (findByDigest to assert the miss). **Goldens:** kernel-api (+`scrubEquatableTags`); kernel-surface ceiling `collection.ts`.

---

### Task 15: Layer D — `enclave-classify-index-only` identifier ratchet extension  ⚠ check-architecture

**Files:**
- Modify: `scripts/check-architecture.mjs` (extend the stage-2 `enclave-classify-only` check — or add a sibling — with the slice-2b identifiers + literals)

**Interfaces:**
- Extend the enclave-body-only / enclave-classify-only ratchet (M1 identifier form): outside `kernel/enclave/**`, ban references to `deriveClassifyIndexKey`, `deriveClassifyIndexSalt`, `mintBidxTag`, `computeBidxTarget`, and the literals `'noydb-classify-index-v1'` / `'noydb-classify-index-salt-v1'` (conformance-kit + `*.test.ts` allowlisted). **Explicitly PERMITTED and NOT scanned:** opaque `_bidx` tag-map transit (codec carry-forward, `sealing.ts` verbatim carry, backup/history plumbing) — `_bidx` is deliberately NOT added to any body-field-access regex.

- [ ] **Step 1: Write the failing "test" (deliberate violation canary)**

```bash
cat > packages/hub/src/kernel/classify-index-violation-canary.ts << 'EOF'
// TEMP: enclave-classify-index-only negative canary — MUST be deleted in this task.
export const leak = 'noydb-classify-index-v1'
EOF
```

- [ ] **Step 2: Run to verify the check does NOT yet fail** — `pnpm check:architecture` PASSES (wrongly) — the identifiers aren't in the ratchet yet.

- [ ] **Step 3: Implement** — add the four identifiers + two literals to the classify-only regex (or a `CLASSIFY_INDEX_ENCLAVE_ONLY_RE`), wired into the runner beside the stage-2 check. Message mirrors the stage-2 one (route through the `active.ts` dynamic-import seam or the enclave barrel; opaque `_bidx` transit needs no crypto identifier).

- [ ] **Step 4: Verify RED-then-GREEN** — `pnpm check:architecture` FAILS on the canary; then `rm packages/hub/src/kernel/classify-index-violation-canary.ts && pnpm check:architecture` PASSES clean (proving `active.ts`'s dynamic imports + all transit sites are within the law).

- [ ] **Step 5: Commit**

```bash
git add scripts/check-architecture.mjs
git commit -m "chore(classified): enclave-classify-index-only ratchet — ban bidx identifiers/literals outside the enclave (M1)"
```

**Dependencies:** Task 3 (barrel) + Task 12 (the dynamic-import seam must exist so the check passes clean).

---

### Task 16: Layer D — enclave-conformance kit: classify-index vectors

**Files:**
- Modify: `test-harnesses/enclave-conformance/src/index.ts` (extend the classify group with the index primitives; `supports.classifyIndex` or reuse `supports.classify`)
- Modify: `test-harnesses/enclave-conformance/src/self-test.test.ts` (reference enclave declares support)

**Interfaces:**
- `EnclaveModule` gains `deriveClassifyIndexKey`, `deriveClassifyIndexSalt`, `mintBidxTag`, `computeBidxTarget`. Add vectors: tag round-trip (mint then `computeBidxTarget` for the right candidate equals the tag); per-field / per-collection separation (join-attack); Oracle #4 discriminator (unknown byte → `computeBidxTarget` returns `null`, no PBKDF2). Follow the existing optional-group `EnclaveNotSupportedError` refusal pattern.

- [ ] **Step 1: Write the failing vectors** — add to `runEnclaveConformance`'s classify describe block (mirror the stage-2 classify group structure).

```ts
    it('bidx tag: round-trip + per-field/collection separation', async () => {
      const dek = await enclave.generateDEK()
      const n = 'correct horse'
      const tag = await enclave.mintBidxTag(n, dek, 'users', 'password')
      expect(await enclave.computeBidxTarget('correct horse', 'password', dek, 'users', 'password')).toBe(tag)
      expect(await enclave.mintBidxTag(n, dek, 'users', 'pin')).not.toBe(tag)
      expect(await enclave.mintBidxTag(n, dek, 'admins', 'password')).not.toBe(tag)
    })
    it('Oracle #4: unknown discriminator → computeBidxTarget null', async () => {
      const dek = await enclave.generateDEK()
      expect(await enclave.computeBidxTarget('x', 'password', dek, 'u', 'a', 0x7f)).toBeNull()
    })
```

- [ ] **Step 2: Run to verify RED** — interface members missing.

- [ ] **Step 3: Complete** — interface members + support flag + self-test declaration + `conformance.test.ts` support option.

- [ ] **Step 4: Verify GREEN** — `pnpm --filter @noy-db/test-enclave-conformance test`.

- [ ] **Step 5: Commit**

```bash
git add test-harnesses/enclave-conformance/
git commit -m "test(classified): enclave-conformance classify-index vectors — tag round-trip, join separation, discriminator"
```

**Dependencies:** Task 3.

---

### Task 17: Layer D — bundle-gate canary for the find engine  ⚠ check-bundle

**Files:**
- Modify: `packages/hub/scripts/check-bundle.mjs` (extend the classified scenario `eagerImports` canary list)

**Interfaces:**
- Keep the find/target engine behind the `active.ts` dynamic-import seam (stage-1 negative-test methodology). Add `computeBidxTarget` (and, if reachable via the codec, `mintBidxTag`) to the classified scenario's `eagerImports` canary list — they MUST be ABSENT from the eager bundle.

- [ ] **Step 1: Make it RED (prove the canary detects a leak)** — temporarily add a static `import { computeBidxTarget as _leak } from '../../kernel/enclave/classify/find.js'; void _leak` to `active.ts`; add `'computeBidxTarget'` to the canary; `pnpm --filter @noy-db/hub build && pnpm --filter @noy-db/hub bundle-check` → FAIL.

- [ ] **Step 2: Remove the leak** — delete the temporary static import.

- [ ] **Step 3: Verify GREEN** — build + bundle-check PASS. NOTE: `mintBidxTag` reaches the bundle through `record-codec.ts` (statically imported by the kernel) exactly like stage-2 `mintVdigSlot` — if the canary fires on the base scenario, that is a REAL finding: gate the codec's `bidx.ts` import behind a lazy `await import('../classify/bidx.js')` inside the C6 `_bidx` branch (mirror the stage-2 write-side pattern), re-run Task 5's tests, keep the canary. Do NOT delete the canary.

- [ ] **Step 4: Commit**

```bash
git add packages/hub/scripts/check-bundle.mjs
git commit -m "chore(classified): bundle-gate canary for the findByDigest target engine"
```

**Dependencies:** Tasks 12, 13.

---

### Task 18: Layer D — docs + goldens sweep + TWO changesets + FULL cross-package gate + coverage audit + security-review handoff

**Files:**
- Modify: `SERVICES.md` (classified entry — no new service; extends `withClassified()`: description gains "equatable blind index (`_bidx`) + `findByDigest`"; adjust the LOC column)
- Modify: `features.yaml` — ONLY IF present on this branch (`ls features.yaml`); if present, extend the classified feature entry with `findByDigest`, `equatable`, `scrubEquatableTags` capabilities and run `pnpm validate:features`
- Modify: preset JSDoc / `docs/subsystems/classified.md` — the mandated docs language (honest GPU/ASIC cost band)
- Create: `.changeset/*.md` × 2 (author LOCALLY — `.changeset/` is gitignored in this repo family; **do NOT commit them**; they exist for the release author)

**The mandated preset docs language (verbatim, spec §4 — on both `password`/`secretAnswer` `equatable` knobs + the subsystem doc):**
> "equal values produce equal store-visible tags: anyone with store access learns which records share this secret and how many share each value — never the value itself. A collection-DEK holder can additionally test candidate values offline: the tag's inner digest is PBKDF2-SHA256 (600K), which is GPU/ASIC-friendly — an offline attacker runs on the order of 10⁴–10⁸ guesses/second, so for low-entropy secrets (PINs, casefolded secret answers) offline recovery of the equality partition is seconds-to-hours, not years. `crypto.subtle` exposes no memory-hard KDF (no scrypt/argon2) and the family's no-crypto-deps law forbids adding one, so PBKDF2-SHA256 is the hardest primitive available; the iteration count raises the price but does not make a low-entropy field safe. The real control for low-entropy fields is the DOOR — do not enable `equatable` for them unless the partition being learnable is acceptable — not the iteration count. Pre-forget backups retain tags."

**The TWO changesets (spec owner-decision #3 + governance):**
1. **Feature — hub minor:** the slice-2b equatable blind index (`_bidx`, `findByDigest`, `scrubEquatableTags`, `equatable` knob + `acknowledgeEquatableRisk` door). Note the ONE non-additive golden: `classifySealedShred` per-slot return shape (Task 8).
2. **Back-port — hub patch, behavior-change migration note:** the C-A / R10 config-drift guard (Task 6) closes the identical naive-handle plaintext-leak / silent-drop hole on shipped stage-2 `_vdig`-only collections. Migration note: *"a previously-silent write from a handle lacking `classifiedFields` over a classified collection now throws `ClassifiedConfigError` — fail-loud is the point."*

- [ ] **Step 1: Docs** — SERVICES.md + features.yaml (if present) + the mandated preset language + the subsystem `docs/subsystems/classified.md` slice-2b section (equatable blind index, the three deltas over `_vdig` — key-less partition / fixed-salt amortization / backup survival; the `'*'` sweep marker; the honest cost band; `scrubEquatableTags`; DEK-rotation drops tags; pre-prune backup/pod = full partition timeline; low-entropy enumeration math — the door is the control).

- [ ] **Step 2: The full gate (hub API changed ⇒ whole-repo suite)**

```bash
pnpm build && pnpm test && pnpm lint && pnpm typecheck && pnpm check:architecture && pnpm --filter @noy-db/hub bundle-check && pnpm knip
```

Expected: green. Fix regressions in place; if a fix touches a frozen surface, its golden moves in the same commit.

- [ ] **Step 3: Coverage audit** — walk the checklist below; every row must point at a merged test. Any gap = add the missing test NOW.

- [ ] **Step 4: Author the two changesets locally (gitignored — do NOT `git add` them)**

- [ ] **Step 5: Commit the docs**

```bash
git add SERVICES.md features.yaml docs 2>/dev/null; git add -u
git commit -m "docs(classified): slice-2b equatable blind index + findByDigest — catalog + subsystem notes"
```

Then hand off to the spec's **final adversarial security-review gate** (§6 focus: C-A guard completeness, C-B store-shape parity [`list` + N `get`, in-hand confirm], I-3 monotonic-coverage soundness, honest GPU/ASIC cost band, tag version-byte scan logic) before any merge/PR.

**Dependencies:** all prior tasks.

---

## Coverage checklist — Refusal matrix + §6 conformance vectors → tasks

Every row names the task(s) whose test files contain the concrete assertion.

| Requirement | Task(s) / test file |
|---|---|
| **R7** `equatable` on non-`digest-only` refused (both doors) | 10 — `equatable-surface.test.ts` ("R7") |
| **R8** any `equatable` member ∧ no `acknowledgeEquatableRisk` refused; ack-with-zero-members no-op | 10 — `equatable-surface.test.ts` ("R8", "silent no-op") |
| **R9** `findByDigest` on a non-equatable / non-digest-only / not-classified field — ONE indistinguishable message | 13 — `find-by-digest.test.ts` ("R9 … one indistinguishable message") |
| **R10** naive-handle (`vdigFields===null`) write over `_vdig`/`_bidx` throws `ClassifiedConfigError` (C-A) | 6 — `config-drift-guard.test.ts` (both `_bidx` and stage-2 `_vdig` back-port vectors) |
| §6 round-trip put→findByDigest hit / wrong-candidate miss | 13 — `find-by-digest.test.ts` ("round-trip") |
| §6 per-field & per-collection tag separation (join-attack) | 1 — `bidx-tag-primitive.test.ts` ("join-attack"); 16 — kit vector |
| §6 normalization-equivalence (casefold → one tag; same pipeline as verify) | 2 — `bidx-target.test.ts` ("normalization-equivalence") |
| §6 carry-forward byte-stability (unrelated put: tag bytes unchanged) + ledger hash stable | 5 — `codec-bidx-write.test.ts` ("byte-stability"); 9 — `bidx-ledger-hash.test.ts` |
| §6 clear drops both slots | 5 — `codec-bidx-write.test.ts` ("clear") |
| §6 invariant `_bidx ⇒ _vdig` | 5 — `codec-bidx-write.test.ts` ("rotate … invariant") |
| §6 `rotateRecordCek` + `revokeSealedRecord({hard:true})` preserve hits | 7 — `rotate-preserves-bidx.test.ts`; 13 (end-to-end hit after rotate) |
| §6 splice: tag copied A→B returns only A | 13 — `find-by-digest.test.ts` ("splice") |
| §6 forget → no `_bidx`, findByDigest misses | 8 — `forget-bidx.test.ts` (envelope); 13 (miss) |
| §6 ring-not-indexed: post-rotate `findByDigest(oldSecret) → []` | 13 — `find-by-digest.test.ts` ("ring-not-indexed") |
| §6 **C-B store-shape**: exactly `list` + N `get`, zero extra gets | 13 — `find-by-digest.test.ts` ("C-B store-shape") |
| §6 **C-B TOCTOU**: interleaved rotate does not drop a scan-time match | 13 — `find-by-digest.test.ts` ("C-B TOCTOU") |
| §6 **I-1 empty-collection**: exactly one PBKDF2, no pre-target early return | 13 — `find-by-digest.test.ts` ("I-1 empty-collection") |
| §6 **I-3 monotonic carry** + `scrubEquatableTags` sole drop-path | 5 — `codec-bidx-write.test.ts` (monotonic); 14 — `scrub-equatable.test.ts` |
| §6 **SM #5 ledger segment order**: `_vdig`-only / `_bidx`-absent byte-identical to stage-2; `_bidx` last | 9 — `bidx-ledger-hash.test.ts` |
| §6 **Oracle #4 discriminator**: v1 tag round-trips; unknown discriminator cheap non-match | 1/2 — `bidx-*.test.ts`; 16 — kit vector |
| §6 **Oracle #5 consent ordering**: single `onAccess('find','*')` written before confirm | 13 — `find-by-digest.test.ts` (assert consent log order); 11 (`'*'` sentinel) |
| §6 **SM #4 shred shape**: `classifySealedShred` per-slot `_bidx` = `live-shreddable+dekResidue-in-backups` (NON-additive golden) | 8 — `forget-bidx.test.ts` + shape golden |
| Goldens — enclave barrel +4; kernel-api +`findByDigest`/+`scrubEquatableTags`/+`'find'` (three unions); `'*'`-non-collision; `classifySealedShred` shape CHANGE | 3, 13, 14, 11, 8 (each updated in-task, verified by its golden test) |
| Bundle gate — find engine behind the `active.ts` dynamic-import seam | 17 (negative test then green) |
| Ratchet (M1) — bidx identifier/literal ban + `_bidx` transit permission | 15 (negative canary RED → GREEN) |
| Two changesets — feature (hub minor) + C-A back-port (hub patch, migration note) | 18 (authored locally, gitignored) |

**Implementation choices the plan made where the spec left room (confirm before/after implementing):**

1. **Branch-2 (rotate under a since-removed `equatable` knob) tag disposition (spec §2 leaves this to the plan).** Chosen: on a rotate write (field present with a new string) **mint a fresh `_bidx` tag only when `policy.equatable === true`; otherwise DROP the stale tag** (do not carry it verbatim — it points at the superseded value — and do not mint — the knob is off). This does NOT conflict with the I-3 monotonic-carry guarantee, which governs the ABSENT branch only (unrelated puts must preserve coverage); a rotate is an explicit value change *on this field*, so retiring the now-invalid tag is consistent with "retirement is explicit." **Confirm-by-verify keeps it sound either way:** any tag that survives is always re-confirmed against the current `_vdig`, so neither a carried-stale tag nor a dropped tag can ever cause `findByDigest` to return a wrong id — dropping is simply the cleaner, non-leaking choice. (Task 5, third vector.)
2. **`classifySealedShred` shape:** chose the **per-slot `{ field, class }`** form (SM #4's first-named option) over a third parallel array — it composes better for future slot classes. NON-additive golden either way. (Task 8.)
3. **`scrubEquatableTags` return:** returns the **count scrubbed** (`Promise<number>`); the spec names the op but not the return. (Task 14.)
4. **Strategy seam member name:** `computeTarget(ctx, field, candidate, costByte?)` on `ClassifiedStrategy` (spec names `computeBidxTarget` only as the enclave primitive; the strategy needs a seam method — this is the plan's name). (Task 12.)
