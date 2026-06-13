# `@noy-db/at-*` — Sealing-key providers (trusted hosts)

> **How a vault goes online without giving up its keys.** Every other noy-db family keeps plaintext on the user's device. The `at-*` family is the deliberate exception: it lets a host *you* control — a Lambda, an EC2 box, a microservice — hold a sealing key and unseal a **scoped slice** of a vault, so you can run server-side work for a user who never logs in and never holds a key. The canonical shape: one worker's tax data, unsealed just enough for a serverless function to compute and return a filing.
>
> The `at-` prefix reads as *"sealed **at** a trusted host."* The sealing key comes from the host's environment — an env var (`at-env`), the OS keychain (`at-macos-keychain`), a cloud KMS (`at-aws-kms`, `at-gcp-kms`, `at-azure-keyvault`) — never hard-coded, always under your account's access controls and rotation.
>
> **Be clear about the trust boundary.** Unlike `to-*` stores and `by-*` transports — which never see plaintext — an `at-*` host **can decrypt the slice it unseals.** That is the point, and the safeguard is *scope*: per-user sealed credentials and partition extraction mean a host unseals only the slice it's authorized for, never the whole vault. Offline-first by default; online, least-privilege, on infrastructure you own.

## Providers

| Package | Backend | Status |
|---|---|---|
| `@noy-db/at-env` | environment variable | stable |
| `@noy-db/at-macos-keychain` | macOS Keychain | stable |
| `@noy-db/at-aws-kms` | AWS KMS | stable |
| `@noy-db/at-gcp-kms` | Google Cloud KMS | stable |
| `@noy-db/at-azure-keyvault` | Azure Key Vault (RSA-OAEP-256) | stable |

All implement hub's `SealingKeyProvider` (`seal`/`unseal`). Pair with `createNoydb({ passphraseMode: 'managed', sealingKey, shamirRecovery })`. See each package's README for setup.

> **Azure note:** Key Vault RSA decrypt is version-bound — pin a versioned key id; auto-rotation on a versionless key orphans previously-sealed vaults.

### Recipient-target sealing (`at-aws-kms`)

Beyond self-sealing the managed passphrase, `@noy-db/at-aws-kms` can act as a **recipient target** via `awsKmsRecipientSealer({ keyId })`, implementing hub's `RecipientSealer`. Back it with an **asymmetric RSA** KMS key (`KeyUsage: ENCRYPT_DECRYPT`, `KeySpec` one of `RSA_2048` / `RSA_3072` / `RSA_4096`):

- `publishRecipientHint()` calls KMS `GetPublicKey` and returns the public key as PEM — a grantor uses this hint to seal bytes to the host.
- `sealForRecipient(plaintext, hint)` seals **locally** (no KMS call) in the canonical RSA-OAEP-SHA256 TLV, identical to hub's `MemoryRecipientSealer` wire format.
- `unseal(sealed)` runs KMS `Decrypt` with `EncryptionAlgorithm: RSAES_OAEP_SHA_256` to unwrap the content-encryption key — **the private key never leaves KMS**.

KMS asymmetric keys don't support an encryption context, so none is used. WebCrypto `RSA-OAEP`/SHA-256 and KMS `RSAES_OAEP_SHA_256` are wire-compatible, so a blob sealed by `MemoryRecipientSealer` (or any sealer using the shared `sealRsaOaepTlv` helper) unseals through the KMS path and vice-versa. This is the cloud-verified building block for record-scoped sealing (issue #306).
