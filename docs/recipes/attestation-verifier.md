# Offline document-attestation verifier

Verify that a printed or forwarded accounting document is **authentic and
unaltered — fully offline**, with no server holding or returning any document
content. The firm issues a signed, per-field commitment that travels inside a
QR on the document; a third party recomputes the commitment from what they can
read off the paper and checks the firm's Ed25519 signature against a built-in
public key.

## What it exercises
- `@noy-db/hub` issue side (`vault.issueAttestation`, `getDocumentSigningPublicKey`).
- `@noy-db/attestation` verify side (`decodeQr`, `verifyAttestation`, `verifyRevocationList`) — composed by the recipe's `verifyDocument()`.
- A self-contained static `verifier.html` (see `recipes/attestation-verifier/`) that runs the whole verdict client-side.

## Flow
1. **Issue (firm, hub):** declare an `attestation` field-schema on the collection, `vault.issueAttestation(collection, id)` → `{ docId, qr, keyId }`. Publish the public key (`getDocumentSigningPublicKey`).
2. **Render:** draw the QR (`qr`) on the document (see recipe ③, the KMS PDF Lambda — not required to verify).
3. **Verify (third party, offline):** open `verifier.html`, paste the QR, type the printed field values → `verifyDocument()` returns `authentic-valid` / `authentic-revoked` / `altered` / `signature-invalid` / `unknown-key` / `unreadable-qr`, localizing any differing field.

## Trust model
The verifier **bundles** the firm's public key(s) and the field schema at build time (most trustworthy — no fetch-time trust anchor; the QR's `keyId` selects the key so rotation does not break old documents). An optional bundled signed revocation list answers "still valid today?"; an untrusted list downgrades the wording but never flips a real authenticity pass.

See `showcases/src/recipe-attestation-verifier.recipe.test.ts` for the runnable end-to-end.
