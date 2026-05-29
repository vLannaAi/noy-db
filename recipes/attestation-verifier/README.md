# Offline attestation verifier (reference recipe)

A single self-contained `verifier.html` that checks a document attestation
**fully offline** — no server, no network. It consumes only `@noy-db/attestation`.

## Use
1. Edit `src/config.ts`: set `publicKeys` to the firm's published key(s) (`keyId → publicKeyB64`), `fieldSchema` to the collection's attestation schema, and `revocationList` to the latest signed list. (Run `node scripts/gen-sample.mjs` to regenerate demo values.)
2. `node build.mjs` → `dist/verifier.html`.
3. Open `dist/verifier.html` in any browser (double-click — no server). Paste the QR payload, type the printed field values, click **Verify**.

## Verdict
`AUTHENTIC & VALID` · `REVOKED` · `ALTERED` (per-field localized) · `SIGNATURE INVALID` · `UNRECOGNIZED KEY` · `UNREADABLE QR`. An untrusted bundled revocation list downgrades the wording but never flips a real authenticity pass.
