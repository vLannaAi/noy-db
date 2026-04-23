# Issue #149 — refactor(stores): rename store-s3 → store-aws-s3 and drop MinimalS3Client abstraction

- **State:** closed
- **Author:** @vLannaAi
- **Created:** 2026-04-09
- **Closed:** 2026-04-09
- **Milestone:** v0.10.0
- **Labels:** _(none)_

---

## Summary

Rename `@noy-db/store-s3` to `@noy-db/store-aws-s3` and replace the `MinimalS3Client` duck-typing interface with a direct `@aws-sdk/client-s3` dependency.

## Changes

- `packages/store-s3/` → `packages/store-aws-s3/`
- `package.json` name: `@noy-db/store-s3` → `@noy-db/store-aws-s3`
- Remove `MinimalS3Client` interface and all duck-typing around it
- Import and use `S3Client`, `GetObjectCommand`, `PutObjectCommand`, `DeleteObjectCommand`, `ListObjectsV2Command` directly from `@aws-sdk/client-s3`
- Move `@aws-sdk/client-s3` from peer dep hint to explicit `peerDependencies`
- Remove `endpoint` escape hatch (MinIO/LocalStack workaround) — consumers who need S3-compatible non-AWS stores will get dedicated packages
- Update all internal references, CI workflows, playground, create-noy-db templates
- Bump to v0.10.0

## Rationale

The current `MinimalS3Client` interface is a premature abstraction. The store is built on `@aws-sdk/client-s3`, tested against AWS S3, and the `endpoint` override for MinIO/LocalStack is untested duck typing — not a real multi-provider abstraction.

The clean model: one package per provider, each using its native SDK.
```
@noy-db/store-aws-s3   ← AWS SDK, AWS only (this issue)
@noy-db/store-r2       ← Cloudflare SDK (v0.11 #104 area)
```

## Related
- #148 — store-dynamo → store-aws-dynamo (companion rename)
