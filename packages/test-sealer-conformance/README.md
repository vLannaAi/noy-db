# @noy-db/test-sealer-conformance

Contract tests for the `at-*` family port. Every `NoydbSealer` implementation — `at-env`, `at-aws-kms`, `at-gcp-kms`, `at-macos-keychain`, `at-azure-keyvault`, or your own — runs the same suite, so "implements the contract" means one thing rather than one thing per package.

```ts
import { runSealerConformanceTests } from '@noy-db/test-sealer-conformance'
import { atEnv } from '@noy-db/at-env'

runSealerConformanceTests('at-env', () => atEnv({ envVar: 'NOYDB_SEAL_A' }), {
  other: () => atEnv({ envVar: 'NOYDB_SEAL_B' }),
})
```

`other` is required, not optional: the single most load-bearing property of a sealer is that its output is **not portable to a differently-identified provider**, and one instance cannot demonstrate that.

## What it checks

Round-trip (including empty and multi-block secrets), that the output is not the plaintext, that `id` is present, stable and does not leak the secret — and, carrying most of the weight, that **`unseal` refuses**: another provider's blob, bytes never sealed, an empty buffer, and a tampered blob.

That emphasis is deliberate. `at-*` is the one non-zero-knowledge family, and hub treats a thrown error as *"this provider cannot unlock this vault"*. `providerId` is audit metadata, **not** a guard — so a provider that returns garbage instead of throwing hands hub a "secret" nobody sealed.

Pass `skipTamper: true` only for a backend that cannot be handed a corrupted blob (a keychain that only ever returns what it stored). Skipping it because it fails is the bug it exists to find.

## Which providers can run what, and why

The split is not "local vs cloud" — it is **where the cryptography happens**.

| provider | full suite | obligations | why |
|---|---|---|---|
| `at-env` | ✅ | — | does its own AES-256-GCM |
| **`at-macos-keychain`** | ✅ | — | **the Keychain stores the KEY; the sealing is `crypto.subtle` in this package.** A memory-backed `KeychainEntry` swaps the key store and leaves the cryptography real |
| `at-aws-kms` | ❌ needs real KMS | ✅ | `seal` **is** an `EncryptCommand` |
| `at-gcp-kms` | ❌ needs real KMS | ✅ | `seal` **is** `client.encrypt` |
| `at-azure-keyvault` | ❌ | ❌ **no test seam** | see below |

For a **delegating** provider, refusing tampered, foreign or garbage input is the *service's* behaviour. Standing a fake KMS in front of it and asserting tamper rejection tests the fake. What remains the *provider's* is covered by `runDelegatingSealerObligations`:

| obligation | whose | how |
|---|---|---|
| refuses tampered / foreign / garbage input | **the service's** | only against the real service |
| a service failure SURFACES, never swallowed | **the provider's** | stub client |
| no ciphertext/plaintext ⇒ THROWS, never fabricates | **the provider's** | stub client |

Both obligations are already satisfied by every wired provider, so those tests **pin** the behaviour rather than having found it missing — worth saying, so a green run is not read as evidence a bug was caught. (Mutation-checked: making `unseal` fabricate empty bytes fails 1; making it swallow the failure fails 2.)

### ⚠️ `at-azure-keyvault` cannot be tested at all

Every other `at-*` provider takes an injection seam — `entry` for the Keychain, `client` for AWS and GCP. `AtAzureKeyvaultOptions` takes only `keyId` and `algorithm`, so there is no way to exercise it without a real Key Vault. It is the one provider with **no coverage of either kind**, and closing that needs a production change (add `client?:`), not a test.

### Still owed

A **credential-gated integration lane** running the full suite against real AWS/GCP/Azure backends. Until it exists, be blunt about what is unverified: those three providers' refusal behaviour has never been executed.

