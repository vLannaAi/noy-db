# Issue #176 — feat(to-cloudflare-r2): @noy-db/to-cloudflare-r2 — S3-compatible KV, no egress fees

- **State:** closed
- **Author:** @vLannaAi
- **Created:** 2026-04-21
- **Closed:** 2026-04-23
- **Milestone:** Fork · Stores (@noy-db/to-*)
- **Labels:** type: feature, area: adapters

---

Cloudflare R2 is S3-API-compatible with zero egress fees. Implement a KV-shaped store on top of the S3 SDK (likely just a thin config wrapper around @noy-db/to-aws-s3 with R2 endpoint + signing). Pair with DynamoDB-like primary via routeStore for records/blobs split without bandwidth costs.
