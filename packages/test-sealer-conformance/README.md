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

## Service-backed providers need an integration lane, not mocks

`at-env` runs this suite in full: it does the cryptography itself, so every assertion exercises its own code.

**`at-aws-kms`, `at-gcp-kms`, `at-azure-keyvault` and `at-macos-keychain` do not, and mocks would not fix that.** They delegate — `at-aws-kms`'s `seal` *is* a KMS `EncryptCommand` — so tamper rejection and cross-provider refusal are the service's behaviour, not the provider's. Standing a fake KMS in front of them would test the fake.

The honest split for a delegating provider:

| obligation | whose | testable how |
|---|---|---|
| refuses tampered / foreign / garbage input | **the service's** | only against the real service |
| does not SWALLOW a service failure — a rejected `Decrypt` must surface as a thrown `unseal` | **the provider's** | a mock is fine and appropriate |
| does not fabricate output when the service returns no ciphertext | **the provider's** | a mock is fine |

So the roadmap for those four is a **credential-gated integration lane** running this suite against real backends, plus a narrower provider-obligations suite for the two rows a mock can honestly cover. Not this package pretending to have run.

Until then, be blunt about what is and is not verified: **those four providers have never had their `unseal`-refuses behaviour tested at all.** For the one non-zero-knowledge family, that is the behaviour you would least want untested.
