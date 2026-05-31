# @noy-db/recipe-aws-kms-pdf-attestation

Deployable reference Lambda: KMS-decrypt a firm-sealed S3 doc record, render an
HTML invoice → PDF with the attestation QR as vector. Private recipe, not published.

- Narrative + data flow: `docs/recipes/aws-kms-pdf-attestation.md`
- Deploy / verify / teardown (real AWS, profile-driven): `RUNBOOK.md`
- CI-safe data-path test: `pnpm --filter @noy-db/recipe-aws-kms-pdf-attestation test`

Render stack: puppeteer-core + @sparticuz/chromium, **arm64 zip Lambda + public
Chromium layer** (no Docker/ECR), Node 22, ≥2 GB, QR as inline `<svg>` (vector).
A self-contained container variant is documented in `RUNBOOK.md` (and `Dockerfile`).
