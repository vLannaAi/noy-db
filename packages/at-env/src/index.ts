/**
 * **@noy-db/at-env** — env-var sealing key provider for noy-db
 * managed-secret mode.
 *
 * The smallest production-shape provider in the `at-*` family. Reads a
 * 32-byte AES-256-GCM key from an environment variable (base64-encoded)
 * and uses it to seal / unseal the hub-generated random secret.
 *
 * ## When to use
 *
 * - Single-node SaaS where the env var comes from Kubernetes Secrets,
 *   Heroku env, Doppler, AWS Secrets Manager (mounted at boot), systemd
 *   service env, etc. — anywhere your platform already manages secrets.
 * - Local dev / CI where you want persistence across process restarts
 *   (which `MemorySealer` from `@noy-db/hub` can't do).
 * - Prototypes where setting up AWS KMS / GCP KMS isn't worth the effort.
 *
 * ## When NOT to use
 *
 * - Laptops / shared dev machines where other users have shell access.
 *   They can `echo $NOYDB_SEALING_KEY` and exfiltrate the key. Use
 *   `@noy-db/at-macos-keychain` / `@noy-db/at-wincred` /
 *   `@noy-db/at-libsecret` for desktop apps.
 * - Compliance regimes requiring auditable key access (FedRAMP, HIPAA
 *   with managed-encryption requirements). Use `@noy-db/at-aws-kms` for
 *   KMS-backed key access logs.
 *
 * ## Setup
 *
 * ```bash
 * # 1. Generate a 256-bit key once. Store in your platform's secret manager.
 * export NOYDB_SEALING_KEY=$(openssl rand -base64 32)
 * ```
 *
 * ```ts
 * // 2. In your app:
 * import { createNoydb } from '@noy-db/hub'
 * import { envSealingProvider } from '@noy-db/at-env'
 *
 * const db = await createNoydb({
 *   store,
 *   user: 'alice',
 *   secretMode: 'managed',
 *   sealingKey: envSealingProvider(),  // reads NOYDB_SEALING_KEY by default
 * })
 * ```
 *
 * @packageDocumentation
 */

import type { NoydbSealer } from '@noy-db/hub'

/** Options for {@link envSealingProvider}. */
export interface EnvSealingProviderOptions {
  /**
   * Environment variable name holding the base64-encoded 32-byte AES-256
   * key. Default `'NOYDB_SEALING_KEY'`.
   */
  readonly envVar?: string
}

/**
 * Build a {@link NoydbSealer} backed by an environment variable.
 *
 * The env var must contain a base64-encoded 32-byte (256-bit) key. The
 * provider validates the value at construction time and caches the
 * imported `CryptoKey` for the lifetime of the instance.
 *
 * @throws Error when the env var is unset, not base64, or not 32 bytes.
 */
export function envSealingProvider(
  opts: EnvSealingProviderOptions = {},
): NoydbSealer {
  const envVar = opts.envVar ?? 'NOYDB_SEALING_KEY'
  const raw = process.env[envVar]
  if (!raw) {
    throw new Error(
      `@noy-db/at-env: env var "${envVar}" is not set. Generate a key via `
      + '`openssl rand -base64 32` and export it before starting the process.',
    )
  }

  let keyBytes: Uint8Array
  try {
    keyBytes = base64ToBytes(raw)
  } catch (err) {
    throw new Error(
      `@noy-db/at-env: env var "${envVar}" is not valid base64 — `
      + (err instanceof Error ? err.message : String(err)),
    )
  }

  if (keyBytes.length !== 32) {
    throw new Error(
      `@noy-db/at-env: env var "${envVar}" decodes to ${keyBytes.length} bytes; `
      + 'expected 32 bytes (256-bit AES key). Regenerate via `openssl rand -base64 32`.',
    )
  }

  // Lazy + cached import — the CryptoKey is created on first seal/unseal
  // and reused for the lifetime of the provider instance.
  let cachedKey: Promise<CryptoKey> | null = null
  const getKey = (): Promise<CryptoKey> => {
    if (!cachedKey) {
      cachedKey = globalThis.crypto.subtle.importKey(
        'raw',
        keyBytes as unknown as BufferSource,
        'AES-GCM',
        false,
        ['encrypt', 'decrypt'],
      )
    }
    return cachedKey
  }

  return {
    id: `env:${envVar}`,

    async seal(secret: Uint8Array): Promise<Uint8Array> {
      const key = await getKey()
      const iv = globalThis.crypto.getRandomValues(new Uint8Array(12))
      const ciphertext = await globalThis.crypto.subtle.encrypt(
        { name: 'AES-GCM', iv: iv as BufferSource },
        key,
        secret as unknown as BufferSource,
      )
      // Output format: [12-byte IV][ciphertext + 16-byte GCM tag]
      const out = new Uint8Array(12 + ciphertext.byteLength)
      out.set(iv, 0)
      out.set(new Uint8Array(ciphertext), 12)
      return out
    },

    async unseal(sealed: Uint8Array): Promise<Uint8Array> {
      // 12-byte IV + ≥ 16-byte GCM tag minimum.
      if (sealed.length < 12 + 16) {
        throw new Error(
          `@noy-db/at-env: sealed bytes too short (${sealed.length} < 28). `
          + 'Input is not a valid at-env-sealed envelope.',
        )
      }
      const iv = sealed.subarray(0, 12)
      const body = sealed.subarray(12)
      const key = await getKey()
      const plaintext = await globalThis.crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: iv as BufferSource },
        key,
        body as unknown as BufferSource,
      )
      return new Uint8Array(plaintext)
    },
  }
}

// ─── base64 helpers (browser + node + cf-workers compatible) ──────────

function base64ToBytes(b64: string): Uint8Array {
  // Reject obviously malformed strings before atob throws InvalidCharacterError,
  // so the wrapping error message is informative.
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64.trim())) {
    throw new Error('input contains characters outside the base64 alphabet')
  }
  const binary = atob(b64)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}
