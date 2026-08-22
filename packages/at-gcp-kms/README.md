# @noy-db/at-gcp-kms

**Google Cloud KMS sealing key provider for noy-db [managed-secret mode](https://github.com/vLannaAi/noy-db/issues/14).**

An `at-*` provider that seals and unseals the hub-generated random secret via Google Cloud KMS Encrypt / Decrypt. Every seal and unseal is an authenticated KMS API call — giving you a Cloud Audit Logs-backed access log of every time a user's vault is opened, with no additional instrumentation required.

Like all `at-*` providers, this is a *trusted host* provider: the host you deploy it on CAN decrypt what it unseals. The security boundary is your GCP IAM policy — access is controlled by which service accounts hold `roles/cloudkms.cryptoKeyEncrypterDecrypter` on the KMS key, not by a secret the host keeps in memory.

## Install

```bash
pnpm add @noy-db/hub @noy-db/at-gcp-kms @noy-db/on-shamir
# or: npm install @noy-db/hub @noy-db/at-gcp-kms @noy-db/on-shamir
```

## Setup

```bash
# 1. Create a key ring and symmetric crypto key once:
gcloud kms keyrings create noy-db-ring --location global
gcloud kms keys create noy-db-sealing \
  --location global \
  --keyring noy-db-ring \
  --purpose encryption
# Note the full resource name from the output.

# 2. Grant your host's service account the Cloud KMS CryptoKey Encrypter/Decrypter role:
gcloud kms keys add-iam-policy-binding noy-db-sealing \
  --location global \
  --keyring noy-db-ring \
  --member serviceAccount:HOST_SA@PROJECT.iam.gserviceaccount.com \
  --role roles/cloudkms.cryptoKeyEncrypterDecrypter
#    Credentials are resolved automatically via Application Default Credentials (ADC):
#    service account attached to GCE/GKE node, Workload Identity for GKE,
#    GOOGLE_APPLICATION_CREDENTIALS env var, or `gcloud auth application-default login`
#    for local dev.
```

```ts
// 3. In your app:
import { createNoydb } from '@noy-db/hub'
import { atGcpKms } from '@noy-db/at-gcp-kms'
import { shamirRecoveryProvider } from '@noy-db/on-shamir'

const db = await createNoydb({
  store,
  user: 'alice',
  secretMode: 'managed',
  sealingKey: atGcpKms({
    keyName: 'projects/my-project/locations/global/keyRings/noy-db-ring/cryptoKeys/noy-db-sealing',
  }),
  shamirRecovery: shamirRecoveryProvider(),
})

const vault = await db.openVault('acme')
// Hub generated a 256-bit random on first open, sealed it via KMS Encrypt,
// and persisted to _meta/sealed-secret. The user never sees a secret.
// On reopen, at-gcp-kms calls KMS Decrypt transparently.
// Cloud Audit Logs record every Encrypt/Decrypt call with caller identity + key resource name.
```

## When to use this provider

- Compliance regimes requiring auditable key access logs (FedRAMP, HIPAA with managed-encryption requirements, SOC 2 Type II).
- Workloads already running on GCP where a Cloud KMS key costs less than engineering an equivalent audit trail.
- Any case where you want automatic key version rotation without rotating app-side key material.

## When NOT to use this provider

- Non-GCP or multi-cloud deployments where adding a GCP dependency is undesirable. Use [`@noy-db/at-env`](../at-env) for a zero-extra-dependency option.
- Local dev / CI where you don't want real KMS calls or GCP credentials in CI. Use [`@noy-db/at-env`](../at-env) or `MemorySealer` from `@noy-db/hub` instead.

## Key rotation

Cloud KMS supports automatic key version rotation for symmetric keys. Enable it on the crypto key and KMS handles the rest — your `keyName` stays the same, no app changes needed. Cross-key migration (moving sealed secrets to a different key) requires manual re-sealing with `unseal` + `seal` under the new key.

## API

```ts
function atGcpKms(opts: {
  keyName: string                       // Full crypto-key resource name
  client?: KmsClientLike                // optional pre-built client (useful for tests)
}): NoydbSealer
```

Never pass raw GCP credentials in the options — inject a pre-configured `KeyManagementServiceClient` for non-default auth. The default `new KeyManagementServiceClient()` resolves credentials via Application Default Credentials.

Returns a [`NoydbSealer`](../hub/src/port/at/index.ts) — importable as `@noy-db/hub/at` — the contract `@noy-db/hub`'s managed-secret mode consumes.

## License

MIT
