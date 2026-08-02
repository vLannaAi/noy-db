# Pod signature — `.noydb` header authentication

The `.noydb` pod format (`@noy-db/hub/pod`) wraps `vault.dump()` for safe cloud-storage drops: a 10-byte magic prefix, a JSON header, and a compressed body. Since #943, `writePod` signs that header by default whenever the source vault has a persisted document signer, and a dependency-free `verifyPodHeader(bytes, trustedKeys)` lets a static page (no store, no enclave, no vault) authenticate a pod using only WebCrypto.

## What gets signed

The header — `formatVersion`, `handle`, `bodyBytes`, `bodySha256`, and any of `publicEnvelope`/`autoUnlock`/`bundleKind`/`transferSeal` that are present — is signed as canonical JSON (`@noy-db/attestation`'s `canonicalJson` → `utf8` → Ed25519) via the shared `signRecord`/`verifyRecord`/`signedBytes` convention in `with-pod/signature.ts`. This is the same convention the Redirect record (#944) and manifest writes (#941) sign through, so a verifier only needs to learn one scheme.

Signing bumps the header to `formatVersion: 2` and attaches the `sig`/`keyId`/`sigAlg` 3-tuple:

- `sigAlg` — currently always `'ed25519'` (`POD_SIG_ALG`).
- `sig` — the base64url Ed25519 signature over the header (including `keyId`/`sigAlg`, excluding `sig` itself).
- `keyId` — a 16-hex-char fingerprint of the signing public key.

`sigAlg` rides *inside* the signed bytes, not outside them — a downgrade attack that strips or swaps the algorithm tag breaks verification rather than silently falling back to an unauthenticated check.

## Trust model

The signing key lives on the vault as a `DocSigner`, stored as the encrypted `_attestations/_signer` record (see `Vault._loadPodSigner`, `with-audit/attestation/signer.ts`). That record holds the **private** key and is correctly excluded from `vault.dump()` — it never rides in the pod body.

The pod header itself only ever carries `keyId`, the 16-hex fingerprint — never the public key. That means:

- `keyId` is available **pre-unlock**, straight off the plaintext header, so a verifier (or a caller pinning a known vault) can recognize "this is signed by the key I expect" before decrypting anything.
- The verifier must supply the actual public key out-of-band — `verifyPodHeader(bytes, trustedKeys)` takes a `keyId → publicKeyB64` map the caller already trusts (e.g. pinned from a prior interaction, distributed via the attestation issuer, or configured by an operator). There is currently no in-pod channel for learning a new public key from a pod you don't already trust.
- Distributing the public key inside the pod body itself (so a first-contact verifier could bootstrap trust from the pod alone) is a documented **future follow-up**, not built here.

## `verifyPodHeader`

```ts
import { verifyPodHeader } from '@noy-db/hub/pod'

const result = await verifyPodHeader(bytes, { [keyId]: publicKeyB64 })
```

Reads only the prefix + header region (no body decompression, no vault). Returns a `PodVerifyResult`:

| `status` | Meaning |
|---|---|
| `verified` | Header carried a sig-tuple, `keyId` is in `trustedKeys`, and the signature checks out. |
| `unsigned` | No sig-tuple present — a legacy v1 pod, or a v2 pod written with `{ sign: false }`. **Not an error** and never conflated with `verified`. |
| `untrusted` | Signed, but `keyId` isn't in `trustedKeys`. The signature was **not** checked. |
| `tampered` | Signed by a trusted key, but the signature doesn't verify — the header was altered, or the wrong public key is mapped to that `keyId`. |

`verifyPodHeader` is authenticity-only. `readPod`'s `bodySha256` integrity check is a separate, unchanged concern — compose both when a caller needs both guarantees.

## Legacy semantics

A `sig`-absent header is always reported `unsigned`, never silently `verified` — the format layer enforces `sig`/`keyId`/`sigAlg` as all-or-nothing, so a partial tuple is a validation error rather than a degraded-trust state. A v1 reader that encounters a v2 signed pod fails with a clean format-version error rather than misreading the new fields.

## Scope (v1)

- Partitions (`extractPartition`'s output) are **unsigned** — signing does not extend to the partition-transfer format.
- Verification is additive: `readPod` does not fold sig-status into its return value. Callers that want authenticity call `verifyPodHeader` themselves.
- Key revocation/rotation for pod signers is not wired up yet — attestation has a revocation list; connecting it to pod verification is a follow-up.
