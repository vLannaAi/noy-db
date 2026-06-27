/**
 * **@noy-db/at-azure-keyvault** — Azure Key Vault sealing key provider for noy-db
 * managed-passphrase mode.
 *
 * An `at-*` provider that seals and unseals the hub-generated random
 * passphrase via Azure Key Vault Encrypt / Decrypt. Every seal and unseal is
 * an authenticated Key Vault API call, giving you an Azure Monitor / Key Vault
 * audit-log-backed access record of every time a user's vault is opened —
 * no additional instrumentation required.
 *
 * ## When to use
 *
 * - Compliance regimes requiring auditable key access logs (FedRAMP, HIPAA
 *   with managed-encryption requirements, SOC 2 Type II).
 * - Workloads already running on Azure where a Key Vault RSA key costs less
 *   than engineering an equivalent audit trail.
 * - Any case where you need an auditable, Azure-native key custody record
 *   for every vault open.
 *
 * ## Setup
 *
 * ```bash
 * # 1. Create a Key Vault and an RSA key (one-time):
 * az keyvault create --name my-noydb-vault --resource-group my-rg --location eastus
 * az keyvault key create --vault-name my-noydb-vault --name noydb-sealing --kty RSA --size 2048
 * # Note the full key identifier URL from the output (id field).
 *
 * # 2. Grant the host's managed identity or service principal the
 * #    encrypt + decrypt (or wrapKey + unwrapKey) permissions on the key:
 * az keyvault set-policy --name my-noydb-vault \
 *   --object-id <MANAGED_IDENTITY_OBJECT_ID> \
 *   --key-permissions encrypt decrypt
 * # Credentials are resolved automatically via DefaultAzureCredential:
 * # managed identity attached to the Azure host, AZURE_CLIENT_ID /
 * # AZURE_TENANT_ID / AZURE_CLIENT_SECRET env vars, or `az login` for
 * # local dev.
 * ```
 *
 * ```ts
 * // 3. In your app:
 * import { createNoydb } from '@noy-db/hub'
 * import { azureKeyVaultSealingProvider } from '@noy-db/at-azure-keyvault'
 * import { shamirRecoveryProvider } from '@noy-db/on-shamir'
 *
 * const db = await createNoydb({
 *   store,
 *   user: 'alice',
 *   passphraseMode: 'managed',
 *   sealingKey: azureKeyVaultSealingProvider({
 *     keyId: 'https://my-noydb-vault.vault.azure.net/keys/noydb-sealing/<version>',
 *   }),
 *   shamirRecovery: shamirRecoveryProvider(),
 * })
 * ```
 *
 * @packageDocumentation
 */

import type { SealingKeyProvider } from '@noy-db/hub'
import {
  CryptographyClient,
  type EncryptResult,
  type DecryptResult,
  type RsaEncryptParameters,
  type RsaDecryptParameters,
} from '@azure/keyvault-keys'
import { DefaultAzureCredential } from '@azure/identity'

/** Minimal client surface required by {@link azureKeyVaultSealingProvider}. */
interface CryptoLike {
  encrypt(params: RsaEncryptParameters): Promise<EncryptResult>
  decrypt(params: RsaDecryptParameters): Promise<DecryptResult>
}

/** Options for {@link azureKeyVaultSealingProvider}. */
export interface AzureKeyVaultSealingProviderOptions {
  /**
   * Full **versioned** key identifier URL, e.g.
   * `https://<vault>.vault.azure.net/keys/<name>/<version>`.
   *
   * Azure RSA decrypt is version-bound: the `CryptographyClient` resolves the
   * key version at construction time and every decrypt call is pinned to it.
   * A versionless URL (`.../keys/<name>`) resolves to "latest" — if the key
   * auto-rotates, all passphrases sealed under the previous version become
   * **permanently undecryptable**. Always pin to an explicit version.
   */
  readonly keyId: string
  /** RSA encryption algorithm. Defaults to `'RSA-OAEP-256'`. */
  readonly algorithm?: 'RSA-OAEP-256' | 'RSA-OAEP'
  /**
   * Optional pre-built CryptographyClient (DI for tests).
   * Default: builds one with `DefaultAzureCredential`.
   * Never pass raw Azure credentials in these options.
   */
  readonly cryptographyClient?: CryptoLike
}

/**
 * Build a {@link SealingKeyProvider} backed by Azure Key Vault Encrypt / Decrypt.
 *
 * Credentials are resolved via `DefaultAzureCredential` — managed identities
 * on Azure hosts, `AZURE_CLIENT_ID` / `AZURE_TENANT_ID` / `AZURE_CLIENT_SECRET`
 * env vars, or `az login` for local dev. Never pass raw credentials in the
 * options; inject a pre-configured `CryptographyClient` for non-default auth
 * instead.
 *
 * @throws Error when Key Vault returns no result (guards against unexpected
 * SDK-response shapes). Any Key Vault API error (Forbidden, NotFound, etc.)
 * propagates as-is.
 */
export function azureKeyVaultSealingProvider(opts: AzureKeyVaultSealingProviderOptions): SealingKeyProvider {
  const algorithm = opts.algorithm ?? 'RSA-OAEP-256'
  const client: CryptoLike = opts.cryptographyClient
    ?? new CryptographyClient(opts.keyId, new DefaultAzureCredential())

  return {
    id: `azure-kv:${opts.keyId}`,

    async seal(passphrase) {
      const res = await client.encrypt({ algorithm, plaintext: passphrase })
      const c = res?.result
      if (!c) throw new Error('@noy-db/at-azure-keyvault: Key Vault encrypt returned no result')
      return c instanceof Uint8Array ? c : new Uint8Array(c)
    },

    async unseal(sealed) {
      const res = await client.decrypt({ algorithm, ciphertext: sealed })
      const p = res?.result
      if (!p) throw new Error('@noy-db/at-azure-keyvault: Key Vault decrypt returned no result')
      return p instanceof Uint8Array ? p : new Uint8Array(p)
    },
  }
}
