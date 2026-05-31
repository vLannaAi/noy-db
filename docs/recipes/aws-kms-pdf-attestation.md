# AWS-KMS PDF attestation (generation side)

The generation-time half of document attestation: a deployable AWS Lambda that
takes a firm-sealed document record from S3, KMS-decrypts it, renders an HTML
invoice → PDF with the attestation **QR embedded as vector**, and returns the
PDF. Pairs with the offline verifier (recipe `attestation-verifier`).

## What it exercises
- `@noy-db/hub` issue side (`vault.issueAttestation`) — firm mints the signed QR.
- `@noy-db/at-aws-kms` — seals the render payload `{docId, fields, qr}` with the
  firm's KMS key (the original `at-aws-kms` use case).
- A hub-free render Lambda: S3 GetObject → KMS Decrypt → HTML+inline-SVG QR →
  headless Chromium (`@sparticuz/chromium`) → PDF.
- `@noy-db/recipe-attestation-verifier` — proves the embedded QR verifies offline.

## Data flow
1. **Issue (firm, hub):** `issueAttestation` → `{ docId, qr, keyId }`.
2. **Seal (firm):** `sealAndUpload({docId, fields, qr})` → KMS-encrypt → S3 `docs/<docId>`.
3. **Render (Lambda):** GET `…/?docId=<docId>` → decrypt → render PDF with the vector QR.
4. **Verify (third party, offline):** scan the QR → `verifyDocument` (recipe ④).

## Trust + scope
The QR carries the signed per-field commitment; the PDF is generated, never
verified server-side. The render payload is capped at 4 KB (KMS plaintext limit).

The render endpoint is gated by a **stateless signed magic link** — an
HMAC-SHA256 over `canonicalJson({v, docId, exp})` with a KMS-sealed secret. A
data-holder mints a self-expiring, shareable URL (`?d=&exp=&sig=`); the hub-free
Lambda verifies it with **no AWS authorizer / Cognito / IdP**. A bare `?docId=`
is rejected (403) — there is no unauthenticated path. Links are **multi-use
within the TTL** (default 24h, 7d cap — a public-audience bearer capability);
**revocation = rotate the share secret** (invalidates all live links). The
Function URL stays `authType: NONE` at the AWS layer — the Lambda itself is the
gate. Deploy/verify/teardown is profile-driven; see
`recipes/aws-kms-pdf-attestation/RUNBOOK.md`.

The CI showcase (`showcases/src/recipe-aws-kms-pdf-attestation.recipe.test.ts`)
covers the data path with a mock KMS; the Chromium render + real AWS run only
via the runbook.
