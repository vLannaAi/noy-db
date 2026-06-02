# @noy-db/attestation

## 0.2.0-pre.4

Version-only lockstep bump; no source changes since pre.3.

## 0.2.0-pre.3

Version-only lockstep bump; no source changes since pre.2.

## 0.2.0-pre.2

Initial release. A **pure, zero-runtime-dependency** core for offline document attestation — browser + Node WebCrypto only, hub-free so the verifier runs without the engine ([#235](https://github.com/vLannaAi/noy-db/issues/235)).

- **Commitments:** `computeFieldHashes` — per-field salted, domain-separated `base64url(sha256(canonicalJson([salt, path, normalizedValue])))`; closed normalizer set (`trim|lower|upper|alnum-upper|digits|cents|iso-date`) + `validateFieldSchema`.
- **Signing:** Ed25519 `generateDocSigningKeyPair` / `ed25519Sign` / `ed25519Verify` / `keyIdFor`; `signPayloadCore` / `verifyAttestation` (per-field localization + forgery + revocation gates).
- **QR codec:** `encodeQr` / `decodeQr` over a compact `{ v, docId, salt, alg, keyId, fieldHashes, sig }` payload (base64url).
- **Revocation:** `signRevocationList` / `verifyRevocationList` / `isRevoked`.
- Replicated `canonicalJson` / `sha256Hex` with conformance vectors (dependency direction is hub → attestation, so these can't be imported from hub).
