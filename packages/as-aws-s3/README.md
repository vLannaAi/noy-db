# @noy-db/as-aws-s3

An **`ObjectProjection`** for noy-db backed by AWS S3 — hold blob bytes as
**native, directly-consumable S3 objects** (presigned or public) instead of
encrypted-envelope chunks.

`to-aws-s3` is the zero-knowledge **store** (ciphertext in/out). `as-aws-s3` is
an `as-*` **projection**: raw bytes that can be served straight from S3/CDN and
processed by AWS-native tooling. It lives **outside** the zero-knowledge
guarantee — wiring it to a blob field is a deliberate, per-field opt-in.

```ts
import { asAwsS3 } from '@noy-db/as-aws-s3'

const objects = asAwsS3({ bucket: 'acme-public-assets', region: 'eu-west-1' })

await objects.putObject('logos/acme.png', bytes, { contentType: 'image/png', public: true })
objects.publicUrl('logos/acme.png')              // stable CDN/S3 URL
await objects.objectUrl('docs/x.pdf')            // presigned GET (time-limited)
await objects.putUrl('videos/x.mp4', { contentType: 'video/mp4' }) // presigned PUT (direct upload)
```

## Options

| Option | Default | Notes |
|---|---|---|
| `bucket` | — | Target bucket (required). |
| `prefix` | `''` | Key prefix (folder). |
| `region` | `us-east-1` | AWS region. |
| `client` | new client | Share a pre-built `S3Client`. |
| `baseUrl` | virtual-hosted S3 URL | CDN origin for `publicUrl()`. |
| `defaultExpiresInSeconds` | `900` | Presigned-URL TTL. |

## Security

Objects written here are **not encrypted** by noy-db. Prefer presigned
(`objectUrl`) over public for anything sensitive, scope the bucket tightly, and
treat public objects as **not crypto-shreddable**.

This is a deliberate exception to noy-db's usual guarantee: everywhere else, a
storage backend only ever holds ciphertext. Direct-serve exists so a browser can
fetch an object without going through the vault, which requires readable bytes
in the bucket. Decide per field, not per project.

## Peer dependencies

`@noy-db/hub`, `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`.
