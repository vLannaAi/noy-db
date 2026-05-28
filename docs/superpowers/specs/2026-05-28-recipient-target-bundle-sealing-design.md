# Recipient-target bundle sealing — design

**Status:** spec, ready for plan
**Issue:** #197 final slice (slice 1 `autoCredentials`/`sealedCredentials` self-target shipped in commit `5f92139`; #215 generalized to non-passphrase credentials; this slice adds the recipient-target arm)
**Foundation reference:** [`2026-05-23-sealing-at-dimension-foundation.md`](2026-05-23-sealing-at-dimension-foundation.md) §11.3, §11.4
**Authoring date:** 2026-05-28

## 1. Context

`writeNoydbBundle` already supports auto-unlock bundles in two flavours, both keyed `mode: 'self-target'`:

- `autoCredentials` — plaintext `perUser` map, public-by-design (demo bundles).
- `sealedCredentials` — `perUser` map sealed under a `SealingKeyProvider` whose `id` matches a provider the recipient holds locally (e.g. shared MDM-provisioned keychain entry).

Both modes assume sender and recipient share the same provider identity. They cannot ship a bundle to a recipient whose provider the sender does not have.

The foundation spec resolves this with a separate `RecipientSealer` interface (§11.4). Handover-capable providers (`at-aws-kms`, `at-gcp-kms`, `at-azure-keyvault`) implement it; symmetric providers (`at-macos-keychain`, `at-env`, etc.) do not. This slice adds the `mode: 'recipient-target'` arm to `sealedCredentials` and the validation that goes with it, defines the `RecipientSealer` interface, and ships a single in-process reference implementation (`MemoryRecipientSealer`) suitable for tests. Real cloud-provider implementations are out of scope and will land as one follow-up issue per `at-*` package.

## 2. Goals

- Type-system honesty: a function that requires recipient-target sealing takes `RecipientSealer`, not `SealingKeyProvider`. The compiler rejects passing a self-only provider at the spec site.
- Wire-format invariance: a recipient-target sealed entry is indistinguishable from a self-target sealed entry past the bundle boundary. The reader path stays unchanged.
- Reference implementation: `MemoryRecipientSealer` exercises the protocol end-to-end in tests without cloud credentials, using WebCrypto RSA-OAEP-SHA256 + AES-GCM hybrid encryption.
- Explicit deferral surface: real `at-*` implementations are spec'd as follow-ups; the interface and validation contracts they must satisfy are pinned here.

## 3. Non-goals

- Real `at-*` `RecipientSealer` implementations (`at-aws-kms`, `at-azure-keyvault`, `at-gcp-kms`). One follow-up issue per package.
- `MultiRecipientSealer` (seal once for N recipients). Foundation §11.4 future.
- In-vault hint discovery via `_meta/user/<keyringId>`. Foundation §11.4 future.
- Recipient-target sealing on extracted-partition bundles. The header mutual-exclusion between `bundleKind === 'extracted-partition'` and `autoUnlock` stays; composing the two is a separate design exercise tied to `#197`'s motivating customer-pre-delivery flow.
- Algorithm agility. This slice ships exactly one algorithm: `'rsa-oaep-sha256'`. Adding `'kms-encrypt-cross-account'` and friends is per-package follow-up work that extends the `RecipientHint.alg` union.

## 4. Interfaces

In `packages/hub/src/team/managed-passphrase.ts` (next to `SealingKeyProvider`):

```ts
/**
 * Public material a sender uses to seal-for-this-recipient. Published by
 * a recipient's RecipientSealer; transported to the sender out-of-band
 * (email, S3, in-app message). The sender obtains the hint, supplies it
 * to writeNoydbBundle, and the hub seals each user's credential against
 * it. Verbatim per foundation §11.4.
 */
export type RecipientHint = {
  readonly v: 1
  /** Recipient's provider id; matches the SealedEnvelope.pid they'll unseal under. */
  readonly pid: string
  /** Algorithm the sender uses to produce the seal. */
  readonly alg: 'rsa-oaep-sha256'
  /** Public material — alg-specific. For 'rsa-oaep-sha256': { publicKeyPem: string }. */
  readonly material: Readonly<Record<string, unknown>>
}

/**
 * Handover-capable provider. Implemented additionally by asymmetric/granted
 * providers (cloud-KMS asymmetric, Azure RSA Key Vault, AWS KMS with grant).
 * Self-only providers (macOS Keychain, env-var, WebAuthn-PRF) do NOT
 * implement this — the §11.2 capability matrix lives in the type system.
 */
export interface RecipientSealer {
  readonly id: string
  /** Produce hint material a sender uses to seal-for-this-recipient. */
  publishRecipientHint(): Promise<RecipientHint>
  /**
   * Seal plaintext for the recipient described by hint. Returns opaque
   * bytes — same contract as `SealingKeyProvider.seal()`. The bundle
   * layer base64-encodes the bytes into `SealedAutoUnlockEntry.sealed`
   * without inspecting them.
   */
  sealForRecipient(plaintext: Uint8Array, hint: RecipientHint): Promise<Uint8Array>
}
```

`SealedEnvelope` (the `_meta/sealed-passphrase` envelope used by managed-mode vaults) is **not** touched. Recipient-target sealing is bundle-layer only.

## 5. Write-side API

Extend the existing `sealedCredentials` option on `writeNoydbBundle` with a discriminated `recipient-target` arm:

```ts
sealedCredentials: {
  mode: 'recipient-target'
  provider: RecipientSealer
  perUser: Record<string, { credential: AutoCredential; hint: RecipientHint }>
}
```

The `mode: 'self-target'` arm is unchanged. Mutual-exclusion with `autoCredentials`, `autoPassphrases`, `sealedPassphrases` is unchanged.

Per-user payload shape is inline `{ credential, hint }` rather than a parallel `recipientHints` map. Two reasons: (1) it forbids the structurally-invalid state of having a `credential` for a user with no `hint` (or vice versa); (2) it matches the foundation §11.4 sketch verbatim.

## 6. Wire format

The bundle layer only sees opaque bytes — `SealingKeyProvider.seal()` and `RecipientSealer.sealForRecipient()` both return `Uint8Array`, and the bundle base64-encodes them into `SealedAutoUnlockEntry.sealed`. The hybrid scheme lives entirely **inside** the provider's opaque blob, not at the bundle layer.

`SealedAutoUnlockEntry` in `packages/hub/src/bundle/bundle.ts` gains one optional field:

```ts
interface SealedAutoUnlockEntry {
  readonly pid: string
  readonly sealed: string                    // base64 — provider-opaque; may contain hybrid TLV internally
  readonly alg: 'aes-256-gcm'                // unchanged; provider-attested outer AEAD
  readonly kind?: AutoCredentialKind
  readonly hint?: Record<string, unknown>    // NEW — present for recipient-target only
}
```

The `hint` field is for recipient verifiability — a recipient can confirm "yes this was sealed against my published hint" before unsealing. Self-target entries omit it. Pre-0.2 readers ignore unknown fields, so this is back-compatible.

`SealedEnvelope` (the `_meta/sealed-passphrase` envelope used by managed-mode vaults, NOT the bundle entry) is unchanged — recipient-target sealing is a bundle-level concept; vault-level sealing always operates on the vault owner's own provider.

**Hybrid scheme — internal to the provider's opaque bytes.** RSA-OAEP-SHA256 cannot encrypt arbitrary-length plaintext (limited to ~190 bytes at 2048-bit). `MemoryRecipientSealer.sealForRecipient(plaintext, hint)` mints a fresh 32-byte CEK, AES-GCM-encrypts the plaintext under it, RSA-OAEP-wraps the CEK with the recipient's public key, and concatenates a self-describing TLV into the returned `Uint8Array`:

```
byte  0       : version (0x01)
bytes 1..256  : RSA-OAEP-wrapped CEK (fixed 256 bytes at RSA-2048)
bytes 257..268: AES-GCM IV (12 bytes)
bytes 269..   : AES-GCM ciphertext ‖ 16-byte tag
```

`MemoryRecipientSealer.unseal(bytes)` parses the TLV, RSA-unwraps the CEK with its private key, AES-GCM-decrypts. The bundle layer is unaware of any of this — it just stores the base64 and dispatches by `pid`. Future cloud-provider implementations (`at-aws-kms`, etc.) are free to use their own opaque layouts; the only contract is that `sealForRecipient(p, hint).then(unseal)` is the identity.

## 7. `MemoryRecipientSealer` reference implementation

In `packages/hub/src/team/managed-passphrase.ts`, next to `MemorySealingKeyProvider`. Implements **both** `SealingKeyProvider` and `RecipientSealer` — a single instance generates an RSA-2048 keypair on construction, can publish its own hint, can seal under any other instance's hint, and can unseal envelopes addressed to its own `pid`.

```ts
export class MemoryRecipientSealer implements SealingKeyProvider, RecipientSealer {
  readonly id: string
  private readonly keypair: Promise<CryptoKeyPair>

  constructor(opts: { id: string }) {
    this.id = opts.id
    this.keypair = crypto.subtle.generateKey(
      { name: 'RSA-OAEP', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
      true, ['encrypt', 'decrypt'],
    ) as Promise<CryptoKeyPair>
  }

  async publishRecipientHint(): Promise<RecipientHint> { /* export SPKI PEM */ }
  async sealForRecipient(plaintext: Uint8Array, hint: RecipientHint): Promise<Uint8Array> { /* import pem, hybrid encrypt, return TLV bytes */ }
  async seal(plaintext: Uint8Array): Promise<Uint8Array> { /* self-target: sealForRecipient against own published hint */ }
  async unseal(bytes: Uint8Array): Promise<Uint8Array> { /* parse TLV, RSA-unwrap CEK, AES-GCM decrypt */ }
}
```

`seal()` (the `SealingKeyProvider` self-target operation) is implemented as `sealForRecipient(plaintext, await this.publishRecipientHint())` — convenient for tests that need a provider that can do both ends, mirrors how `at-aws-kms` (which has both interfaces) will behave.

## 8. Validation

In `validateAutoUnlockOptions`:

- The existing `mode: 'self-target'` arm: unchanged.
- New `mode: 'recipient-target'` arm: verify `typeof provider.publishRecipientHint === 'function' && typeof provider.sealForRecipient === 'function'` (runtime guard for JS callers; TS callers can't reach this without satisfying `RecipientSealer`). Verify every `perUser[userId].hint` is present, well-formed (`v === 1`, supported `alg`), and that `hint.pid` is a non-empty string identifying the recipient (the dispatch key the reader's `pid` lookup matches against the recipient's local provider). NOTE: `hint.pid` deliberately need not match the sender's `provider.id` — in recipient-target mode the sender and recipient are different parties.
- The previous "deferred per foundation §11.4" `ValidationError` is removed.
- Cross-arm mutual-exclusion with `autoCredentials` / `autoPassphrases` / `sealedPassphrases` is unchanged.

## 9. Read-side API

API surface unchanged. The recipient calls `readNoydbBundle(bytes, { sealingProviders: [memoryRecipientSealerInstance] })` exactly as for self-target bundles. `pid` dispatch finds the matching provider; the provider's `unseal()` implementation transparently parses the hybrid TLV inside the opaque `sealed` bytes (RSA-OAEP-unwrap CEK, then AES-GCM-decrypt) — entirely internal to the provider, the bundle layer sees only opaque `Uint8Array`. No new option or code path in the bundle reader itself — the hybrid handling lives entirely inside the provider's `unseal()`.

## 10. Test plan

New describe block `recipient-target sealedCredentials` in `packages/hub/__tests__/bundle-auto-unlock.test.ts`:

1. **happy path** — two `MemoryRecipientSealer` instances (`alice-rs`, `bob-rs`), each publishes a hint, sender writes bundle with `mode: 'recipient-target'` and the two hints, two readers unseal under their respective providers, each gets the right plaintext.
2. **missing hint** — a per-user entry without `hint` → write-side `ValidationError` citing the offending `userId`.
3. **mismatched alg** — `hint.alg !== 'rsa-oaep-sha256'` → write-side `ValidationError`. (The shipped design intentionally does NOT enforce `hint.pid === provider.id`, since sender and recipient are different parties.)
4. **wrong recipient** — third-party provider (different keypair) tries to unseal → AES-GCM auth-tag failure surfaced as the standard unseal error.
5. **mode mismatch** — passing `mode: 'recipient-target'` with a self-only provider (no `publishRecipientHint`/`sealForRecipient`) → runtime `ValidationError`. (TS callers can't reach this; covered for JS interop.)
6. **wire-format back-compat** — a bundle written with `mode: 'self-target'` reads unchanged (no `hint` field, no `wrappedKey` field).
7. **hint round-trip** — verifiability is covered implicitly by the wrong-recipient test (different keypair → AES-GCM auth-tag failure); an explicit `entry.hint?.pid === recipient.id` round-trip test is a follow-up for the cloud-KMS slices.

`MemoryRecipientSealer` itself gets a focused unit test (round-trip seal/unseal, wrong-key failure).

## 11. Files touched

| File | Change |
|---|---|
| `packages/hub/src/team/managed-passphrase.ts` | `RecipientHint` type, `RecipientSealer` interface, `MemoryRecipientSealer` class. |
| `packages/hub/src/bundle/bundle.ts` | `sealedCredentials.mode: 'recipient-target'` arm. `SealedAutoUnlockEntry.hint?` field. `validateAutoUnlockOptions` recipient-target arm + removal of "deferred per §11.4" `ValidationError`. Write-side hybrid encrypt path. |
| `packages/hub/src/index.ts` | Re-export `RecipientHint`, `RecipientSealer`, `MemoryRecipientSealer`. |
| `packages/hub/__tests__/bundle-auto-unlock.test.ts` | New `recipient-target sealedCredentials` describe block (7 tests). |
| `packages/hub/__tests__/managed-passphrase.test.ts` | `MemoryRecipientSealer` unit test (round-trip seal/unseal, wrong-key failure). |
| `features.yaml` | Update the existing `bundle-auto-unlock` feature row to reflect `recipient-target` capability. Reference this spec under `specs:`. |
| `docs/subsystems/bundle.md` | One-paragraph note on recipient-target with link to this spec and foundation §11.4. (Skipped if the file doesn't exist; deferred to a follow-up if so. Verify at implementation time.) |

## 12. Follow-ups (NOT in this PR)

- `at-aws-kms` `RecipientSealer` implementation using KMS asymmetric encrypt (`Encrypt` API, `EncryptionAlgorithm: 'RSAES_OAEP_SHA_256'`). New issue.
- `at-azure-keyvault` `RecipientSealer` using RSA Key Vault `wrapKey` / `unwrapKey`. New issue.
- `at-gcp-kms` `RecipientSealer` using asymmetric Cloud KMS `asymmetricDecrypt`. New issue.
- `RecipientHint.alg = 'kms-encrypt-cross-account'` (AWS KMS grant-based seal where the sender doesn't see the public key). Per-package design decision.
- `MultiRecipientSealer` interface (seal a single bundle CEK once, wrap it N times under N recipient hints). Foundation §11.4 future.
- In-vault hint discovery: read recipient hints from `_meta/user/<keyringId>` so the sender doesn't need to handle them OOB. Foundation §11.4 future.
- Recipient-target sealing for extracted-partition bundles: lift the `bundleKind === 'extracted-partition'` ↔ `autoUnlock` mutual-exclusion under a policy flag, so the partition's `transferKey` can be delivered sealed inside the bundle rather than OOB. Separate design — security review needed because it changes the trust model of the transfer ceremony.

## 13. Risks and review points

- **Hybrid envelope correctness.** The CEK lifecycle has to be tight: minted per-seal (never reused across users), AES-GCM IV minted per-seal (never reused under the same CEK), CEK zeroed after wrapping. The reference impl pins these in code with comments.
- **Hint-mismatch detection.** `hint.pid` non-emptiness check at write time catches the "empty dispatch key" mistake. Tests cover this explicitly.
- **Read-path regressions.** Reader behaviour with multi-recipient bundles is the only meaningful new behaviour on the read path. The hint-discriminated pass-through (entries with `hint !== undefined` that don't match any provided sealing provider are surfaced as opaque base64 rather than throwing `BundleSealMismatchError`) maintains the existing inspection-mode contract for self-target bundles. Test 6 pins back-compat: a self-target bundle reads unchanged with no `hint` field on entries.
- **Algorithm scope.** Pinning `alg: 'rsa-oaep-sha256'` as the only supported algorithm in this slice avoids a premature union. The first cloud-provider follow-up will extend it (e.g. `'kms-encrypt-cross-account'`).
