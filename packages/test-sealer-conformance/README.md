# @noy-db/test-sealer-conformance

Contract tests for the `at-*` family port. Every `NoydbSealer` implementation — `at-env`, `at-aws-kms`, `at-gcp-kms`, `at-macos-keychain`, `at-azure-keyvault`, or your own — runs the same suite, so "implements the contract" means one thing rather than one thing per package.

```ts
import { runSealerConformanceTests } from '@noy-db/test-sealer-conformance'
import { atEnv } from '@noy-db/at-env'

runSealerConformanceTests('at-env', () => atEnv({ id: 'env:a' }), {
  other: () => atEnv({ id: 'env:b' }),
})
```

`other` is required, not optional: the single most load-bearing property of a sealer is that its output is **not portable to a differently-identified provider**, and one instance cannot demonstrate that.

## What it checks

Round-trip (including empty and multi-block secrets), that the output is not the plaintext, that `id` is present, stable and does not leak the secret — and, carrying most of the weight, that **`unseal` refuses**: another provider's blob, bytes never sealed, an empty buffer, and a tampered blob.

That emphasis is deliberate. `at-*` is the one non-zero-knowledge family, and hub treats a thrown error as *"this provider cannot unlock this vault"*. `providerId` is audit metadata, **not** a guard — so a provider that returns garbage instead of throwing hands hub a "secret" nobody sealed.

Pass `skipTamper: true` only for a backend that cannot be handed a corrupted blob (a keychain that only ever returns what it stored). Skipping it because it fails is the bug it exists to find.
