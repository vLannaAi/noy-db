/**
 * **@noy-db/at-aws-kms** — AWS KMS sealing key provider for noy-db
 * managed-passphrase mode (#188).
 *
 * An `at-*` provider that seals and unseals the hub-generated random
 * passphrase via AWS KMS Encrypt / Decrypt. Every seal and unseal is an
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
 *   passphraseMode: 'managed',
 *   sealingKey: awsKmsSealingProvider({ keyId: 'arn:aws:kms:us-east-1:123:key/abc' }),
 *   shamirRecovery: shamirRecoveryProvider(),
 * })
 * ```
 *
 * @packageDocumentation
 */

import type { SealingKeyProvider } from '@noy-db/hub'
import {
  KMSClient,
  EncryptCommand,
  DecryptCommand,
  type EncryptCommandOutput,
  type DecryptCommandOutput,
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

    async seal(passphrase) {
      const out: EncryptCommandOutput = await client.send(
        new EncryptCommand({ KeyId: opts.keyId, Plaintext: passphrase }),
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
