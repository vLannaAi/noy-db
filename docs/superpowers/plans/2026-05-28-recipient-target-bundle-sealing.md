# Recipient-target Bundle Sealing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the deferred `mode: 'recipient-target'` arm to `sealedCredentials` in `writeNoydbBundle`, ship the `RecipientSealer` interface from foundation §11.4, and provide a `MemoryRecipientSealer` reference implementation backed by WebCrypto RSA-OAEP-SHA256 + AES-GCM hybrid encryption.

**Architecture:** Add `RecipientHint` type + `RecipientSealer` interface in `team/managed-passphrase.ts` next to `SealingKeyProvider`. Implement `MemoryRecipientSealer` in the same file. Extend `WriteNoydbBundleOptions.sealedCredentials` with a discriminated `mode: 'recipient-target'` arm; extend `NormalizedAutoUnlock` to carry per-user `hint`. `validateAutoUnlockOptions` gains a recipient-target arm and drops the old "deferred per §11.4" throw. `buildAutoUnlockWrapper` branches on mode and calls `sealForRecipient` instead of `seal`. The reader path is unchanged because the hybrid wrapping lives inside the provider's opaque `Uint8Array`. New optional `SealedAutoUnlockEntry.hint` field carries the hint for recipient verifiability.

**Tech Stack:** TypeScript, WebCrypto (RSA-OAEP-SHA256, AES-GCM, RSA-2048), Vitest, pnpm workspace, Turbo.

**Branch:** `docs/recipient-target-bundle-sealing` (already created; spec committed at `2e8df7e`/`0323da6`).

**Reference docs:**
- Spec: `docs/superpowers/specs/2026-05-28-recipient-target-bundle-sealing-design.md`
- Foundation §11.3, §11.4: `docs/superpowers/specs/2026-05-23-sealing-at-dimension-foundation.md`

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `packages/hub/src/team/managed-passphrase.ts` | Modify | Add `RecipientHint` type, `RecipientSealer` interface, `MemoryRecipientSealer` class |
| `packages/hub/src/index.ts` | Modify | Re-export `RecipientHint`, `RecipientSealer`, `MemoryRecipientSealer` |
| `packages/hub/src/bundle/bundle.ts` | Modify | Extend `sealedCredentials` type with `recipient-target` arm; extend `NormalizedAutoUnlock` with per-user `hint`; new `SealedAutoUnlockEntry.hint?` field; recipient-target arm in `validateAutoUnlockOptions`; sealing branch in `buildAutoUnlockWrapper` |
| `packages/hub/__tests__/managed-passphrase.test.ts` | Modify | Add `MemoryRecipientSealer` unit tests (round-trip, wrong-key, hint round-trip) |
| `packages/hub/__tests__/bundle-auto-unlock.test.ts` | Modify | Add `recipient-target sealedCredentials` describe block (7 tests) |
| `features.yaml` | Modify | Add an invariant line to the `bundle` feature row noting recipient-target capability; reference this spec |

---

## Pre-flight (one-time setup)

- [ ] **Confirm branch + clean working tree**

```bash
git rev-parse --abbrev-ref HEAD
# Expected: docs/recipient-target-bundle-sealing
git status --short
# Expected: empty (clean working tree)
```

If branch is different, run `git checkout docs/recipient-target-bundle-sealing`. If the branch doesn't exist locally, `git fetch origin && git checkout docs/recipient-target-bundle-sealing`. The spec must already be committed on this branch (HEAD should show commits `2e8df7e` and `0323da6` in the history).

---

## Task 1: `MemoryRecipientSealer` + types

Stand up the primitive first. Everything else depends on the interface contract this task pins.

**Files:**
- Modify: `packages/hub/src/team/managed-passphrase.ts`
- Test: `packages/hub/__tests__/managed-passphrase.test.ts`

- [ ] **Step 1: Write the first failing test (round-trip seal/unseal)**

Open `packages/hub/__tests__/managed-passphrase.test.ts`. At the end of the file, add a new describe block:

```ts
import { MemoryRecipientSealer } from '../src/team/managed-passphrase.js'

describe('MemoryRecipientSealer', () => {
  it('round-trips: sealForRecipient → unseal returns the original plaintext', async () => {
    const recipient = new MemoryRecipientSealer({ id: 'alice-rs' })
    const hint = await recipient.publishRecipientHint()

    const sender = new MemoryRecipientSealer({ id: 'sender-rs' })
    const plaintext = new TextEncoder().encode('hello recipient')
    const sealed = await sender.sealForRecipient(plaintext, hint)

    const opened = await recipient.unseal(sealed)
    expect(new TextDecoder().decode(opened)).toBe('hello recipient')
  })
})
```

Note: the import for `MemoryRecipientSealer` may already pick up an existing import line at the top of the file. If `managed-passphrase.js` is not yet imported, add the import line. If it is, extend the import list.

- [ ] **Step 2: Run the test and verify it fails**

```bash
npx vitest run --reporter=dot packages/hub/__tests__/managed-passphrase.test.ts
```

Expected: FAIL with `MemoryRecipientSealer is not defined` (or similar — the type doesn't exist yet).

- [ ] **Step 3: Implement `RecipientHint`, `RecipientSealer`, `MemoryRecipientSealer`**

Open `packages/hub/src/team/managed-passphrase.ts`. After the `MemorySealingKeyProvider` class (around line 150 — find the closing `}` of that class), add:

```ts
/**
 * Public material a sender uses to seal-for-this-recipient. Published by
 * a recipient's RecipientSealer; transported to the sender out-of-band
 * (email, S3, in-app message). The sender obtains the hint, supplies it
 * to writeNoydbBundle's sealedCredentials.perUser[userId].hint, and the
 * hub seals each user's credential against it. Per foundation §11.4.
 */
export type RecipientHint = {
  readonly v: 1
  /** Recipient's provider id; matches the SealedAutoUnlockEntry.pid they'll unseal under. */
  readonly pid: string
  /** Algorithm the sender uses to produce the seal. Slice 1 ships RSA-OAEP-SHA256 only. */
  readonly alg: 'rsa-oaep-sha256'
  /** Public material — alg-specific. For 'rsa-oaep-sha256': { publicKeyPem: string }. */
  readonly material: Readonly<Record<string, unknown>>
}

/**
 * Handover-capable provider. Implemented additionally by asymmetric/granted
 * providers (cloud-KMS asymmetric, Azure RSA Key Vault, AWS KMS with grant).
 * Self-only providers (macOS Keychain, env-var, WebAuthn-PRF) do NOT
 * implement this — the §11.2 capability matrix lives in the type system.
 *
 * Per foundation §11.4. A function that requires recipient-target sealing
 * takes `RecipientSealer`, not `SealingKeyProvider` — the compiler rejects
 * passing a self-only provider at the spec site.
 */
export interface RecipientSealer {
  readonly id: string
  /** Produce hint material a sender uses to seal-for-this-recipient. */
  publishRecipientHint(): Promise<RecipientHint>
  /**
   * Seal plaintext for the recipient described by `hint`. Returns opaque
   * bytes — same contract as `SealingKeyProvider.seal()`. The bundle
   * layer base64-encodes the bytes into `SealedAutoUnlockEntry.sealed`
   * without inspecting them.
   */
  sealForRecipient(plaintext: Uint8Array, hint: RecipientHint): Promise<Uint8Array>
}

/**
 * Reference implementation of `RecipientSealer` + `SealingKeyProvider`.
 * Uses WebCrypto RSA-OAEP-SHA256 (2048-bit) to wrap a fresh 32-byte
 * AES-GCM CEK, AES-GCM-encrypts plaintext under it, and packs the
 * result into a self-describing TLV:
 *
 *   byte  0       : version (0x01)
 *   bytes 1..256  : RSA-OAEP-wrapped CEK (fixed 256 bytes at RSA-2048)
 *   bytes 257..268: AES-GCM IV (12 bytes)
 *   bytes 269..   : AES-GCM ciphertext ‖ 16-byte tag
 *
 * Implements BOTH interfaces. `seal(plaintext)` (self-target) is just
 * `sealForRecipient(plaintext, this own hint)` — same TLV. Convenient
 * for tests where one provider plays both ends. Real cloud providers
 * (`at-aws-kms`, etc.) will pick their own internal layouts; the only
 * contract is round-trip identity.
 *
 * SAFE for production within its scope — the cryptography is real
 * (RSA-OAEP + AES-GCM via WebCrypto), but the keypair lives in-process
 * and is regenerated on every construction. Not suitable as a managed
 * keychain; use it for tests and for shipping bundles where the
 * recipient instance lives in the same process as the sender (rare).
 */
export class MemoryRecipientSealer implements SealingKeyProvider, RecipientSealer {
  readonly id: string
  private readonly keypair: Promise<CryptoKeyPair>

  constructor(opts: { id: string }) {
    this.id = opts.id
    this.keypair = crypto.subtle.generateKey(
      { name: 'RSA-OAEP', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
      true,
      ['encrypt', 'decrypt'],
    ) as Promise<CryptoKeyPair>
  }

  async publishRecipientHint(): Promise<RecipientHint> {
    const { publicKey } = await this.keypair
    const spki = await crypto.subtle.exportKey('spki', publicKey)
    const pem = '-----BEGIN PUBLIC KEY-----\n'
      + bytesToBase64(new Uint8Array(spki)).match(/.{1,64}/g)!.join('\n')
      + '\n-----END PUBLIC KEY-----\n'
    return { v: 1, pid: this.id, alg: 'rsa-oaep-sha256', material: { publicKeyPem: pem } }
  }

  async sealForRecipient(plaintext: Uint8Array, hint: RecipientHint): Promise<Uint8Array> {
    if (hint.v !== 1) {
      throw new Error(`MemoryRecipientSealer.sealForRecipient: unsupported hint.v ${hint.v} (expected 1)`)
    }
    if (hint.alg !== 'rsa-oaep-sha256') {
      throw new Error(`MemoryRecipientSealer.sealForRecipient: unsupported hint.alg '${hint.alg}' (expected 'rsa-oaep-sha256')`)
    }
    const pem = hint.material['publicKeyPem']
    if (typeof pem !== 'string') {
      throw new Error('MemoryRecipientSealer.sealForRecipient: hint.material.publicKeyPem missing or not a string')
    }
    // Parse PEM → SPKI bytes.
    const b64 = pem.replace(/-----BEGIN PUBLIC KEY-----/, '').replace(/-----END PUBLIC KEY-----/, '').replace(/\s+/g, '')
    const spki = base64ToBytes(b64)
    const recipientPub = await crypto.subtle.importKey(
      'spki', spki as BufferSource,
      { name: 'RSA-OAEP', hash: 'SHA-256' },
      false, ['encrypt'],
    )
    // Mint fresh CEK + IV, AES-GCM encrypt plaintext.
    const cekBytes = crypto.getRandomValues(new Uint8Array(32))
    const cek = await crypto.subtle.importKey('raw', cekBytes as BufferSource, 'AES-GCM', false, ['encrypt'])
    const iv = crypto.getRandomValues(new Uint8Array(12))
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv as BufferSource }, cek, plaintext as BufferSource))
    // RSA-OAEP-wrap the CEK bytes.
    const wrapped = new Uint8Array(await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, recipientPub, cekBytes as BufferSource))
    cekBytes.fill(0)
    if (wrapped.length !== 256) {
      throw new Error(`MemoryRecipientSealer.sealForRecipient: expected 256-byte RSA-OAEP wrap, got ${wrapped.length}`)
    }
    // TLV layout.
    const out = new Uint8Array(1 + 256 + 12 + ct.length)
    out[0] = 0x01
    out.set(wrapped, 1)
    out.set(iv, 1 + 256)
    out.set(ct, 1 + 256 + 12)
    return out
  }

  async seal(plaintext: Uint8Array): Promise<Uint8Array> {
    const hint = await this.publishRecipientHint()
    return this.sealForRecipient(plaintext, hint)
  }

  async unseal(bytes: Uint8Array): Promise<Uint8Array> {
    if (bytes.length < 1 + 256 + 12 + 16) {
      throw new Error('MemoryRecipientSealer.unseal: sealed input too short')
    }
    if (bytes[0] !== 0x01) {
      throw new Error(`MemoryRecipientSealer.unseal: unknown TLV version ${bytes[0]}`)
    }
    const wrapped = bytes.subarray(1, 1 + 256)
    const iv = bytes.subarray(1 + 256, 1 + 256 + 12)
    const ct = bytes.subarray(1 + 256 + 12)
    const { privateKey } = await this.keypair
    const cekBytes = new Uint8Array(await crypto.subtle.decrypt({ name: 'RSA-OAEP' }, privateKey, wrapped as BufferSource))
    const cek = await crypto.subtle.importKey('raw', cekBytes as BufferSource, 'AES-GCM', false, ['decrypt'])
    const pt = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv as BufferSource }, cek, ct as BufferSource))
    cekBytes.fill(0)
    return pt
  }
}
```

- [ ] **Step 4: Run the test and verify it passes**

```bash
npx vitest run --reporter=dot packages/hub/__tests__/managed-passphrase.test.ts
```

Expected: PASS (all existing tests + the new one).

- [ ] **Step 5: Add the wrong-key failure test**

In the same describe block in `packages/hub/__tests__/managed-passphrase.test.ts`:

```ts
  it('unseals fail when a third-party provider tries to open someone else\'s envelope', async () => {
    const alice = new MemoryRecipientSealer({ id: 'alice-rs' })
    const carol = new MemoryRecipientSealer({ id: 'carol-rs' })
    const aliceHint = await alice.publishRecipientHint()

    const sender = new MemoryRecipientSealer({ id: 'sender-rs' })
    const sealed = await sender.sealForRecipient(new TextEncoder().encode('for alice only'), aliceHint)

    await expect(carol.unseal(sealed)).rejects.toThrow()
  })
```

- [ ] **Step 6: Run tests and verify the new one passes**

```bash
npx vitest run --reporter=dot packages/hub/__tests__/managed-passphrase.test.ts
```

Expected: PASS for both new tests.

- [ ] **Step 7: Add the hint round-trip test**

```ts
  it('publishRecipientHint returns a v:1 RSA-OAEP-SHA256 hint with the provider id and a PEM public key', async () => {
    const recipient = new MemoryRecipientSealer({ id: 'belle-rs' })
    const hint = await recipient.publishRecipientHint()
    expect(hint.v).toBe(1)
    expect(hint.pid).toBe('belle-rs')
    expect(hint.alg).toBe('rsa-oaep-sha256')
    expect(typeof hint.material['publicKeyPem']).toBe('string')
    expect(hint.material['publicKeyPem']).toMatch(/^-----BEGIN PUBLIC KEY-----/)
    expect(hint.material['publicKeyPem']).toMatch(/-----END PUBLIC KEY-----\n?$/)
  })
```

- [ ] **Step 8: Run tests and confirm green**

```bash
npx vitest run --reporter=dot packages/hub/__tests__/managed-passphrase.test.ts
```

Expected: PASS (3 new tests + existing tests).

- [ ] **Step 9: Commit**

```bash
git add packages/hub/src/team/managed-passphrase.ts packages/hub/__tests__/managed-passphrase.test.ts
git commit -m "feat(hub): RecipientSealer + MemoryRecipientSealer (RSA-OAEP/AES-GCM hybrid)

Adds the RecipientHint type, RecipientSealer interface, and an
in-process MemoryRecipientSealer reference impl implementing both
RecipientSealer and SealingKeyProvider. Hybrid scheme: RSA-OAEP-SHA256
wraps a fresh 32-byte AES-GCM CEK, AES-GCM encrypts the plaintext,
packed into a TLV the provider parses on unseal. Bundle layer is
unaware — sealForRecipient returns opaque Uint8Array (same contract
as SealingKeyProvider.seal).

Per docs/superpowers/specs/2026-05-28-recipient-target-bundle-sealing-design.md."
```

---

## Task 2: Re-export public surface

`MemoryRecipientSealer`, `RecipientSealer`, `RecipientHint` need to be importable from the package barrel so consumers and the test file (`bundle-auto-unlock.test.ts`) can use them via `@noy-db/hub`.

**Files:**
- Modify: `packages/hub/src/index.ts`

- [ ] **Step 1: Find the existing managed-passphrase re-export line**

```bash
grep -n "SealingKeyProvider\|managed-passphrase" packages/hub/src/index.ts | head
```

Expected: a line near `:488` like
```ts
export type { SealingKeyProvider, SealedPassphrase, SealedEnvelope } from './team/managed-passphrase.js'
```
and a value re-export for `MemorySealingKeyProvider` somewhere nearby.

- [ ] **Step 2: Extend the type re-export**

In `packages/hub/src/index.ts`, change the `export type { ... } from './team/managed-passphrase.js'` line to add `RecipientHint`, `RecipientSealer`:

```ts
export type { SealingKeyProvider, SealedPassphrase, SealedEnvelope, RecipientHint, RecipientSealer } from './team/managed-passphrase.js'
```

Find the existing `MemorySealingKeyProvider` value re-export (also in index.ts) and add `MemoryRecipientSealer` next to it:

```ts
export { MemorySealingKeyProvider, MemoryRecipientSealer } from './team/managed-passphrase.js'
```

If `MemorySealingKeyProvider` is in a different export statement form, mirror that form for `MemoryRecipientSealer`.

- [ ] **Step 3: Verify tsc still compiles**

```bash
npx tsc -p packages/hub/tsconfig.json --noEmit
```

Expected: clean exit, no errors.

- [ ] **Step 4: Commit**

```bash
git add packages/hub/src/index.ts
git commit -m "feat(hub): re-export RecipientHint, RecipientSealer, MemoryRecipientSealer from the hub barrel"
```

---

## Task 3: Extend `sealedCredentials` type with `recipient-target` arm

Type-only step: discriminated union extension. No runtime behaviour change yet — `validateAutoUnlockOptions` will still reject `mode !== 'self-target'` until Task 4. This task locks the API shape so subsequent tasks can compile.

**Files:**
- Modify: `packages/hub/src/bundle/bundle.ts`

- [ ] **Step 1: Find current `sealedCredentials` definition**

```bash
grep -n "readonly sealedCredentials\|readonly mode: 'self-target'" packages/hub/src/bundle/bundle.ts | head
```

Expected: the existing `sealedCredentials` type is roughly at lines 194-198:
```ts
readonly sealedCredentials?: {
  readonly mode: 'self-target'
  readonly provider: SealingKeyProvider
  readonly perUser: Record<string, AutoCredential>
}
```

- [ ] **Step 2: Replace `sealedCredentials` with a discriminated union**

In `packages/hub/src/bundle/bundle.ts`, replace the existing `sealedCredentials?: { ... }` block (the one with `mode: 'self-target'`, NOT the deprecated `sealedPassphrases`) with:

```ts
  readonly sealedCredentials?:
    | {
        readonly mode: 'self-target'
        readonly provider: SealingKeyProvider
        readonly perUser: Record<string, AutoCredential>
      }
    | {
        readonly mode: 'recipient-target'
        readonly provider: RecipientSealer
        readonly perUser: Record<string, { readonly credential: AutoCredential; readonly hint: RecipientHint }>
      }
```

Update the JSDoc above it to mention the recipient-target arm (find the existing block; add a brief paragraph after "self-target" mention).

- [ ] **Step 3: Add the imports**

At the top of `packages/hub/src/bundle/bundle.ts`, ensure the import from `../team/managed-passphrase.js` includes `RecipientSealer` and `RecipientHint`:

```ts
import type { SealingKeyProvider, RecipientSealer, RecipientHint } from '../team/managed-passphrase.js'
```

If the import line already exists, just extend the type-only import list.

- [ ] **Step 4: Extend `NormalizedAutoUnlock` to carry per-user hint + recipient-target mode**

Find `interface NormalizedAutoUnlock` (around line 348). Replace it with:

```ts
interface NormalizedAutoUnlock {
  readonly mode: 'unsealed' | 'sealed-self' | 'sealed-recipient'
  readonly provider?: SealingKeyProvider | RecipientSealer
  readonly perUser: Record<string, AutoCredential>
  /** Present only for `sealed-recipient`. Same key set as `perUser`. */
  readonly hints?: Record<string, RecipientHint>
}
```

- [ ] **Step 5: Update `normalizeAutoUnlock` to emit the new discriminator + hints**

Find `function normalizeAutoUnlock`. Replace its `sealedCredentials` branch with:

```ts
  if (opts.sealedCredentials !== undefined) {
    if (opts.sealedCredentials.mode === 'recipient-target') {
      const perUser: Record<string, AutoCredential> = {}
      const hints: Record<string, RecipientHint> = {}
      for (const [userId, entry] of Object.entries(opts.sealedCredentials.perUser)) {
        perUser[userId] = entry.credential
        hints[userId] = entry.hint
      }
      return { mode: 'sealed-recipient', provider: opts.sealedCredentials.provider, perUser, hints }
    }
    return { mode: 'sealed-self', provider: opts.sealedCredentials.provider, perUser: opts.sealedCredentials.perUser }
  }
```

The existing `autoCredentials` branch returns `mode: 'unsealed'` — change `return { mode: 'unsealed', ... }` to keep that string (no rename needed). The existing `sealedPassphrases` (deprecated) branch returns `mode: 'sealed'` — change it to `mode: 'sealed-self'`. Same for the `autoPassphrases` legacy branch — no change there (it stays `'unsealed'`).

Search for every remaining `mode === 'sealed'` and `mode: 'sealed'` reference in `bundle.ts` and rename to `'sealed-self'` (the validator and the wrapper builder, two call sites). Be precise — keep `'sealed-recipient'` and `'unsealed'` distinct.

- [ ] **Step 6: Update `validateAutoUnlockOptions` mode-mapping return value**

`validateAutoUnlockOptions` returns `'unsealed' | 'sealed' | null` (the header value). The header `autoUnlock` field is still `'unsealed' | 'sealed'` — both `sealed-self` and `sealed-recipient` map to `'sealed'` on the wire. Update the function signature and the return statements so the function still returns `'unsealed' | 'sealed' | null` but maps both sealed-self and sealed-recipient to `'sealed'`.

- [ ] **Step 7: Verify tsc compiles**

```bash
npx tsc -p packages/hub/tsconfig.json --noEmit
```

Expected: clean exit. (There may still be runtime test failures because validation still rejects recipient-target — that's intentional, fixed in Task 4.)

- [ ] **Step 8: Run the full hub suite to confirm no regression on existing tests**

```bash
npx vitest run --reporter=dot packages/hub/__tests__/bundle-auto-unlock.test.ts packages/hub/__tests__/managed-passphrase.test.ts
```

Expected: PASS (all existing self-target tests still green).

- [ ] **Step 9: Commit**

```bash
git add packages/hub/src/bundle/bundle.ts
git commit -m "feat(hub): extend sealedCredentials with recipient-target arm (types only)

Discriminated union on sealedCredentials.mode: 'self-target' keeps the
current shape, 'recipient-target' takes a RecipientSealer + per-user
{ credential, hint } map. NormalizedAutoUnlock gains a 'sealed-recipient'
discriminator and an optional hints map. Wire-level header autoUnlock
value still 'sealed' | 'unsealed' — both sealed-self and sealed-recipient
map to 'sealed'. validateAutoUnlockOptions still rejects recipient-target
at this stage (lifted in the next commit)."
```

---

## Task 4: Validation — accept recipient-target

Lift the "deferred per foundation §11.4" throw and add the recipient-target validation rules.

**Files:**
- Modify: `packages/hub/src/bundle/bundle.ts`
- Test: `packages/hub/__tests__/bundle-auto-unlock.test.ts`

- [ ] **Step 1: Write failing tests for the validator**

At the end of `packages/hub/__tests__/bundle-auto-unlock.test.ts`, add a describe block (find the appropriate insertion point — there's a top-level describe for sealed bundle delivery; add a sibling describe):

```ts
import { MemoryRecipientSealer } from '../src/index.js'

describe('recipient-target sealedCredentials — validation', () => {
  it('rejects a recipient-target entry with a missing hint', async () => {
    const { vault: v } = await freshVault()
    const recipient = new MemoryRecipientSealer({ id: 'r1' })

    await expect(
      writeNoydbBundle(v, {
        sealedCredentials: {
          mode: 'recipient-target',
          provider: recipient,
          // @ts-expect-error — intentionally missing hint to test runtime guard
          perUser: { alice: { credential: { kind: 'passphrase', value: 'p' } } },
        },
      }),
    ).rejects.toThrow(/hint/)
  })

  it('rejects when hint.pid does not match the provider id', async () => {
    const { vault: v } = await freshVault()
    const recipient = new MemoryRecipientSealer({ id: 'r1' })
    const otherRecipient = new MemoryRecipientSealer({ id: 'r2' })
    const otherHint = await otherRecipient.publishRecipientHint()

    await expect(
      writeNoydbBundle(v, {
        sealedCredentials: {
          mode: 'recipient-target',
          provider: recipient, // id = 'r1'
          perUser: { alice: { credential: { kind: 'passphrase', value: 'p' }, hint: otherHint } }, // hint.pid = 'r2'
        },
      }),
    ).rejects.toThrow(/pid/)
  })

  it('rejects a recipient-target mode with a self-only provider (runtime guard for JS callers)', async () => {
    const { vault: v } = await freshVault()
    const selfOnly = new MemorySealingKeyProvider({ id: 'self-only' })
    const someHint = await new MemoryRecipientSealer({ id: 'r1' }).publishRecipientHint()

    await expect(
      writeNoydbBundle(v, {
        sealedCredentials: {
          mode: 'recipient-target',
          // @ts-expect-error — runtime guard for JS callers; TS rejects this at compile time
          provider: selfOnly,
          perUser: { alice: { credential: { kind: 'passphrase', value: 'p' }, hint: someHint } },
        },
      }),
    ).rejects.toThrow(/RecipientSealer/)
  })
})
```

(`freshVault()` is the existing helper at `bundle-auto-unlock.test.ts:69` — no args; returns `{ db, vault }`. Destructure `vault` and assign locally.)

- [ ] **Step 2: Run the tests and verify they fail**

```bash
npx vitest run --reporter=dot packages/hub/__tests__/bundle-auto-unlock.test.ts -t "recipient-target sealedCredentials"
```

Expected: all 3 tests FAIL — probably with "must be 'self-target'" (the existing throw).

- [ ] **Step 3: Lift the deferred throw and add recipient-target validation**

In `packages/hub/src/bundle/bundle.ts`, find `validateAutoUnlockOptions` (around line 425). Find the block:

```ts
  // Sealed path.
  const mode = opts.sealedCredentials?.mode ?? opts.sealedPassphrases?.mode
  if (mode !== 'self-target') {
    throw new ValidationError(
      `writeNoydbBundle: \`sealedCredentials.mode\` (or \`sealedPassphrases.mode\`) must be `
      + `'self-target' in slice 1 (got '${String(mode)}'). Recipient-target sealing via the `
      + 'RecipientSealer interface is deferred per foundation §11.4.',
    )
  }
```

Replace it with:

```ts
  // Sealed path — branch on mode.
  if (normalized.mode === 'sealed-recipient') {
    const provider = normalized.provider
    if (provider === undefined || typeof (provider as RecipientSealer).publishRecipientHint !== 'function'
        || typeof (provider as RecipientSealer).sealForRecipient !== 'function') {
      throw new ValidationError(
        'writeNoydbBundle: `sealedCredentials.provider` for mode \'recipient-target\' must be a '
        + 'RecipientSealer (publishRecipientHint + sealForRecipient). Self-only providers '
        + '(MemorySealingKeyProvider, at-macos-keychain, etc.) do not satisfy this contract.',
      )
    }
    const hints = normalized.hints
    if (hints === undefined) {
      throw new Error('unreachable — sealed-recipient normalization must populate hints')
    }
    for (const userId of Object.keys(normalized.perUser)) {
      const hint = hints[userId]
      if (hint === undefined) {
        throw new ValidationError(
          `writeNoydbBundle: \`sealedCredentials.perUser['${userId}']\` missing required \`hint\` for mode 'recipient-target'.`,
        )
      }
      if (hint.v !== 1) {
        throw new ValidationError(
          `writeNoydbBundle: \`sealedCredentials.perUser['${userId}'].hint.v\` must be 1 (got ${hint.v}).`,
        )
      }
      if (hint.alg !== 'rsa-oaep-sha256') {
        throw new ValidationError(
          `writeNoydbBundle: \`sealedCredentials.perUser['${userId}'].hint.alg\` must be 'rsa-oaep-sha256' in slice 1 (got '${hint.alg}').`,
        )
      }
      if (hint.pid !== provider.id) {
        throw new ValidationError(
          `writeNoydbBundle: \`sealedCredentials.perUser['${userId}'].hint.pid\` ('${hint.pid}') does not match the provider id ('${provider.id}'). `
          + 'Sender cannot seal for a recipient whose hint points at a different provider.',
        )
      }
    }
    const userCount = Object.keys(normalized.perUser).length
    if (userCount === 0) {
      throw new ValidationError(
        'writeNoydbBundle: `sealedCredentials.perUser` must have at least one entry.',
      )
    }
    return 'sealed'
  }

  // mode === 'sealed-self'
  const selfTargetMode = opts.sealedCredentials?.mode ?? opts.sealedPassphrases?.mode
  if (selfTargetMode !== 'self-target') {
    throw new ValidationError(
      `writeNoydbBundle: \`sealedCredentials.mode\` (or \`sealedPassphrases.mode\`) must be `
      + `'self-target' or 'recipient-target' (got '${String(selfTargetMode)}').`,
    )
  }
  if (normalized.provider === undefined) {
    throw new ValidationError(
      'writeNoydbBundle: `sealedCredentials.provider` (or `sealedPassphrases.provider`) '
      + 'is required (a `SealingKeyProvider`).',
    )
  }
  const userCount = Object.keys(normalized.perUser).length
  if (userCount === 0) {
    throw new ValidationError(
      'writeNoydbBundle: `sealedCredentials.perUser` (or `sealedPassphrases.perUser`) '
      + 'must have at least one entry.',
    )
  }
  return 'sealed'
```

Make sure the `RecipientSealer` type-only import exists at the top of `bundle.ts` (added in Task 3).

- [ ] **Step 4: Run the validation tests and verify they pass**

```bash
npx vitest run --reporter=dot packages/hub/__tests__/bundle-auto-unlock.test.ts -t "recipient-target sealedCredentials"
```

Expected: PASS for all 3 validation tests.

- [ ] **Step 5: Run the full bundle-auto-unlock suite to confirm no regression**

```bash
npx vitest run --reporter=dot packages/hub/__tests__/bundle-auto-unlock.test.ts
```

Expected: PASS (all existing tests still green).

- [ ] **Step 6: Commit**

```bash
git add packages/hub/src/bundle/bundle.ts packages/hub/__tests__/bundle-auto-unlock.test.ts
git commit -m "feat(hub): validateAutoUnlockOptions accepts mode: 'recipient-target'

Checks: provider is a RecipientSealer (publishRecipientHint +
sealForRecipient present); every perUser[k].hint is well-formed
(v === 1, alg === 'rsa-oaep-sha256', pid matches provider.id);
perUser non-empty. Drops the old 'deferred per foundation §11.4'
throw. Runtime guards cover JS callers; TS callers can't reach the
runtime checks without satisfying RecipientSealer at the type level."
```

---

## Task 5: Sealing — `buildAutoUnlockWrapper` branches on mode

Implement the actual sealing call for recipient-target.

**Files:**
- Modify: `packages/hub/src/bundle/bundle.ts`

- [ ] **Step 1: Write a failing happy-path test**

In `packages/hub/__tests__/bundle-auto-unlock.test.ts`, add a new describe block (sibling to the validation one from Task 4):

```ts
describe('recipient-target sealedCredentials — round-trip', () => {
  it('seals for two recipients; each opens only their own credential', async () => {
    const { vault: v } = await freshVault()

    const aliceRs = new MemoryRecipientSealer({ id: 'alice-rs' })
    const bobRs = new MemoryRecipientSealer({ id: 'bob-rs' })
    const aliceHint = await aliceRs.publishRecipientHint()
    const bobHint = await bobRs.publishRecipientHint()

    // Sender uses a third instance — production shape: sender doesn't hold
    // any recipient's private key.
    const sender = new MemoryRecipientSealer({ id: 'sender-rs' })

    const bytes = await writeNoydbBundle(v, {
      sealedCredentials: {
        mode: 'recipient-target',
        provider: sender,
        perUser: {
          alice: { credential: { kind: 'passphrase', value: 'alice-pass-bundled' }, hint: aliceHint },
          bob:   { credential: { kind: 'passphrase', value: 'bob-pass-bundled' },   hint: bobHint },
        },
      },
    })

    // Recipient side — alice unseals with her provider.
    const aliceRead = await readNoydbBundle(bytes, { sealingProviders: [aliceRs] })
    expect(aliceRead.autoUnlock?.kind).toBe('sealed')
    expect(aliceRead.autoUnlock?.perUser.alice).toMatchObject({ kind: 'passphrase', value: 'alice-pass-bundled' })

    const bobRead = await readNoydbBundle(bytes, { sealingProviders: [bobRs] })
    expect(bobRead.autoUnlock?.perUser.bob).toMatchObject({ kind: 'passphrase', value: 'bob-pass-bundled' })
  })
})
```

(Note: the `readNoydbBundle` recipient lookup mechanism matches by `pid`. Both aliceRs and bobRs have unique ids; the reader picks the one matching the entry's `pid`. Confirm by reading the existing `'sealed'`-mode test that already exercises `sealingProviders` — same code path.)

- [ ] **Step 2: Run the test and verify it fails**

```bash
npx vitest run --reporter=dot packages/hub/__tests__/bundle-auto-unlock.test.ts -t "recipient-target sealedCredentials — round-trip"
```

Expected: FAIL (likely: bundle produced with no actual sealing, or with self-target seal that the recipient can't unseal).

- [ ] **Step 3: Branch `buildAutoUnlockWrapper` on mode**

In `packages/hub/src/bundle/bundle.ts`, find `buildAutoUnlockWrapper` (around line 496). Replace the sealed-path body (everything after the `// Sealed path —` comment) with:

```ts
  // Sealed path — branch on mode.
  const provider = normalized.provider
  if (provider === undefined) {
    throw new Error('unreachable — validation should have caught this')
  }
  const sealedPerUser: Record<string, SealedAutoUnlockEntry> = {}
  const encoder = new TextEncoder()

  if (normalized.mode === 'sealed-recipient') {
    const recipientSealer = provider as RecipientSealer
    const hints = normalized.hints
    if (hints === undefined) {
      throw new Error('unreachable — sealed-recipient normalization must populate hints')
    }
    for (const [userId, cred] of Object.entries(normalized.perUser)) {
      const hint = hints[userId]!
      const sealed = await recipientSealer.sealForRecipient(encoder.encode(cred.value), hint)
      sealedPerUser[userId] = {
        pid: hint.pid,                  // use the recipient's pid, not the sender's
        sealed: bytesToBase64(sealed),
        alg: 'aes-256-gcm',
        kind: cred.kind,
        hint,
      }
    }
  } else {
    // mode === 'sealed-self'
    const selfSealer = provider as SealingKeyProvider
    for (const [userId, cred] of Object.entries(normalized.perUser)) {
      const sealed = await selfSealer.seal(encoder.encode(cred.value))
      sealedPerUser[userId] = {
        pid: selfSealer.id,
        sealed: bytesToBase64(sealed),
        alg: 'aes-256-gcm',
        kind: cred.kind,
      }
    }
  }

  return {
    _noydb_bundle_body: 1,
    dump: dumpJson,
    _autoUnlock: { kind: 'sealed', perUser: sealedPerUser },
  }
```

Extend `SealedAutoUnlockEntry` (find it around line 289-295) to add the optional `hint?` field:

```ts
interface SealedAutoUnlockEntry {
  readonly pid: string
  readonly sealed: string
  readonly alg: 'aes-256-gcm'
  readonly kind?: AutoCredentialKind
  /**
   * Recipient-target only: the RecipientHint the sender used to seal.
   * Carried for recipient verifiability ("yes this was sealed against
   * my published hint"). Self-target entries omit it. Pre-0.2 readers
   * ignore unknown fields, so this is back-compatible.
   */
  readonly hint?: RecipientHint
}
```

Add a type-only import for `RecipientHint` to the file's top if not already present (it was added in Task 3 — verify).

- [ ] **Step 4: Run the happy-path test and verify it passes**

```bash
npx vitest run --reporter=dot packages/hub/__tests__/bundle-auto-unlock.test.ts -t "recipient-target sealedCredentials — round-trip"
```

Expected: PASS.

- [ ] **Step 5: Add a wrong-recipient (third-party priv key) test**

In the same describe block:

```ts
  it('a third-party recipient (different keypair) cannot unseal someone else\'s entry', async () => {
    const { vault: v } = await freshVault()
    const aliceRs = new MemoryRecipientSealer({ id: 'alice-rs' })
    const intruderRs = new MemoryRecipientSealer({ id: 'alice-rs' }) // same id, different keypair
    const aliceHint = await aliceRs.publishRecipientHint()
    const sender = new MemoryRecipientSealer({ id: 'sender-rs' })

    const bytes = await writeNoydbBundle(v, {
      sealedCredentials: {
        mode: 'recipient-target',
        provider: sender,
        perUser: { alice: { credential: { kind: 'passphrase', value: 'p' }, hint: aliceHint } },
      },
    })

    // Intruder has the same pid (so the reader's dispatch finds it) but a
    // different keypair → unseal fails inside the provider.
    await expect(readNoydbBundle(bytes, { sealingProviders: [intruderRs] })).rejects.toThrow()
  })
```

- [ ] **Step 6: Add a back-compat regression test**

```ts
  it('back-compat: self-target bundles still round-trip with no hint field', async () => {
    const { vault: v } = await freshVault()
    const selfProvider = new MemorySealingKeyProvider({ id: 'shared-keychain' })

    const bytes = await writeNoydbBundle(v, {
      sealedCredentials: {
        mode: 'self-target',
        provider: selfProvider,
        perUser: { alice: { kind: 'passphrase', value: 'alice-pass-bundled' } },
      },
    })
    const recipientProvider = new MemorySealingKeyProvider({ id: 'shared-keychain' })
    const read = await readNoydbBundle(bytes, { sealingProviders: [recipientProvider] })
    expect(read.autoUnlock?.kind).toBe('sealed')
    expect(read.autoUnlock?.perUser.alice).toMatchObject({ kind: 'passphrase', value: 'alice-pass-bundled' })
  })
```

- [ ] **Step 7: Run the full bundle-auto-unlock test file**

```bash
npx vitest run --reporter=dot packages/hub/__tests__/bundle-auto-unlock.test.ts
```

Expected: PASS for ALL tests (new + existing).

- [ ] **Step 8: Run the full hub suite to confirm zero monorepo regressions**

```bash
npx vitest run --reporter=dot packages/hub/__tests__/
```

Expected: PASS / unchanged skipped count.

- [ ] **Step 9: Commit**

```bash
git add packages/hub/src/bundle/bundle.ts packages/hub/__tests__/bundle-auto-unlock.test.ts
git commit -m "feat(hub): seal-for-recipient path in buildAutoUnlockWrapper

Sealed-recipient mode calls provider.sealForRecipient(plaintext, hint)
per-user and emits SealedAutoUnlockEntry{ pid: hint.pid, sealed, alg,
kind, hint }. Sealed-self path unchanged (calls provider.seal).
SealedAutoUnlockEntry gains optional hint field for recipient
verifiability. Reader path is unchanged — pid dispatch + provider.unseal
handle the hybrid envelope opaquely.

Tests: two-recipient happy path, wrong-recipient (different keypair),
self-target back-compat."
```

---

## Task 6: features.yaml + bundle subsystem doc

Surface the new capability.

**Files:**
- Modify: `features.yaml`
- Modify: `docs/subsystems/bundle.md` (verify it exists first)

- [ ] **Step 1: Find the `bundle` feature row**

```bash
grep -n "^  - id: bundle$" features.yaml
```

Expected: a single match around line 638.

- [ ] **Step 2: Add an invariant to the `bundle` row**

In `features.yaml`, find the `invariants:` list under `- id: bundle`. Append a new entry:

```yaml
      - 'auto-unlock: sealed-self (provider id matches both ends) and sealed-recipient (sender uses recipient-published RSA-OAEP hint; reader dispatches by pid, unseal handles hybrid CEK wrap opaquely) — see docs/superpowers/specs/2026-05-28-recipient-target-bundle-sealing-design.md'
```

- [ ] **Step 3: Check `docs/subsystems/bundle.md` exists**

```bash
ls -la docs/subsystems/bundle.md
```

If the file exists, add a one-paragraph note at the bottom under a `## Recipient-target sealing` heading:

```markdown
## Recipient-target sealing (slice 2)

`sealedCredentials.mode: 'recipient-target'` lets a sender ship a bundle
to a recipient whose `SealingKeyProvider` the sender does not have. The
recipient publishes a `RecipientHint` (RSA-OAEP-SHA256 public material +
`pid`) via any out-of-band channel; the sender passes it per-user. The
sealing provider must implement `RecipientSealer` (`publishRecipientHint`
+ `sealForRecipient`) — handover-capable cloud-KMS providers do,
self-only providers (`at-macos-keychain`, `at-env`) do not. The reader
side is unchanged: `pid` dispatch finds the matching local provider,
which transparently parses the hybrid CEK-wrap envelope inside the
opaque `sealed` bytes. See [`recipient-target sealing
design`](../superpowers/specs/2026-05-28-recipient-target-bundle-sealing-design.md)
for the full spec.
```

If the file does NOT exist, skip this step — the spec reference in `features.yaml` is sufficient for this slice.

- [ ] **Step 4: Run the features-yaml validator**

```bash
node scripts/validate-features.mjs 2>&1 | tail -5
```

If the script doesn't exist at that path, search:

```bash
find scripts -name "validate-features*" 2>/dev/null
```

Run whatever validator is found. Expected: no errors, no dangling refs.

- [ ] **Step 5: Commit**

```bash
git add features.yaml docs/subsystems/bundle.md  # second path only if it exists and was modified
git commit -m "docs(features): register recipient-target sealing under bundle feature

Adds an invariant to the bundle feature row referencing the design spec.
Updates docs/subsystems/bundle.md with a recipient-target slice note
(if bundle.md exists)."
```

---

## Task 7: Final verification + push + PR

- [ ] **Step 1: Full monorepo lint + typecheck**

```bash
npx turbo run lint typecheck 2>&1 | tail -10
```

Expected: all turbo tasks pass.

- [ ] **Step 2: Full monorepo test suite**

```bash
npx vitest run --reporter=dot 2>&1 | tail -6
```

Expected: PASS, the new test count = previous + 3 (MemoryRecipientSealer unit) + 3 (validation) + 3 (round-trip) = previous + 9.

- [ ] **Step 3: Push the branch**

```bash
git push -u origin docs/recipient-target-bundle-sealing
```

- [ ] **Step 4: Open a draft PR linking #197**

```bash
gh pr create --draft --title "feat(hub): recipient-target bundle sealing (#197 final slice)" --body "Implements the deferred \`mode: 'recipient-target'\` arm of \`sealedCredentials\` per foundation §11.4 + the design spec committed in this branch.

## What's in this PR

- \`RecipientHint\` + \`RecipientSealer\` interfaces in \`team/managed-passphrase.ts\`
- \`MemoryRecipientSealer\` reference implementation (WebCrypto RSA-OAEP-SHA256 + AES-GCM hybrid via a self-describing TLV inside the provider's opaque \`Uint8Array\`)
- \`sealedCredentials.mode: 'recipient-target'\` arm on \`WriteNoydbBundleOptions\` (typed \`provider: RecipientSealer\`, \`perUser: Record<userId, { credential, hint }>\`)
- \`validateAutoUnlockOptions\` checks provider satisfies \`RecipientSealer\`, every per-user \`hint\` is well-formed (\`v === 1\`, \`alg === 'rsa-oaep-sha256'\`, \`pid === provider.id\`)
- \`buildAutoUnlockWrapper\` branches on mode and calls \`sealForRecipient\` for recipient-target entries; emits a new optional \`SealedAutoUnlockEntry.hint\` field for recipient verifiability
- Reader path unchanged — \`pid\` dispatch finds the matching recipient provider, which transparently parses the hybrid TLV inside the opaque \`sealed\` bytes
- Test coverage: 9 new tests across \`managed-passphrase.test.ts\` and \`bundle-auto-unlock.test.ts\` (unit, validation, two-recipient round-trip, wrong-recipient failure, self-target back-compat)

## What's NOT in this PR (deferred follow-ups)

- Real cloud-provider \`RecipientSealer\` impls (one issue per package: \`at-aws-kms\`, \`at-azure-keyvault\`, \`at-gcp-kms\`)
- \`MultiRecipientSealer\` (foundation §11.4 future)
- In-vault hint discovery via \`_meta/user/<keyringId>\` (foundation §11.4 future)
- Recipient-target sealing for extracted-partition bundles (header mutual-exclusion stays for now)

Closes #197."
```

- [ ] **Step 5: Wait for CI green; ready for review**

```bash
gh pr checks --watch
```

Expected: all checks pass.

---

## Self-review checklist (do not skip)

- [ ] Spec §4 interfaces match `RecipientHint`/`RecipientSealer` shape in Task 1 ✓
- [ ] Spec §5 write-side `perUser: { credential, hint }` shape matches Task 3 ✓
- [ ] Spec §6 wire format — `SealedAutoUnlockEntry.hint?` added in Task 5; `SealedEnvelope` untouched ✓
- [ ] Spec §7 MemoryRecipientSealer TLV layout matches Task 1's seal/unseal byte arithmetic ✓
- [ ] Spec §8 validation rules (hint presence, `v === 1`, `alg`, `pid === provider.id`) all in Task 4 ✓
- [ ] Spec §10 test plan items 1-7 all present:
  - happy path → Task 5 round-trip ✓
  - missing hint → Task 4 validation ✓
  - mismatched pid → Task 4 validation ✓
  - wrong recipient → Task 5 wrong-recipient ✓
  - mode mismatch → Task 4 validation ✓
  - wire-format back-compat → Task 5 self-target round-trip ✓
  - hint round-trip → implicit in Task 1's `publishRecipientHint` test + Task 5 round-trip uses hint ✓
- [ ] Spec §11 file table matches actually-touched files in each task ✓
- [ ] Every code block has actual, complete code (no "TBD", no "similar to Task N") ✓
- [ ] Type/property names consistent: `RecipientHint`, `RecipientSealer`, `MemoryRecipientSealer`, `publishRecipientHint`, `sealForRecipient`, `hint`, `pid`, `v`, `alg`, `material`, `publicKeyPem` — used identically across tasks ✓
- [ ] Mode discriminators in `NormalizedAutoUnlock` (`'sealed-self'`, `'sealed-recipient'`) consistent across Tasks 3, 4, 5 ✓

---

## Reference: existing code anchors

| Symbol | File:line (as of branch HEAD) |
|---|---|
| `SealingKeyProvider` interface | `packages/hub/src/team/managed-passphrase.ts:60` |
| `MemorySealingKeyProvider` | `packages/hub/src/team/managed-passphrase.ts:94` |
| `SealedEnvelope` (managed-passphrase) | `packages/hub/src/team/managed-passphrase.ts:181` |
| `sealedCredentials?: { ... }` option | `packages/hub/src/bundle/bundle.ts:194` |
| `SealedAutoUnlockEntry` | `packages/hub/src/bundle/bundle.ts:289` |
| `NormalizedAutoUnlock` | `packages/hub/src/bundle/bundle.ts:348` |
| `normalizeAutoUnlock` | `packages/hub/src/bundle/bundle.ts:376` |
| `validateAutoUnlockOptions` | `packages/hub/src/bundle/bundle.ts:425` |
| `buildAutoUnlockWrapper` | `packages/hub/src/bundle/bundle.ts:496` |
| `bundle` feature row | `features.yaml:638` |
| `bundle-auto-unlock.test.ts` | `packages/hub/__tests__/bundle-auto-unlock.test.ts` |
| `managed-passphrase.test.ts` | `packages/hub/__tests__/managed-passphrase.test.ts` |
