# @noy-db/at-aws-kms

**AWS KMS sealing key provider for noy-db [managed-secret mode](https://github.com/vLannaAi/noy-db/issues/14).**

An `at-*` provider that seals and unseals the hub-generated random secret via AWS KMS Encrypt / Decrypt. Every seal and unseal is an authenticated KMS API call — giving you a CloudTrail-backed access log of every time a user's vault is opened, with no additional instrumentation required.

Like all `at-*` providers, this is a *trusted host* provider: the host you deploy it on CAN decrypt what it unseals. The security boundary is your AWS IAM policy — access is controlled by which roles hold `kms:Decrypt` on the KMS key, not by a secret the host keeps in memory.

## Install

```bash
pnpm add @noy-db/hub @noy-db/at-aws-kms @noy-db/on-shamir
# or: npm install @noy-db/hub @noy-db/at-aws-kms @noy-db/on-shamir
```

## Setup

```bash
# 1. Create a KMS key once (or reuse an existing ENCRYPT_DECRYPT key):
aws kms create-key --description "noy-db sealing key"
# Note the KeyId or ARN from the output.

# 2. Grant your host's IAM role kms:Encrypt + kms:Decrypt on that key.
#    Credentials are picked up automatically from the SDK's ambient chain
#    (IAM instance role, ECS task role, ~/.aws/credentials, env vars, etc.).
```

```ts
// 3. In your app:
import { createNoydb } from '@noy-db/hub'
import { atAwsKms } from '@noy-db/at-aws-kms'
import { shamirRecoveryProvider } from '@noy-db/on-shamir'

const db = await createNoydb({
  store,
  user: 'alice',
  secretMode: 'managed',
  sealingKey: atAwsKms({ keyId: 'arn:aws:kms:us-east-1:123456789012:key/abc' }),
  shamirRecovery: shamirRecoveryProvider(),
})

const vault = await db.openVault('acme')
// Hub generated a 256-bit random on first open, sealed it via KMS Encrypt,
// and persisted to _meta/sealed-secret. The user never sees a secret.
// On reopen, at-aws-kms calls KMS Decrypt transparently.
// CloudTrail logs every Encrypt/Decrypt call with caller identity + key ARN.
```

## When to use this provider

- ✅ Compliance regimes requiring auditable key access logs (FedRAMP, HIPAA with managed-encryption requirements, SOC 2 Type II).
- ✅ Workloads already running on AWS where a KMS key costs less than engineering an equivalent audit trail.
- ✅ Any case where you want automatic CMK rotation without rotating app-side key material.

## When NOT to use this provider

- ❌ Non-AWS or multi-cloud deployments where adding an AWS dependency is undesirable. Use [`@noy-db/at-env`](../at-env) for a zero-extra-dependency option.
- ❌ Local dev / CI where you don't want real KMS calls or AWS credentials in CI. Use [`@noy-db/at-env`](../at-env) or `MemorySealer` from `@noy-db/hub` instead.

## Key rotation

KMS supports automatic key rotation for symmetric keys. Enable it on the CMK and KMS handles the rest — your `keyId` stays the same, no app changes needed. Cross-key migration (moving sealed secrets to a different CMK) requires manual re-sealing with `unseal` + `seal` under the new key.

## API

```ts
function atAwsKms(opts: {
  keyId: string                    // KMS key id or full ARN
  client?: Pick<KMSClient, 'send'> // optional pre-built client (useful for tests)
}): NoydbSealer
```

Never pass raw AWS credentials in the options — inject a pre-configured `KMSClient` for non-default auth. The default `new KMSClient({})` resolves credentials via the SDK's ambient chain.

Returns a [`NoydbSealer`](../hub/src/port/at/index.ts) — importable as `@noy-db/hub/at` — the contract `@noy-db/hub`'s managed-secret mode consumes.

## License

MIT
