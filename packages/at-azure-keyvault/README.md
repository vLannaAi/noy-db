# @noy-db/at-azure-keyvault

**Azure Key Vault sealing key provider for noy-db [managed-secret mode](https://github.com/vLannaAi/noy-db/issues/14).**

An `at-*` provider that seals and unseals the hub-generated random secret via Azure Key Vault Encrypt / Decrypt. Every seal and unseal is an authenticated Key Vault API call — giving you an Azure Monitor / Key Vault audit-log-backed access record of every time a user's vault is opened, with no additional instrumentation required.

Like all `at-*` providers, this is a *trusted host* provider: the host you deploy it on CAN decrypt what it unseals. The security boundary is your Azure RBAC / Key Vault access policy — access is controlled by which managed identities or service principals hold the `encrypt` + `decrypt` key permissions on the Key Vault key, not by a secret the host keeps in memory.

## Install

```bash
pnpm add @noy-db/hub @noy-db/at-azure-keyvault @noy-db/on-shamir
# or: npm install @noy-db/hub @noy-db/at-azure-keyvault @noy-db/on-shamir
```

## Setup

```bash
# 1. Create a Key Vault and an RSA key (one-time):
az keyvault create --name my-noydb-vault --resource-group my-rg --location eastus
az keyvault key create --vault-name my-noydb-vault --name noydb-sealing --kty RSA --size 2048
# Note the full key identifier URL from the output (the "id" field).

# 2. Grant the host's managed identity or service principal encrypt + decrypt
#    key permissions on the vault:
az keyvault set-policy --name my-noydb-vault \
  --object-id <MANAGED_IDENTITY_OBJECT_ID> \
  --key-permissions encrypt decrypt
# Credentials are resolved automatically via DefaultAzureCredential:
# managed identity attached to the Azure host, AZURE_CLIENT_ID /
# AZURE_TENANT_ID / AZURE_CLIENT_SECRET env vars, or `az login` for
# local dev.
```

```ts
// 3. In your app:
import { createNoydb } from '@noy-db/hub'
import { atAzureKeyvault } from '@noy-db/at-azure-keyvault'
import { shamirRecoveryProvider } from '@noy-db/on-shamir'

const db = await createNoydb({
  store,
  user: 'alice',
  secretMode: 'managed',
  sealingKey: atAzureKeyvault({
    keyId: 'https://my-noydb-vault.vault.azure.net/keys/noydb-sealing/<version>',
  }),
  shamirRecovery: shamirRecoveryProvider(),
})

const vault = await db.openVault('acme')
// Hub generated a 256-bit random on first open, sealed it via Key Vault Encrypt,
// and persisted to _meta/sealed-secret. The user never sees a secret.
// On reopen, at-azure-keyvault calls Key Vault Decrypt transparently.
// Azure Key Vault audit logs record every Encrypt/Decrypt call with caller
// identity + key identifier.
```

## When to use this provider

- Compliance regimes requiring auditable key access logs (FedRAMP, HIPAA with managed-encryption requirements, SOC 2 Type II).
- Workloads already running on Azure where a Key Vault RSA key costs less than engineering an equivalent audit trail.
- Any case where you need an auditable, Azure-native key custody record for every vault open.

## When NOT to use this provider

- Non-Azure or multi-cloud deployments where adding an Azure dependency is undesirable. Use [`@noy-db/at-env`](../at-env) for a zero-extra-dependency option.
- Local dev / CI where you don't want real Key Vault calls or Azure credentials in CI. Use [`@noy-db/at-env`](../at-env) or `MemorySealer` from `@noy-db/hub` instead.

## Key rotation

**Azure RSA decrypt is version-bound.** Unlike AWS/GCP symmetric KMS — where the key version travels inside the ciphertext blob — Azure's `CryptographyClient` resolves the key version at construction time and every decrypt call is pinned to that version. This has a critical consequence:

- **Always use a versioned `keyId`** (`https://<vault>.vault.azure.net/keys/<name>/<version>`). The version in the URL is your guarantee that every sealed secret can be decrypted by the exact key material used to encrypt it.
- **Do NOT enable Key Vault auto-rotation on a versionless `keyId`.** If the key rotates while you are using a versionless URL, the `CryptographyClient` will resolve to the new version, and every secret sealed under the previous version becomes **permanently undecryptable** — every managed-mode vault is locked out with no recovery path.

**To rotate your sealing key** (e.g. for scheduled cryptographic hygiene):

1. Create a new key version (or a new key) in Key Vault.
2. For each vault, call `unseal` with the old versioned `keyId` to recover the plaintext secret.
3. Call `seal` with a provider configured for the **new** versioned `keyId` to produce a new ciphertext.
4. Persist the new sealed blob and update your app configuration to the new versioned `keyId`.

This is a deliberate migration step — not transparent rotation. Treat it the same way you would a secret rotation in any other system.

## API

```ts
function atAzureKeyvault(opts: {
  keyId: string                           // Full key identifier URL
  algorithm?: 'RSA-OAEP-256' | 'RSA-OAEP'  // default: 'RSA-OAEP-256'
  cryptographyClient?: CryptoLike         // optional pre-built client (useful for tests)
}): NoydbSealer
```

Never pass raw Azure credentials in the options — inject a pre-configured `CryptographyClient` for non-default auth. The default builds a `CryptographyClient` with `DefaultAzureCredential`.

Returns a [`NoydbSealer`](../hub/src/port/at/index.ts) — importable as `@noy-db/hub/at` — the contract `@noy-db/hub`'s managed-secret mode consumes.

## License

MIT
