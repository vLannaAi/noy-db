# Document Attestation — ③ AWS-KMS PDF Render Recipe design

**Status:** sub-system spec (③ of the document-attestation umbrella) → ready for plan
**Date:** 2026-05-30
**Relates to:** umbrella `docs/superpowers/specs/2026-05-29-document-attestation-umbrella-design.md` §3.7/§4/§5/§7/§8; issue side `…attestation-core-and-issue-design.md`; verifier `…attestation-verifier-design.md`. Depends on the merged `@noy-db/attestation` (①a), `@noy-db/hub/attestation` (①b, #236), `@noy-db/at-aws-kms` (the byte-sealer), and (verify step) `@noy-db/recipe-attestation-verifier` (④, #237).

## 1. Goal

The generation-time half of document attestation: a **deployable reference Lambda** that takes a firm-sealed document record from S3, KMS-decrypts it, renders an HTML invoice → PDF with the issued attestation **QR embedded as vector**, and returns the PDF. This is where the firm's original `at-aws-kms` ask lands — but as a **byte-sealer**, not a bundle ceremony (see §3). Delivered as a new `recipes/aws-kms-pdf-attestation/` package (deployable, **not published**), a recipe doc + showcase, and a deploy/teardown runbook.

**Scope decision (locked in brainstorming):** the user chose a **full deployable Lambda verified against real AWS**. The slice is bounded hard inside that: one sample invoice template, minimal IAM, the novel parts (at-aws-kms byte seal/unseal + vector-QR-on-PDF + the render Lambda) are the point; everything else stays thin. This is the largest slice of the epic; expect a ~6-task plan.

## 2. Architecture

A reference app under `recipes/aws-kms-pdf-attestation/` (private, `recipes/*` workspace glob from ④). Five parts with clean seams:

| Part | File(s) | CI-testable? | Responsibility |
|---|---|---|---|
| **render-core** | `src/render-core.ts` | YES (builder) / NO (pdf) | `buildInvoiceHtml(payload) → string` (sample template + QR as inline `<svg>` via `qrcode`) and `renderPdf(html) → Uint8Array` (puppeteer-core + @sparticuz/chromium, isolated so the builder tests without Chromium) |
| **seal payload** | `src/payload.ts` | YES | `RenderPayload` type + `encodeRenderPayload`/`decodeRenderPayload` (JSON↔utf8) + the ≤4 KB guard |
| **seal helper** | `src/seal.ts` | YES (mock KMS) | firm-side: `sealAndUpload(payload, { keyId, bucket, key, kmsClient?, s3Client? })` — `awsKmsSealingProvider.seal` → S3 PutObject |
| **Lambda handler** | `src/handler.ts` | YES (mock AWS) | Function-URL handler: parse docId → S3 GetObject → **raw `@aws-sdk/client-kms` `DecryptCommand`** (the inverse of at-aws-kms's Encrypt envelope — keeps the Lambda hub-free; see §2 note) → `decodeRenderPayload` → render-core → `application/pdf` base64 response |
| **CDK stack** | `infra/*.ts`, `cdk.json` | YES (`cdk synth`) | KMS key, private S3 bucket, container `DockerImageFunction` (arm64, Node 22, ≥2 GB, Function URL), least-priv IAM |

Plus: `Dockerfile` (Lambda container, arm64), `docs/recipes/aws-kms-pdf-attestation.md`, `showcases/src/recipe-aws-kms-pdf-attestation.recipe.test.ts`, a `RUNBOOK.md` (deploy → seal → invoke → teardown).

**Dependency corrections vs the umbrella:** (a) the umbrella listed `@noy-db/to-aws-s3`, but that's the vault **store** adapter — not applicable; a single sealed object is plain S3, so seal-helper + handler use `@aws-sdk/client-s3` directly. (b) **The Lambda imports neither `@noy-db/hub` nor `@noy-db/attestation` nor `@noy-db/at-aws-kms`** — it renders the QR string verbatim from the sealed payload, and unseals with the raw `@aws-sdk/client-kms` `DecryptCommand`. This matters because `@noy-db/at-aws-kms` declares `@noy-db/hub` as a **peerDependency** (its `SealingKeyProvider` type comes from hub), so importing at-aws-kms into the Lambda would require providing hub in the container image; the render Lambda has no other reason to carry hub, and puppeteer/Chromium containers are best kept minimal. The raw `DecryptCommand` is the exact inverse of at-aws-kms's Encrypt envelope (a symmetric KMS CMK), so the round-trip is identical — the Lambda just uses the lower-level call to stay hub-free and minimal. **`@noy-db/at-aws-kms` IS featured — on the firm-side seal helper** (`sealAndUpload` uses `awsKmsSealingProvider.seal`), which is the original `at-aws-kms` ask and runs in a hub context. Hub/`issueAttestation` is only in the firm-side seal helper (and the showcase).

## 3. The seal model — `at-aws-kms` as a byte sealer

`@noy-db/at-aws-kms` exposes `awsKmsSealingProvider({ keyId, client? }): SealingKeyProvider` with a generic byte envelope: `seal(bytes) → KMS-ciphertext`, `unseal(ciphertext) → bytes` (KMS Encrypt/Decrypt). It is **not** a bundle recipient-sealer and needs **no `adoptPartition`/owner-minting ceremony** — exactly the stateless per-invocation primitive a render Lambda needs. **No extension to `at-aws-kms` is required.** The `client?` DI seam lets both seal and unseal unit-test against a **mock KMS client**.

**RenderPayload** (`src/payload.ts`):
```ts
interface RenderPayload {
  docId: string
  fields: Record<string, string | number>   // the declared attestation fields (printed on the invoice)
  qr: string                                 // the QR payload string from issueAttestation
}
```
`encodeRenderPayload(p) → Uint8Array` = `utf8(JSON.stringify(p))`. **KMS Encrypt caps plaintext at 4 KB** — `encodeRenderPayload` throws a plain `Error` with a clear message (`render payload exceeds the 4 KB KMS plaintext limit…`) if the encoded bytes exceed 4096 (declared fields + a ~250 B QR are far under; envelope encryption for larger payloads is out of scope, §8). This is a private recipe package, so a local `Error` is sufficient — no exported error class. `decodeRenderPayload(bytes)` parses + shape-validates (throws on malformed JSON or a missing `docId`/`fields`/`qr`).

## 4. Render core (`src/render-core.ts`)

- `buildInvoiceHtml(payload: RenderPayload): string` — fills a single hard-coded sample invoice template (firm header, the `fields` as a table, total) and embeds the QR as **inline `<svg>`** generated by `qrcode` (`QRCode.toString(qr, { type: 'svg' })`) so Chromium's print-to-PDF emits it as **vector** (crisp at any print DPI / when photographed for verification). Pure string-building — fully CI-testable.
- `renderPdf(html: string): Promise<Uint8Array>` — launches `@sparticuz/chromium` via `puppeteer-core`, `page.setContent(html)`, `page.pdf({ format: 'A4', printBackground: true })`. The browser is created lazily + reused across warm invocations (module-scope singleton). Not CI-testable (needs the Chromium binary) — isolated behind this one function so the handler can be unit-tested with a stubbed `renderPdf`.

## 5. Lambda handler (`src/handler.ts`)

Function-URL handler (`{ rawPath / queryStringParameters }` → docId). Flow: validate docId → `s3.GetObject({ Bucket, Key: <prefix>/<docId> })` → `kms.send(new DecryptCommand({ CiphertextBlob, KeyId }))` → `Plaintext` bytes → `decodeRenderPayload` → `buildInvoiceHtml` → `renderPdf` → return `{ statusCode: 200, headers: { 'content-type': 'application/pdf' }, body: base64(pdf), isBase64Encoded: true }`. (Raw `DecryptCommand` rather than `awsKmsSealingProvider.unseal` to keep the Lambda hub-free — §2 note.) Errors map to 400 (bad docId) / 404 (no object) / 500 (decrypt/render failure) with no secret leakage in the body. Clients (KMS, S3) are constructed at module scope from ambient creds (the Lambda role) but injectable via an internal `makeHandler(deps)` factory so the handler logic unit-tests with mocked S3+KMS + a stubbed `renderPdf`.

## 6. IAM (least-privilege)

- **Lambda execution role:** `kms:Decrypt` on the one key ARN + `s3:GetObject` on `arn:aws:s3:::<bucket>/<prefix>/*` + the basic Lambda logging policy. Nothing else.
- **Firm-side sealer identity** (documented in the runbook, NOT the Lambda role): `kms:Encrypt` on the key + `s3:PutObject` on the prefix.
- The S3 bucket is private (block-all-public-access, SSE on). The Function URL uses `authType: NONE` (public) for the demo — a deliberate simplification so the user can `curl` the URL directly during verification; the recipe doc + runbook flag that production must switch to `AWS_IAM` (or a Lambda authorizer / JWT) since the endpoint returns rendered PDFs.

## 7. Deploy / verify lifecycle (profile-driven)

Per the user's standing credential rule, all AWS access is via a **named profile the user provides** (`AWS_PROFILE=<name>`, e.g. from `NOYDB_SHOWCASE_AWS_DOCS`) — never raw credentials, never a shared default. Each AWS-mutating command is confirmed before running. Lifecycle (in `RUNBOOK.md`):
1. `cdk deploy` (KMS key + private S3 bucket + container Lambda + Function URL + IAM) — **I run, with per-resource confirmation.**
2. Seal + upload a sample sealed record (`sealAndUpload`).
3. Invoke the Function URL for that docId → receive the PDF.
4. **I verify:** the PDF is valid; its embedded QR decodes back to the issued payload; ④'s `verifyDocument(qr, fields, …)` returns `authentic-valid`.
5. **User tests** independently.
6. On the user's "done": **`cdk destroy`** (I run, confirmed) — tears down all created resources.

CI never deploys; CI runs the unit tests + `cdk synth` + cfn-lint only.

## 8. Testing

**CI / local (no AWS):**
- `payload.test.ts` — encode/decode round-trip; the 4 KB guard throws; shape validation rejects junk.
- `render-core.test.ts` — `buildInvoiceHtml` includes every field value + an inline `<svg>` (vector, not `<img>`); the embedded QR SVG round-trips (extract the QR string the template was given). `renderPdf` is NOT exercised in CI.
- `seal.test.ts` — `sealAndUpload` with a **mock KMS + mock S3 client**: asserts seal → the exact `PutObject` (bucket/key/body) round-trips through a mock `unseal`.
- `handler.test.ts` — `makeHandler({ s3, kms, renderPdf: stub })` with mocked AWS: happy path returns a base64 `application/pdf`; missing object → 404; bad docId → 400; the stubbed `renderPdf` receives HTML containing the sealed fields.
- `cdk synth` produces a valid template (a CI step; cfn-lint if available).

**Integration (real AWS, profile-driven, in `RUNBOOK.md` — not CI):** the §7 deploy → seal → invoke → verify (`verifyDocument` authentic-valid) → teardown.

**Showcase** (`showcases/src/recipe-aws-kms-pdf-attestation.recipe.test.ts`, CI-safe slice): firm issues via the hub (`vault.issueAttestation`) → build a `RenderPayload` → **seal+unseal with a mock KMS** → `buildInvoiceHtml` → assert the HTML carries the fields + an inline-SVG QR whose decoded string equals the issued QR, and that ④'s `verifyDocument(issuedQr, fields, { publicKeys, fieldSchema })` returns `authentic-valid`. (The Chromium PDF pass + real AWS are exercised only via the runbook, noted in the showcase docblock.)

## 9. features.yaml

Register a `recipes:` entry (`id: aws-kms-pdf-attestation`, `doc: docs/recipes/aws-kms-pdf-attestation.md`, `showcase_path: showcases/src/recipe-aws-kms-pdf-attestation.recipe.test.ts`, `status: preview`, `exercises.features: [attestation]`). The recipe-pair check needs doc-slug = showcase-slug = id = `aws-kms-pdf-attestation` (so the showcase file is `recipe-aws-kms-pdf-attestation.recipe.test.ts`). No new feature row.

## 10. Render stack (locked)

`puppeteer-core` + `@sparticuz/chromium` (arm64), packaged as a **container image** Lambda on `nodejs22.x` (Node 20 hit Lambda EOL 2026-04-30), ≥2048 MB memory, browser reused across warm invocations, QR embedded as inline `<svg>` → vector. (`pdf-lib`/`svg-to-pdfkit` was considered and set aside in favour of HTML/CSS template fidelity; that trade-off is recorded in the umbrella + this spec's history.)

## 11. Scope (YAGNI)

**In:** the five parts in §2, one sample invoice template, the CDK stack + Dockerfile, the unit tests + `cdk synth`, the recipe doc + showcase + runbook, the `NOYDB_SHOWCASE_AWS_DOCS` `.env.example` entry (already added).
**Out:** KMS-backed `DocumentSigner` (deferred per umbrella §7 — signing stays in-process via `issueAttestation`; ③ uses KMS only to *decrypt the source record*); envelope encryption for >4 KB payloads; multiple/themed invoice templates; API Gateway / custom authorizers; non-arm64 builds; Lambda provisioned-concurrency / warming beyond the warm-browser singleton; any vault store on S3 (single sealed objects only).

## 12. Build order within the slice

1. `payload.ts` (RenderPayload + encode/decode + 4 KB guard) + `render-core.ts` `buildInvoiceHtml` (the CI-testable spine), TDD.
2. `render-core.ts` `renderPdf` (puppeteer-core + @sparticuz/chromium) + `Dockerfile` — buildable, not CI-run.
3. `seal.ts` (`sealAndUpload`, mock-KMS tested) + `handler.ts` (`makeHandler`, mock-AWS tested).
4. CDK stack (`infra/`) + `cdk synth` CI step.
5. `docs/recipes/…md` + showcase + `features.yaml` + `RUNBOOK.md` + full local gate.
6. (Execution-time, profile-driven, separate from CI) real-AWS deploy → verify → teardown per the runbook.
