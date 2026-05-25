# Extracted-Partition Wire Format — Implementation Plan (Plan 3a)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the `.noydb` wire format to carry an extracted, transfer-sealed partition — the `bundleKind` + `transferSeal` header fields (#203/#206) and the matching body-wrapper variant — with **no extraction logic yet**. Plan 3b (`extractPartition`) builds on these primitives.

**Architecture:** Two surfaces. (1) `NoydbBundleHeader` (`format.ts`) gains two optional fields validated against the minimum-disclosure allowlist, plus a cross-field invariant. (2) The bundle body gains an `ExtractedPartitionBody` sibling to the existing `AutoUnlockBody` (`bundle.ts`), discriminated by `header.bundleKind` rather than `header.autoUnlock`, with `build*`/`parse*` helpers. The transfer seal carries the destination **DEKs sealed directly under the transfer key** (no dest-KEK indirection — `#208` re-wraps the raw DEKs under the recipient's KEK at owner-creation). The two unlock paths are mutually exclusive: `autoUnlock` and `bundleKind: 'extracted-partition'` cannot coexist.

**Tech Stack:** TypeScript, Vitest, `@noy-db/hub` bundle subsystem (`format.ts`, `bundle.ts`).

---

## Epic context

**Plan 3a of the Transferable Partition Bundles epic** (spec: `docs/superpowers/specs/2026-05-24-transferable-partition-bundles-design.md`; Plans 1–2 — `walkClosure` + `describeExtraction` — in PR #225). The advisor review split the original "Plan 3" into format (this plan) and logic (3b) so the wire format — a stability surface — is reviewable on its own. This matches the Dim-14 v2 split (format/registry separate from execution).

**Design decisions pinned in this plan (resolve spec gaps):**

- **Seal DEKs directly, not a KEK.** The unowned bundle has no keyring, so the fresh per-collection DEKs are exported to raw bytes and sealed *as a set* under the minted 32-byte transfer key. No destination KEK is minted at extraction — it served only as an indirection layer with no security gain and an extra binding to design. `adoptPartition` (#207) unseals the DEK set; `createOwnerOnAdoptedPartition` (#208) wraps those raw DEKs under the recipient's KEK to build the first real keyring.
- **`autoUnlock` and `bundleKind: 'extracted-partition'` are mutually exclusive** (spec §12.3 flags `re-keyed-new-owner × unsealed-carried` as dangerous). An extracted partition's unlock path *is* the transfer seal; a parallel auto-passphrase would weaken the one-time-seal guarantee. Rejected with a typed error at validation.
- **`bundleKind` lives in the header** (pre-decryption cloud-lister hint); the body wrapper carries the partition-specific payload (sealed DEKs). The header `transferSeal` field is an *indicator* (`{ v, alg, sealId }`) — no payload — per the spec.

## File structure

- **Modify:** `packages/hub/src/bundle/format.ts` — `NoydbBundleHeader` fields, `ALLOWED_HEADER_KEYS`, `validateBundleHeader` (+ cross-field invariant), `encodeBundleHeader`.
- **Modify:** `packages/hub/src/bundle/bundle.ts` — `ExtractedPartitionBody` interface + `buildExtractedPartitionWrapper` + `parseExtractedPartitionBody`.
- **Create:** `packages/hub/__tests__/extracted-partition-format.test.ts` — header roundtrip/validation + body build/parse roundtrip + mutual-exclusion tests.

## Reference: current shapes (already in tree)

```ts
// format.ts — header (relevant existing fields)
interface NoydbBundleHeader {
  readonly formatVersion: number
  readonly handle: string
  readonly bodyBytes: number
  readonly bodySha256: string
  readonly publicEnvelope?: PublicEnvelope
  readonly autoUnlock?: 'unsealed' | 'sealed'   // #197
}
const ALLOWED_HEADER_KEYS = new Set(['formatVersion','handle','bodyBytes','bodySha256','publicEnvelope','autoUnlock'])

// bundle.ts — body wrapper (existing)
interface AutoUnlockBody {
  readonly _noydb_bundle_body: 1
  readonly dump: string
  readonly _autoUnlock: { kind:'unsealed'; perUser:... } | { kind:'sealed'; perUser:... }
}
```

`NOYDB_BUNDLE_FORMAT_VERSION` is **not** bumped (validator uses exact equality; bumping bricks existing bundles — see spec §3.1). New keys are optional ⇒ old bundles still read.

---

## Task 1: Header fields `bundleKind` + `transferSeal`

**Files:**
- Modify: `packages/hub/src/bundle/format.ts`
- Test: `packages/hub/__tests__/extracted-partition-format.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest'
import {
  encodeBundleHeader,
  decodeBundleHeader,
  validateBundleHeader,
  NOYDB_BUNDLE_FORMAT_VERSION,
  type NoydbBundleHeader,
} from '../src/bundle/format.js'

const base = {
  formatVersion: NOYDB_BUNDLE_FORMAT_VERSION,
  handle: '01ARZ3NDEKTSV4RRFFQ69G5FAV', // 26-char Crockford base32
  bodyBytes: 10,
  bodySha256: 'a'.repeat(64),
} satisfies Partial<NoydbBundleHeader>

describe('extracted-partition header fields', () => {
  it('round-trips a header carrying bundleKind + transferSeal indicator', () => {
    const header: NoydbBundleHeader = {
      ...base,
      bundleKind: 'extracted-partition',
      transferSeal: { v: 1, alg: 'aes-256-gcm-pre-shared', sealId: 'seal-abc' },
    }
    const decoded = decodeBundleHeader(encodeBundleHeader(header))
    expect(decoded.bundleKind).toBe('extracted-partition')
    expect(decoded.transferSeal).toEqual({ v: 1, alg: 'aes-256-gcm-pre-shared', sealId: 'seal-abc' })
  })

  it('accepts bundleKind: snapshot and a header with neither field (back-compat)', () => {
    expect(() => validateBundleHeader({ ...base, bundleKind: 'snapshot' })).not.toThrow()
    expect(() => validateBundleHeader({ ...base })).not.toThrow()
  })

  it('rejects an unknown bundleKind value', () => {
    expect(() => validateBundleHeader({ ...base, bundleKind: 'nope' })).toThrow(/bundleKind/)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/hub && pnpm vitest run __tests__/extracted-partition-format.test.ts -t "round-trips a header"`
Expected: FAIL — `bundleKind` rejected as a forbidden header key (not in the allowlist).

- [ ] **Step 3: Write minimal implementation**

In `format.ts`, add the two fields to the `NoydbBundleHeader` interface (after `autoUnlock`):

```ts
  /**
   * Bundle's role in the source → destination lifecycle (#203).
   *   - omitted / 'snapshot' (default): backup/copy of an existing vault.
   *   - 'extracted-partition': re-keyed projection awaiting adoption.
   */
  readonly bundleKind?: 'snapshot' | 'extracted-partition'
  /**
   * Transfer-seal INDICATOR (#206) — metadata only, no payload (the
   * sealed DEKs live in the body). Present iff
   * bundleKind === 'extracted-partition'.
   */
  readonly transferSeal?: {
    readonly v: 1
    readonly alg: 'aes-256-gcm-pre-shared'
    readonly sealId: string
  }
```

Add both keys to `ALLOWED_HEADER_KEYS`:

```ts
const ALLOWED_HEADER_KEYS: ReadonlySet<string> = new Set([
  'formatVersion',
  'handle',
  'bodyBytes',
  'bodySha256',
  'publicEnvelope',
  'autoUnlock',
  'bundleKind',
  'transferSeal',
])
```

In `validateBundleHeader`, add validation after the `autoUnlock` block:

```ts
  if (h['bundleKind'] !== undefined) {
    if (h['bundleKind'] !== 'snapshot' && h['bundleKind'] !== 'extracted-partition') {
      const got = typeof h['bundleKind'] === 'string' ? `"${h['bundleKind']}"` : typeof h['bundleKind']
      throw new Error(
        `.noydb bundle header.bundleKind must be 'snapshot' or 'extracted-partition' when present, got ${got}.`,
      )
    }
  }
  if (h['transferSeal'] !== undefined) {
    const ts = h['transferSeal']
    if (ts === null || typeof ts !== 'object' || Array.isArray(ts)) {
      throw new Error(`.noydb bundle header.transferSeal must be a JSON object when present, got ${typeof ts}.`)
    }
    const t = ts as Record<string, unknown>
    if (t['v'] !== 1) {
      throw new Error(`.noydb bundle header.transferSeal.v must be 1, got ${String(t['v'])}.`)
    }
    if (t['alg'] !== 'aes-256-gcm-pre-shared') {
      throw new Error(`.noydb bundle header.transferSeal.alg must be 'aes-256-gcm-pre-shared', got ${String(t['alg'])}.`)
    }
    if (typeof t['sealId'] !== 'string' || t['sealId'].length === 0) {
      throw new Error(`.noydb bundle header.transferSeal.sealId must be a non-empty string, got ${String(t['sealId'])}.`)
    }
  }
```

In `encodeBundleHeader`, add the conditional-spread fields to the serialized object (after the `autoUnlock` spread):

```ts
    ...(header.bundleKind !== undefined ? { bundleKind: header.bundleKind } : {}),
    ...(header.transferSeal !== undefined ? { transferSeal: header.transferSeal } : {}),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/hub && pnpm vitest run __tests__/extracted-partition-format.test.ts`
Expected: PASS (three tests).

- [ ] **Step 5: Commit**

```bash
git add packages/hub/src/bundle/format.ts packages/hub/__tests__/extracted-partition-format.test.ts
git commit -m "feat(hub): bundle header bundleKind + transferSeal indicator (#203/#206)"
```

---

## Task 2: Cross-field invariant — `transferSeal` ⇔ `extracted-partition`

**Files:**
- Modify: `packages/hub/src/bundle/format.ts`
- Test: `packages/hub/__tests__/extracted-partition-format.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
describe('bundleKind ⇔ transferSeal cross-field invariant', () => {
  it('rejects transferSeal without bundleKind: extracted-partition', () => {
    expect(() =>
      validateBundleHeader({ ...base, transferSeal: { v: 1, alg: 'aes-256-gcm-pre-shared', sealId: 's' } }),
    ).toThrow(/transferSeal.*extracted-partition/)
  })

  it('rejects bundleKind: extracted-partition without a transferSeal', () => {
    expect(() =>
      validateBundleHeader({ ...base, bundleKind: 'extracted-partition' }),
    ).toThrow(/extracted-partition.*transferSeal/)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/hub && pnpm vitest run __tests__/extracted-partition-format.test.ts -t "cross-field"`
Expected: FAIL — both currently validate without error (fields validated independently in Task 1).

- [ ] **Step 3: Write minimal implementation**

In `validateBundleHeader`, after the `transferSeal` block from Task 1, add:

```ts
  // Cross-field invariant: the seal indicator and the extracted-partition
  // kind imply each other. An extracted partition is unlocked via its
  // transfer seal; a seal without the kind is a malformed header.
  const isExtracted = h['bundleKind'] === 'extracted-partition'
  const hasSeal = h['transferSeal'] !== undefined
  if (hasSeal && !isExtracted) {
    throw new Error(
      `.noydb bundle header.transferSeal requires bundleKind === 'extracted-partition'.`,
    )
  }
  if (isExtracted && !hasSeal) {
    throw new Error(
      `.noydb bundle header with bundleKind === 'extracted-partition' must carry a transferSeal indicator.`,
    )
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/hub && pnpm vitest run __tests__/extracted-partition-format.test.ts`
Expected: PASS (five tests; the Task 1 round-trip still passes — it sets both fields together).

- [ ] **Step 5: Commit**

```bash
git add packages/hub/src/bundle/format.ts packages/hub/__tests__/extracted-partition-format.test.ts
git commit -m "feat(hub): enforce bundleKind ⇔ transferSeal header invariant (#206)"
```

---

## Task 3: `ExtractedPartitionBody` build + parse helpers

**Files:**
- Modify: `packages/hub/src/bundle/bundle.ts`
- Test: `packages/hub/__tests__/extracted-partition-format.test.ts`

- [ ] **Step 1: Write the failing test**

Add to the test file (new imports at top — these are NOT exported from the package root; import from the module under test, which means they must be exported from `bundle.ts`; Step 3 adds the exports):

```ts
import {
  buildExtractedPartitionWrapper,
  parseExtractedPartitionBody,
  type ExtractedPartitionBody,
} from '../src/bundle/bundle.js'

describe('ExtractedPartitionBody wrapper', () => {
  it('round-trips dump + sealed-DEK payload through build/parse', () => {
    const dumpJson = JSON.stringify({ _noydb_backup: 1, collections: {}, keyrings: {} })
    const seal = {
      v: 1 as const,
      alg: 'aes-256-gcm-pre-shared' as const,
      sealId: 'seal-xyz',
      payload: 'YmFzZTY0LXNlYWxlZC1kZWtz', // base64 placeholder ciphertext
    }

    const body: ExtractedPartitionBody = buildExtractedPartitionWrapper(dumpJson, seal)
    expect(body._noydb_bundle_body).toBe(1)
    expect(body.dump).toBe(dumpJson)
    expect(body._transferSeal).toEqual(seal)

    const parsed = parseExtractedPartitionBody(JSON.stringify(body))
    expect(parsed.dump).toBe(dumpJson)
    expect(parsed.seal).toEqual(seal)
  })

  it('parse rejects a body missing the _transferSeal blob', () => {
    const bad = JSON.stringify({ _noydb_bundle_body: 1, dump: '{}' })
    expect(() => parseExtractedPartitionBody(bad)).toThrow(/_transferSeal/)
  })

  it('parse rejects a non-wrapper body', () => {
    expect(() => parseExtractedPartitionBody('"raw dump string"')).toThrow(/_noydb_bundle_body/)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/hub && pnpm vitest run __tests__/extracted-partition-format.test.ts -t "ExtractedPartitionBody"`
Expected: FAIL — `buildExtractedPartitionWrapper` not exported from `bundle.ts`.

- [ ] **Step 3: Write minimal implementation**

In `bundle.ts`, after the `AutoUnlockBody` interface, add the sibling body type + a shared seal type:

```ts
/**
 * Transfer-seal payload (#206). The destination DEKs, exported to raw
 * bytes and AES-256-GCM-sealed *as a set* under the one-time transfer
 * key. `adoptPartition` (#207) unseals this; `createOwnerOnAdoptedPartition`
 * (#208) re-wraps the raw DEKs under the recipient's KEK.
 */
export interface TransferSealPayload {
  readonly v: 1
  readonly alg: 'aes-256-gcm-pre-shared'
  readonly sealId: string
  /** base64(AES-256-GCM(transferKey, JSON of { collection: base64(rawDEK) })) — iv ‖ ct ‖ tag. */
  readonly payload: string
}

/**
 * Body wrapper for an extracted, transfer-sealed partition (#203/#206).
 * Sibling to {@link AutoUnlockBody}; selected by `header.bundleKind ===
 * 'extracted-partition'`. The inner `dump` is a re-keyed projection with
 * an empty `keyrings` map.
 */
export interface ExtractedPartitionBody {
  readonly _noydb_bundle_body: 1
  readonly dump: string
  readonly _transferSeal: TransferSealPayload
}

export function buildExtractedPartitionWrapper(
  dumpJson: string,
  seal: TransferSealPayload,
): ExtractedPartitionBody {
  return { _noydb_bundle_body: 1, dump: dumpJson, _transferSeal: seal }
}

export function parseExtractedPartitionBody(
  bodyString: string,
): { dump: string; seal: TransferSealPayload } {
  let parsed: unknown
  try {
    parsed = JSON.parse(bodyString)
  } catch (err) {
    throw new BundleIntegrityError(
      'header declared extracted-partition but body could not be parsed as JSON wrapper: '
      + (err instanceof Error ? err.message : String(err)),
    )
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new BundleIntegrityError('extracted-partition body is not a JSON object')
  }
  const obj = parsed as Record<string, unknown>
  if (obj['_noydb_bundle_body'] !== 1) {
    throw new BundleIntegrityError(
      'extracted-partition body missing `_noydb_bundle_body: 1` discriminator',
    )
  }
  if (typeof obj['dump'] !== 'string') {
    throw new BundleIntegrityError('extracted-partition body must carry a string `dump` field')
  }
  const seal = obj['_transferSeal']
  if (typeof seal !== 'object' || seal === null) {
    throw new BundleIntegrityError('extracted-partition body missing `_transferSeal` blob')
  }
  const s = seal as Record<string, unknown>
  if (s['v'] !== 1 || s['alg'] !== 'aes-256-gcm-pre-shared'
      || typeof s['sealId'] !== 'string' || typeof s['payload'] !== 'string') {
    throw new BundleIntegrityError('extracted-partition `_transferSeal` blob is malformed')
  }
  return { dump: obj['dump'], seal: seal as TransferSealPayload }
}
```

Confirm `BundleIntegrityError` is already imported in `bundle.ts` (it is — used by `parseAutoUnlockBody`).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/hub && pnpm vitest run __tests__/extracted-partition-format.test.ts`
Expected: PASS (eight tests).

- [ ] **Step 5: Commit**

```bash
git add packages/hub/src/bundle/bundle.ts packages/hub/__tests__/extracted-partition-format.test.ts
git commit -m "feat(hub): ExtractedPartitionBody wrapper build/parse helpers (#203/#206)"
```

---

## Task 4: Mutual exclusion — reject `autoUnlock` + `extracted-partition`

**Files:**
- Modify: `packages/hub/src/bundle/format.ts`
- Test: `packages/hub/__tests__/extracted-partition-format.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
describe('autoUnlock ⊕ extracted-partition mutual exclusion', () => {
  it('rejects a header carrying both autoUnlock and bundleKind: extracted-partition', () => {
    expect(() =>
      validateBundleHeader({
        ...base,
        autoUnlock: 'sealed',
        bundleKind: 'extracted-partition',
        transferSeal: { v: 1, alg: 'aes-256-gcm-pre-shared', sealId: 's' },
      }),
    ).toThrow(/autoUnlock.*extracted-partition|extracted-partition.*autoUnlock/)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/hub && pnpm vitest run __tests__/extracted-partition-format.test.ts -t "mutual exclusion"`
Expected: FAIL — the header validates (both fields independently valid).

- [ ] **Step 3: Write minimal implementation**

In `validateBundleHeader`, after the cross-field invariant block from Task 2, add:

```ts
  // An extracted partition's unlock path IS the transfer seal. A parallel
  // autoUnlock credential would create two unlock paths and weaken the
  // one-time-seal guarantee (spec §12.3). Reject the combination.
  if (isExtracted && h['autoUnlock'] !== undefined) {
    throw new Error(
      `.noydb bundle header cannot carry both autoUnlock and bundleKind === 'extracted-partition' — `
      + `an extracted partition is unlocked via its transfer seal, not an auto-credential.`,
    )
  }
```

- [ ] **Step 4: Run test + full suite**

Run: `cd packages/hub && pnpm vitest run __tests__/extracted-partition-format.test.ts`
Expected: PASS (nine tests).

Run: `cd packages/hub && pnpm typecheck && pnpm exec eslint src/bundle/format.ts src/bundle/bundle.ts && pnpm vitest run`
Expected: typecheck clean, lint clean, full suite green (prior count + 9 new). In particular the existing `bundle.ts` autoUnlock tests must still pass — this plan adds siblings, changes nothing in the autoUnlock path.

- [ ] **Step 5: Commit**

```bash
git add packages/hub/src/bundle/format.ts packages/hub/__tests__/extracted-partition-format.test.ts
git commit -m "feat(hub): reject autoUnlock + extracted-partition header combination (#206)"
```

---

## Out of scope for this plan (Plan 3b + later)

- **`extractPartition` itself** — closure walk, re-key loop, DEK minting, sealing, writing the bundle via these primitives + returning `{ bundleBytes, transferKey, sealId }`. That is Plan 3b (#203 + #206 logic).
- **`writeNoydbBundle` / `readNoydbBundle` wiring** — making the public write/read paths emit/consume the partition body when `header.bundleKind` is set. Lands with 3b, where there's an end-to-end producer to test against.
- **`features.yaml` + docs** — register with `extractPartition` (3b), the first user-facing surface.

## Self-review notes

- **Spec coverage:** implements the wire-format half of #203 (`bundleKind` header field, §3.1) and #206 (`transferSeal` indicator + the sealed-DEK body payload, §3.2). The seal-DEKs-directly decision (no dest KEK) and the `autoUnlock`⊕`extracted-partition` exclusion are pinned per the advisor review.
- **No format-version bump** — both header fields optional, added to the allowlist; validator keeps exact-equality (spec §3.1).
- **Type consistency:** `TransferSealPayload` (body, full payload, Task 3) vs the header `transferSeal` indicator (Task 1, `{ v, alg, sealId }` — no payload). These are deliberately different shapes: the header is the pre-decryption hint, the body carries the bytes. The `sealId`/`alg`/`v` fields match between them.
- **Cross-field invariants** all live in `validateBundleHeader` so any construction path (encode, decode, direct validate) enforces them uniformly.
