/**
 * Managed-passphrase mode — issue #14, rubber-hose-resistant vaults.
 *
 * A vault mode where the passphrase is machine-generated and never
 * exposed to the user, sealed under a developer-provided
 * {@link SealingKeyProvider} (macOS Keychain, Windows Credential
 * Manager, libsecret, AWS KMS, …). The user has no secret to give
 * up to coercion — they can't reveal what they don't know.
 *
 * ## Components in this file
 *
 *   - {@link SealingKeyProvider} — the interface concrete providers
 *     implement. Provider implementations live OUTSIDE hub (per-
 *     platform packages).
 *   - {@link MemorySealingKeyProvider} — in-memory test provider; uses
 *     a deterministic per-instance "key" so two providers with
 *     different ids cannot unseal each other's outputs.
 *   - {@link loadSealedPassphrase} / {@link saveSealedPassphrase} —
 *     plaintext envelope storage at `_meta/sealed-passphrase`.
 *     Mirrors the `_meta/handle` and `_meta/public-envelope` AES-
 *     GCM-bypassed patterns. The sealing layer (provider's job)
 *     is the security boundary; hub doesn't have a key to encrypt
 *     with at this layer — that's the whole point of the design.
 *   - {@link resolveManagedSecret} — orchestrates the "generate +
 *     seal + persist on first open; unseal on reopen" flow.
 *     Returns the plaintext passphrase string that the rest of the
 *     `createNoydb` keyring path consumes.
 *
 * Slice 1 of #14. Deferred to follow-ups:
 *   - Block `rotate-passphrase` policy gate under managed mode.
 *   - Mandatory strong-recovery enforcement (depends on #10).
 *   - Recovery flow under managed mode (generates fresh sealed phrase).
 *
 * @see docs/subsystems/session-tiers.md → Managed-passphrase mode
 *
 * @module
 */

import type { NoydbStore, EncryptedEnvelope } from '../types.js'
import { NOYDB_FORMAT_VERSION } from '../types.js'

/**
 * The contract concrete providers (per-platform key stores) implement
 * to seal and unseal a hub-generated random passphrase. The plaintext
 * passphrase NEVER leaves hub-controlled memory in unsealed form —
 * the provider receives the bytes, returns opaque sealed bytes, and
 * later reverses the operation. Hub treats the sealed bytes as
 * fully opaque.
 *
 * Implementations live OUTSIDE `@noy-db/hub` (separate packages
 * per the issue's "Concrete providers (live outside hub)" note):
 *
 * | Platform | Package (TBD) | Backing |
 * |---|---|---|
 * | macOS | `@noy-db/seal-macos-keychain` | Security.framework |
 * | Windows | `@noy-db/seal-wincred` | Credential Manager |
 * | Linux | `@noy-db/seal-libsecret` | libsecret / secret-service |
 * | Cloud / server | `@noy-db/seal-aws-kms` | AWS KMS Decrypt |
 */
export interface SealingKeyProvider {
  /**
   * Non-sensitive identifier disclosed in the persisted envelope.
   * Surfaced to consumers via `loadSealedPassphrase().providerId` so
   * a vault opened with the wrong provider class can detect the
   * mismatch and surface a clear error. NOT secret — fine to log.
   *
   * Suggested format: `<family>:<scope>` — e.g. `macos-keychain:com.acme.app`,
   * `aws-kms:arn:aws:kms:us-east-1:123:key/abc`. The hub never
   * parses this; it's purely audit metadata.
   */
  readonly id: string

  /** Seal raw passphrase bytes. Output bytes are opaque to hub. */
  seal(passphrase: Uint8Array): Promise<Uint8Array>

  /**
   * Reverse {@link seal}. MUST throw on tamper, wrong-provider, or
   * any other failure — hub treats a thrown error as "this provider
   * cannot unlock this vault" and surfaces it to the caller.
   */
  unseal(sealed: Uint8Array): Promise<Uint8Array>
}

/**
 * In-memory test provider. NOT secure — uses a deterministic
 * per-instance "key" (16-byte SHA-256 of `id`) XOR'd over the
 * passphrase plus a 4-byte provider-id fingerprint prefix. The XOR is
 * sufficient to make different `id` values produce mutually-unsealable
 * outputs (the contract tests for that), but offers ZERO real
 * confidentiality — never use outside tests.
 *
 * Replace with a real platform provider in production.
 */
export class MemorySealingKeyProvider implements SealingKeyProvider {
  readonly id: string
  private readonly fingerprint: Uint8Array
  private readonly keyBytes: Uint8Array

  constructor(opts: { id: string }) {
    this.id = opts.id
    // Deterministic 4-byte fingerprint of the provider id, prepended
    // to every sealed output so we can detect "wrong provider" at
    // unseal time without leaking anything sensitive about either
    // provider's actual key material.
    const encoded = new TextEncoder().encode(opts.id)
    let h = 0
    for (let i = 0; i < encoded.length; i++) {
      h = (h * 31 + encoded[i]!) >>> 0
    }
    this.fingerprint = new Uint8Array([
      (h >>> 24) & 0xff, (h >>> 16) & 0xff, (h >>> 8) & 0xff, h & 0xff,
    ])
    // Deterministic 16-byte "key" derived from the id by repeating
    // the fingerprint with offsets. Good enough for the XOR-stream
    // test cipher; never confuse this with real key derivation.
    this.keyBytes = new Uint8Array(16)
    for (let i = 0; i < 16; i++) {
      this.keyBytes[i] = this.fingerprint[i % 4]! ^ (i * 17)
    }
  }

  async seal(passphrase: Uint8Array): Promise<Uint8Array> {
    const out = new Uint8Array(4 + passphrase.length)
    out.set(this.fingerprint, 0)
    for (let i = 0; i < passphrase.length; i++) {
      out[4 + i] = passphrase[i]! ^ this.keyBytes[i % 16]!
    }
    return out
  }

  async unseal(sealed: Uint8Array): Promise<Uint8Array> {
    if (sealed.length < 4) {
      throw new Error('MemorySealingKeyProvider: sealed input too short')
    }
    for (let i = 0; i < 4; i++) {
      if (sealed[i] !== this.fingerprint[i]) {
        throw new Error(
          `MemorySealingKeyProvider("${this.id}"): provider-id mismatch on unseal `
          + '(sealed bytes were produced by a different provider)',
        )
      }
    }
    const body = sealed.subarray(4)
    const out = new Uint8Array(body.length)
    for (let i = 0; i < body.length; i++) {
      out[i] = body[i]! ^ this.keyBytes[i % 16]!
    }
    return out
  }
}

// ─── Persisted envelope ────────────────────────────────────────────────

/** Reserved id for the managed-passphrase envelope under `_meta`. */
export const SEALED_PASSPHRASE_RECORD_ID = 'sealed-passphrase' as const

/** Plaintext payload stored inside the `_meta/sealed-passphrase` envelope. */
export interface SealedPassphrase {
  readonly _noydb_sealed: 1
  readonly providerId: string
  /** Sealed bytes. Base64-encoded on the wire; decoded on load. */
  readonly sealed: Uint8Array
}

/**
 * Wire-format envelope persisted at `_meta/sealed-passphrase` for
 * managed-mode vaults. The provider produces raw sealed bytes via
 * {@link SealingKeyProvider.seal}; this wrapper carries the dispatch
 * metadata hub needs to pick the right provider on the unseal path.
 *
 * Stability boundary: once shipped, the wire format only grows by
 * adding optional fields. See the at-* sealing dimension foundation
 * doc, §11.9.1.
 *
 * v1 shape (this release): `{ v: 1, _noydb_sealed: 1, pid, payload }`.
 *
 * Legacy shape (pre.14, pre.15): `{ _noydb_sealed: 1, providerId, sealed }`
 * — accepted on read for backwards compatibility; never produced on
 * write going forward.
 */
export interface SealedEnvelope {
  /** Envelope schema version. v1 is the shape shipped in pre.16. */
  readonly v: 1
  /** Magic marker for forensics + legacy-shape detection. */
  readonly _noydb_sealed: 1
  /** Matches the producing provider's `.id`. Dispatch key on unseal. */
  readonly pid: string
  /** Sealed bytes from the provider, base64-encoded on the wire. */
  readonly payload: string
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!)
  return btoa(binary)
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}

/**
 * Parse a `_meta/sealed-passphrase` `_data` JSON string into the
 * in-memory {@link SealedPassphrase} representation. Accepts both:
 *
 *   1. v1 wire format `{ v: 1, _noydb_sealed: 1, pid, payload }` —
 *      the shape produced from pre.16 onward.
 *   2. Legacy wire format `{ _noydb_sealed: 1, providerId, sealed }` —
 *      the shape produced in pre.14/pre.15. Read-only; never written
 *      going forward.
 *
 * Returns `undefined` for any input that doesn't match either shape,
 * so callers can fall back to "no managed-mode envelope present."
 *
 * @internal — exported only for the migration safety-net test suite.
 */
export function parseSealedEnvelope(raw: unknown): SealedPassphrase | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const r = raw as Record<string, unknown>
  if (r._noydb_sealed !== 1) return undefined

  // v1 shape — preferred.
  if (
    r.v === 1
    && typeof r.pid === 'string'
    && typeof r.payload === 'string'
  ) {
    return {
      _noydb_sealed: 1,
      providerId: r.pid,
      sealed: base64ToBytes(r.payload),
    }
  }

  // Legacy shape — pre.14 / pre.15. Accept on read for compat.
  if (
    typeof r.providerId === 'string'
    && typeof r.sealed === 'string'
  ) {
    return {
      _noydb_sealed: 1,
      providerId: r.providerId,
      sealed: base64ToBytes(r.sealed),
    }
  }

  return undefined
}

export async function saveSealedPassphrase(
  store: NoydbStore,
  vault: string,
  payload: { readonly providerId: string; readonly sealed: Uint8Array },
): Promise<void> {
  const persisted: SealedEnvelope = {
    v: 1,
    _noydb_sealed: 1,
    pid: payload.providerId,
    payload: bytesToBase64(payload.sealed),
  }
  const prior = await store.get(vault, '_meta', SEALED_PASSPHRASE_RECORD_ID)
  const env: EncryptedEnvelope = {
    _noydb: NOYDB_FORMAT_VERSION,
    _v: (prior?._v ?? 0) + 1,
    _ts: new Date().toISOString(),
    // AES-GCM bypassed — the sealing layer is the security boundary.
    _iv: '',
    _data: JSON.stringify(persisted),
  }
  await store.put(vault, '_meta', SEALED_PASSPHRASE_RECORD_ID, env)
}

export async function loadSealedPassphrase(
  store: NoydbStore,
  vault: string,
): Promise<SealedPassphrase | undefined> {
  const envelope = await store.get(vault, '_meta', SEALED_PASSPHRASE_RECORD_ID)
  if (!envelope) return undefined
  try {
    return parseSealedEnvelope(JSON.parse(envelope._data))
  } catch {
    return undefined
  }
}

// ─── createNoydb orchestration ─────────────────────────────────────────

/**
 * Resolve the effective plaintext passphrase string for a managed-mode
 * vault. Two paths:
 *
 *   1. **First open (no envelope persisted):** generate a 256-bit random
 *      via `crypto.getRandomValues`, base64-encode for use as a
 *      passphrase string, seal the underlying bytes under the
 *      provider, persist `_meta/sealed-passphrase`, return the
 *      base64 string.
 *
 *   2. **Reopen (envelope exists):** read + unseal + decode → return.
 *      A different provider whose `seal` output disagrees on the
 *      stored bytes throws here, surfaced as a clear error.
 *
 * The returned string is the same shape that `secret:` would take in
 * standard mode — the rest of the keyring path consumes it
 * unchanged.
 *
 * @internal — called from `createNoydb` / `getKeyringInternal`.
 */
export async function resolveManagedSecret(
  store: NoydbStore,
  vault: string,
  provider: SealingKeyProvider,
): Promise<string> {
  const existing = await loadSealedPassphrase(store, vault)
  if (existing) {
    if (existing.providerId !== provider.id) {
      throw new Error(
        `Managed-mode vault "${vault}" was sealed under provider id `
        + `"${existing.providerId}" but the current SealingKeyProvider is `
        + `"${provider.id}". Pass the same provider that originally enrolled `
        + 'the vault, or treat this as a fresh enrollment and clear '
        + '`_meta/sealed-passphrase` first.',
      )
    }
    const plaintext = await provider.unseal(existing.sealed)
    return bytesToBase64(plaintext)
  }

  // First open: mint a 256-bit random, seal, persist.
  const random = new Uint8Array(32)
  globalThis.crypto.getRandomValues(random)
  const sealed = await provider.seal(random)
  await saveSealedPassphrase(store, vault, { providerId: provider.id, sealed })
  return bytesToBase64(random)
}
