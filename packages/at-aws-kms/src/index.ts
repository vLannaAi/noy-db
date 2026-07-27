/**
 * **@noy-db/at-aws-kms** — AWS KMS sealing key provider for noy-db
 * managed-secret mode.
 *
 * An `at-*` provider that seals and unseals the hub-generated random
 * secret via AWS KMS Encrypt / Decrypt. Every seal and unseal is an
 * authenticated KMS API call, giving you a CloudTrail-backed access log of
 * every time a user's vault is opened — no additional instrumentation
 * required.
 *
 * ## When to use
 *
 * - Compliance regimes requiring auditable key access logs (FedRAMP, HIPAA
 *   with managed-encryption requirements, SOC 2 Type II).
 * - Workloads already running on AWS where a KMS key costs less than
 *   engineering an equivalent audit trail.
 * - Any case where you want automatic CMK rotation without rotating your
 *   app's sealing key material manually.
 *
 * ## Setup
 *
 * ```bash
 * # 1. Create a KMS key (one-time, in your AWS console or CLI):
 * aws kms create-key --description "noy-db sealing key"
 * # Note the KeyId/ARN from the output.
 *
 * # 2. Grant the host's IAM role kms:Encrypt + kms:Decrypt on that key.
 * # Credentials are picked up automatically from the SDK's ambient chain
 * # (IAM role, ~/.aws/credentials, env vars — see AWS SDK docs).
 * ```
 *
 * ```ts
 * // 3. In your app:
 * import { createNoydb } from '@noy-db/hub'
 * import { awsKmsSealingProvider } from '@noy-db/at-aws-kms'
 * import { shamirRecoveryProvider } from '@noy-db/on-shamir'
 *
 * const db = await createNoydb({
 *   store,
 *   user: 'alice',
 *   secretMode: 'managed',
 *   sealingKey: awsKmsSealingProvider({ keyId: 'arn:aws:kms:us-east-1:123:key/abc' }),
 *   shamirRecovery: shamirRecoveryProvider(),
 * })
 * ```
 *
 * @packageDocumentation
 */

import type { SealingKeyProvider, RecipientSealer, RecipientHint } from '@noy-db/hub'
import { sealRsaOaepTlv, parseRsaOaepTlv, aesGcmOpen } from '@noy-db/hub'
import {
  KMSClient,
  EncryptCommand,
  DecryptCommand,
  GetPublicKeyCommand,
  type EncryptCommandOutput,
  type DecryptCommandOutput,
  type GetPublicKeyCommandOutput,
} from '@aws-sdk/client-kms'

/** Options for {@link awsKmsSealingProvider}. */
export interface AwsKmsSealingProviderOptions {
  /** KMS key id or ARN (e.g. `arn:aws:kms:us-east-1:123:key/abc`). */
  readonly keyId: string
  /** Optional pre-built client (DI for tests). Default `new KMSClient({})` (ambient creds). */
  readonly client?: Pick<KMSClient, 'send'>
}

/**
 * Build a {@link SealingKeyProvider} backed by AWS KMS Encrypt / Decrypt.
 *
 * Credentials are resolved by the SDK's ambient chain — IAM instance roles,
 * environment variables, or `~/.aws/credentials`. Never pass raw credentials
 * in the options; inject a pre-configured client for non-default auth instead.
 *
 * @throws Error when KMS returns no ciphertext or no plaintext (guards
 * against unexpected SDK-response shapes).
 * Any KMS API error (AccessDenied, InvalidKeyUsage, etc.) propagates as-is.
 */
export function awsKmsSealingProvider(opts: AwsKmsSealingProviderOptions): SealingKeyProvider {
  const client = opts.client ?? new KMSClient({})
  return {
    id: `aws-kms:${opts.keyId}`,

    async seal(secret) {
      const out: EncryptCommandOutput = await client.send(
        new EncryptCommand({ KeyId: opts.keyId, Plaintext: secret }),
      )
      const blob = out.CiphertextBlob
      if (!blob) throw new Error('@noy-db/at-aws-kms: KMS Encrypt returned no CiphertextBlob')
      return blob instanceof Uint8Array ? blob : new Uint8Array(blob)
    },

    async unseal(sealed) {
      const out: DecryptCommandOutput = await client.send(
        new DecryptCommand({ CiphertextBlob: sealed, KeyId: opts.keyId }),
      )
      const pt = out.Plaintext
      if (!pt) throw new Error('@noy-db/at-aws-kms: KMS Decrypt returned no Plaintext')
      return pt instanceof Uint8Array ? pt : new Uint8Array(pt)
    },
  }
}

/** Options for {@link awsKmsRecipientSealer}. */
export interface AwsKmsRecipientSealerOptions {
  /**
   * KMS key id or ARN of an **asymmetric RSA** key with `KeyUsage:
   * ENCRYPT_DECRYPT` and `KeySpec` one of `RSA_2048` / `RSA_3072` /
   * `RSA_4096`. The private key never leaves KMS — unseal runs `Decrypt`.
   */
  readonly keyId: string
  /** Optional region passed to the default `KMSClient` when no `client` is given. */
  readonly region?: string
  /** Optional pre-built client (DI for tests). Default `new KMSClient({ region? })` (ambient creds). */
  readonly client?: Pick<KMSClient, 'send'>
}

/** KMS asymmetric key specs this recipient sealer accepts (RSA-OAEP-SHA256 wrap). */
const SUPPORTED_RSA_KEY_SPECS = new Set(['RSA_2048', 'RSA_3072', 'RSA_4096'])

/** DER SPKI bytes (from KMS `GetPublicKey`) → PEM SubjectPublicKeyInfo. */
function derSpkiToPem(der: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < der.length; i++) binary += String.fromCharCode(der[i]!)
  const b64 = btoa(binary)
  return '-----BEGIN PUBLIC KEY-----\n'
    + (b64.match(/.{1,64}/g) ?? []).join('\n')
    + '\n-----END PUBLIC KEY-----\n'
}

/**
 * A {@link RecipientSealer} (plus `unseal`) backed by an **asymmetric RSA**
 * AWS KMS key. Lets an `at-aws-kms` host act as a recipient target: a grantor
 * obtains the host's published {@link RecipientHint} (the KMS public key as
 * PEM) and seals bytes to it *locally* — no KMS call on the seal path. The
 * host unseals via KMS `Decrypt` with `EncryptionAlgorithm:
 * RSAES_OAEP_SHA_256`; the private key never leaves KMS.
 *
 * Wire format is the canonical recipient-target TLV
 * ({@link sealRsaOaepTlv}/{@link parseRsaOaepTlv}) shared with hub's
 * `MemoryRecipientSealer`, so a blob sealed by either side unseals on the
 * other. WebCrypto RSA-OAEP/SHA-256 and KMS `RSAES_OAEP_SHA_256` are
 * wire-compatible (RSAES-OAEP, SHA-256, MGF1-SHA256, empty label). KMS
 * asymmetric keys do not support an encryption context, so none is used.
 *
 * Separate from {@link awsKmsSealingProvider} (symmetric self-seal for the
 * managed secret) — this factory targets an asymmetric key.
 *
 * @throws Error from `publishRecipientHint` when the key is not an RSA
 * `ENCRYPT_DECRYPT` key, or `GetPublicKey` returns no public key.
 * @throws Error from `sealForRecipient` on an unsupported `hint.v`/`hint.alg`.
 * Any KMS API error (AccessDenied, etc.) propagates as-is.
 */
export function awsKmsRecipientSealer(
  opts: AwsKmsRecipientSealerOptions,
): RecipientSealer & { unseal(sealed: Uint8Array): Promise<Uint8Array> } {
  const client = opts.client ?? new KMSClient(opts.region ? { region: opts.region } : {})
  const id = `aws-kms-recipient:${opts.keyId}`
  return {
    id,

    async publishRecipientHint(): Promise<RecipientHint> {
      const out: GetPublicKeyCommandOutput = await client.send(
        new GetPublicKeyCommand({ KeyId: opts.keyId }),
      )
      if (out.KeyUsage !== 'ENCRYPT_DECRYPT') {
        throw new Error(
          `@noy-db/at-aws-kms: awsKmsRecipientSealer requires an ENCRYPT_DECRYPT key, got KeyUsage='${String(out.KeyUsage)}' for ${opts.keyId}`,
        )
      }
      if (!out.KeySpec || !SUPPORTED_RSA_KEY_SPECS.has(out.KeySpec)) {
        throw new Error(
          `@noy-db/at-aws-kms: awsKmsRecipientSealer requires an RSA key (RSA_2048/3072/4096), got KeySpec='${String(out.KeySpec)}' for ${opts.keyId}`,
        )
      }
      const der = out.PublicKey
      if (!der) throw new Error('@noy-db/at-aws-kms: KMS GetPublicKey returned no PublicKey')
      const derBytes = der instanceof Uint8Array ? der : new Uint8Array(der)
      const publicKeyPem = derSpkiToPem(derBytes)
      return { v: 1, pid: id, alg: 'rsa-oaep-sha256', material: { publicKeyPem } }
    },

    async sealForRecipient(plaintext: Uint8Array, hint: RecipientHint): Promise<Uint8Array> {
      if (hint.v !== 1) {
        throw new Error(`@noy-db/at-aws-kms: awsKmsRecipientSealer.sealForRecipient: unsupported hint.v ${String(hint.v)} (expected 1)`)
      }
      if (hint.alg !== 'rsa-oaep-sha256') {
        throw new Error(`@noy-db/at-aws-kms: awsKmsRecipientSealer.sealForRecipient: unsupported hint.alg '${String(hint.alg)}' (expected 'rsa-oaep-sha256')`)
      }
      const pem = hint.material['publicKeyPem']
      if (typeof pem !== 'string') {
        throw new Error('@noy-db/at-aws-kms: awsKmsRecipientSealer.sealForRecipient: hint.material.publicKeyPem missing or not a string')
      }
      // Grantor seals LOCALLY — no KMS call.
      return sealRsaOaepTlv(plaintext, pem)
    },

    async unseal(sealed: Uint8Array): Promise<Uint8Array> {
      const { wrapped, iv, ct } = parseRsaOaepTlv(sealed)
      // RSA-unwrap the CEK via KMS — the private key never leaves KMS.
      const out: DecryptCommandOutput = await client.send(
        new DecryptCommand({
          KeyId: opts.keyId,
          CiphertextBlob: wrapped,
          EncryptionAlgorithm: 'RSAES_OAEP_SHA_256',
        }),
      )
      const cek = out.Plaintext
      if (!cek) throw new Error('@noy-db/at-aws-kms: KMS Decrypt returned no Plaintext (CEK)')
      const cekBytes = cek instanceof Uint8Array ? cek : new Uint8Array(cek)
      const pt = await aesGcmOpen(cekBytes, iv, ct)
      cekBytes.fill(0)
      return pt
    },
  }
}
