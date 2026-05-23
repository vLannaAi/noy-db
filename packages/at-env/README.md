# @noy-db/at-env

**Env-var sealing key provider for noy-db [managed-passphrase mode](https://github.com/vLannaAi/noy-db/issues/14).**

The smallest production-shape provider in the `at-*` family. Reads a 32-byte AES-256-GCM key from an environment variable (base64-encoded) and uses it to seal the hub-generated random passphrase — so your users never see or type a passphrase, but the encryption keys are still under your control.

## Install

```bash
pnpm add @noy-db/hub @noy-db/at-env
# or: npm install @noy-db/hub @noy-db/at-env
```

## Setup

```bash
# 1. Generate a 256-bit key once. Store in your platform's secret manager
#    (Kubernetes Secrets, Heroku env, Doppler, AWS Secrets Manager, etc.).
export NOYDB_SEALING_KEY=$(openssl rand -base64 32)
```

```ts
// 2. In your app:
import { createNoydb } from '@noy-db/hub'
import { envSealingProvider } from '@noy-db/at-env'

const db = await createNoydb({
  store,
  user: 'alice',
  passphraseMode: 'managed',
  sealingKey: envSealingProvider(),  // reads NOYDB_SEALING_KEY by default
})

const vault = await db.openVault('acme')
// Hub generated a 256-bit random on first open, sealed it under your env
// key, and persisted to _meta/sealed-passphrase. The user never sees a
// passphrase. On reopen, at-env unseals transparently.
```

## When to use this provider

- ✅ Single-node SaaS where the env var comes from Kubernetes Secrets, Heroku env, Doppler, AWS Secrets Manager mounted at boot, systemd env, etc.
- ✅ Local dev / CI where you want persistence across restarts (which `MemorySealingKeyProvider` can't do — it's in-process only).
- ✅ Prototypes where setting up AWS KMS / GCP KMS isn't worth the effort.

## When NOT to use this provider

- ❌ Laptops or shared dev machines where other users have shell access. They can `echo $NOYDB_SEALING_KEY` and exfiltrate the key. Use [`@noy-db/at-macos-keychain`](../at-macos-keychain) / [`@noy-db/at-wincred`](../at-wincred) / [`@noy-db/at-libsecret`](../at-libsecret) for desktop apps. *(coming soon)*
- ❌ Compliance regimes requiring auditable key access logs (FedRAMP, HIPAA with managed-encryption requirements). Use [`@noy-db/at-aws-kms`](../at-aws-kms) for KMS-backed key access auditing. *(coming soon)*

## Key rotation

Rotating the env-var key is currently manual:

1. Open the vault under the OLD env key.
2. Generate a new key: `NEW=$(openssl rand -base64 32)`.
3. Read `_meta/sealed-passphrase` from the store.
4. Unseal under the OLD provider, re-seal under a NEW provider (`envSealingProvider({ envVar: 'NOYDB_NEW_KEY' })`).
5. Overwrite `_meta/sealed-passphrase`.
6. Swap the env var to the new value.

An automated `noydb seal rotate` CLI command is tracked as a follow-up. For lower-touch rotation, use `@noy-db/at-aws-kms` once it lands — KMS handles CMK rotation automatically.

## Threat model

The env var IS the security boundary. If an attacker gains read access to your process's environment, they can decrypt every record sealed under that key.

This provider is suitable when your deployment platform's secret management is trusted (you trust Kubernetes Secrets, you trust Heroku's env injection, etc.) and unsuitable when the env var sits in a shell profile, a `.env` file in version control, or a multi-tenant host where other tenants can read your environment.

## API

```ts
function envSealingProvider(opts?: {
  envVar?: string  // default 'NOYDB_SEALING_KEY'
}): SealingKeyProvider
```

Returns a [`SealingKeyProvider`](../hub/src/team/managed-passphrase.ts) — the contract `@noy-db/hub`'s managed-passphrase mode consumes. The provider validates the env var at construction time and caches the imported `CryptoKey` for the lifetime of the instance.

Throws at construction when the env var is unset, not valid base64, or not 32 bytes.

## License

MIT
