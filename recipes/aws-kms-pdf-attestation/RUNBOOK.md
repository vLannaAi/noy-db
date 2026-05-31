# RUNBOOK — deploy, verify, teardown (real AWS)

All AWS access uses a NAMED PROFILE you provide (`export AWS_PROFILE=<name>`),
never raw or shared credentials. Each resource-creating step is confirmed first.

The default deploy is a **ZIP function on arm64 (Graviton) with Chromium supplied
by a public Lambda layer** — no Docker, no ECR. (A self-contained container
alternative is documented at the bottom.)

## Prereqs
- An AWS profile with permission to create KMS/S3/Lambda/IAM + run CDK.
- Node 22 + pnpm (to build the handler bundle). **No Docker required.**
- `export AWS_PROFILE=<your-profile>` and `export AWS_REGION=ap-southeast-1`.
  - The Chromium layer ARN in `infra/stack.ts` is **region-pinned** to
    `ap-southeast-1`. Deploying elsewhere → swap the ARN from the per-region
    table at https://github.com/shelfio/chrome-aws-lambda-layer

## 1. Build the handler bundle + deploy
```bash
pnpm --filter @noy-db/recipe-aws-kms-pdf-attestation run bundle   # → dist/handler.cjs
cd recipes/aws-kms-pdf-attestation
npx cdk bootstrap   # one-time per account/region
npx cdk deploy      # creates KMS key + private S3 bucket + arm64 zip Lambda
                    # (+ Chromium layer) + Function URL
```
Note the `FunctionUrl`, `BucketName`, `KeyArn` outputs.

The bundle externalizes `@sparticuz/chromium` (the layer provides it at
`/opt/nodejs/node_modules`) and inlines `puppeteer-core`. The layer ships
Chromium v149 / `@sparticuz/chromium@149` — newer than the `^138` dev dep, which
is fine (the layer's JS shim + binary are self-consistent at runtime).

## 2. Seal + upload a sample document
Use `sealAndUpload` (a tiny script or REPL) with the deployed `KeyArn` + `BucketName`:
```ts
import { sealAndUpload } from '@noy-db/recipe-aws-kms-pdf-attestation/seal'
await sealAndUpload(
  { docId: '<docId-from-issueAttestation>', fields: {/* invoice fields */}, qr: '<qr>' },
  { keyId: '<KeyArn>', bucket: '<BucketName>', key: 'docs/<docId>' },
)
```

## 3. Invoke + verify (via a magic link)
The endpoint requires a signed share link — a bare `?docId=` is rejected (403).
Mint a link firm-side. You need the share secret string from Secrets Manager
(the function's `SHARE_SECRET_ARN`):
```bash
ARN=$(aws lambda get-function-configuration --function-name <RenderFn> \
  --query 'Environment.Variables.SHARE_SECRET_ARN' --output text)
SECRET=$(aws secretsmanager get-secret-value --secret-id "$ARN" \
  --query SecretString --output text)   # the ASCII share-signing secret
```
Then mint + fetch (the secret bytes are the utf8 encoding of that string —
identical to how the Lambda derives them):
```ts
import { mintShareLink } from '@noy-db/recipe-aws-kms-pdf-attestation/share-link'
const secret = new TextEncoder().encode(process.env.SECRET!) // the SECRET above
const url = await mintShareLink('<docId>', { secret, baseUrl: '<FunctionUrl>' })
// → https://<fn-url>/?d=<docId>&exp=<ms>&sig=<...>
```
```bash
curl -s "<minted-url>" -o invoice.pdf && file invoice.pdf            # → PDF document
curl -s -o /dev/null -w '%{http_code}\n' "<FunctionUrl>?docId=<docId>"  # → 403 (no token)
```
Open `invoice.pdf`; scan the QR with the offline verifier (recipe ④) — it must
read `authentic-valid` for the printed fields.

Links are **multi-use until `exp`** (default 24h, 7d cap). **Revocation = rotate
the Secrets Manager secret** (`aws secretsmanager rotate-secret`, or re-deploy a
fresh stack) — this invalidates all live links at once. No per-link revocation.

## 4. Teardown (after you confirm "done")
```bash
npx cdk destroy   # removes the key, bucket (auto-deletes objects), Lambda, URL
```
(The one-time `cdk bootstrap` CDKToolkit stack is left in place; delete it
separately if you want it gone.)

## Measured numbers (ap-southeast-1, 2026-05)

| | arm64 zip + layer (default) | x86_64 container (alternative) |
|---|---|---|
| Deploy artifact | ~1.7 MB zip + AWS-hosted 66 MB layer | ~527 MB ECR image |
| Cold (Init + first render) | ~505 ms + ~2.9 s | ~537 ms + ~2.9 s |
| Warm render | sub-second (browser reused) | sub-second |
| Memory used | ~515 MB / 2048 | ~515 MB / 2048 |

Cold/warm are effectively equal — the dominant cost is Chromium's
decompress-to-`/tmp` + launch, which is identical (same `@sparticuz` mechanism).
The layer route wins on **arm64 (~20% cheaper GB-s)**, a 300× smaller artifact,
and no Docker/ECR build chain.

## Container alternative (self-contained, no third-party layer)

The repo keeps a `Dockerfile` for an air-gapped/self-contained deploy that
doesn't depend on a public layer. It builds an **x86_64** image (the npm
`@sparticuz/chromium` binary is x86-only). To use it, point the CDK function at
a `DockerImageFunction` instead of the zip+layer (see git history for the
container `stack.ts`), build the bundle with
`--external:@sparticuz/chromium --external:puppeteer-core`, and `cdk deploy`
with a running Docker daemon. Trade-offs: larger artifact, x86_64 only, needs
Docker — but no external-ARN dependency.
