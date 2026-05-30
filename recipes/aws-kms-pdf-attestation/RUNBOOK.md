# RUNBOOK — deploy, verify, teardown (real AWS)

All AWS access uses a NAMED PROFILE you provide (`export AWS_PROFILE=<name>`),
never raw or shared credentials. Each resource-creating step is confirmed first.

## Prereqs
- An AWS profile with permission to create KMS/S3/Lambda/IAM + run CDK.
- Docker (for the arm64 Lambda container image).
- `export AWS_PROFILE=<your-profile>` and `export AWS_REGION=<region>`.

## 1. Build the handler bundle + image-deploy
```bash
pnpm --filter @noy-db/recipe-aws-kms-pdf-attestation run bundle   # → dist/handler.js
cd recipes/aws-kms-pdf-attestation
npx cdk bootstrap   # one-time per account/region
npx cdk deploy      # creates KMS key + private S3 bucket + container Lambda + Function URL
```
Note the `FunctionUrl`, `BucketName`, `KeyArn` outputs.

## 2. Seal + upload a sample document
Use `sealAndUpload` (a tiny script or REPL) with the deployed `KeyArn` + `BucketName`:
```ts
import { sealAndUpload } from '@noy-db/recipe-aws-kms-pdf-attestation/seal'
await sealAndUpload(
  { docId: '<docId-from-issueAttestation>', fields: {/* invoice fields */}, qr: '<qr>' },
  { keyId: '<KeyArn>', bucket: '<BucketName>', key: 'docs/<docId>' },
)
```

## 3. Invoke + verify
```bash
curl -s "<FunctionUrl>?docId=<docId>" -o invoice.pdf
file invoice.pdf   # → PDF document
```
Open `invoice.pdf`; scan the QR with the offline verifier (recipe ④) — it must
read `authentic-valid` for the printed fields.

## 4. Teardown (after you confirm "done")
```bash
npx cdk destroy   # removes the key, bucket (auto-deletes objects), Lambda, URL
```
