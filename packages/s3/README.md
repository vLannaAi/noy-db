# @noy-db/s3

> AWS S3 adapter for [noy-db](https://github.com/vLannaAi/noy-db) — encrypted object storage with zero-knowledge cloud sync.

[![npm](https://img.shields.io/npm/v/@noy-db/s3.svg)](https://www.npmjs.com/package/@noy-db/s3)

## Install

```bash
pnpm add @noy-db/core @noy-db/s3 @aws-sdk/client-s3
```

`@aws-sdk/client-s3` is a peer dependency — install it in your app.

## Usage

```ts
import { createNoydb } from '@noy-db/core'
import { s3 } from '@noy-db/s3'
import { S3Client } from '@aws-sdk/client-s3'

const client = new S3Client({ region: 'ap-southeast-1' })

const db = await createNoydb({
  adapter: s3({ client, bucket: 'noydb-prod', prefix: 'tenant-a/' }),
  userId: 'alice',
  passphrase: process.env.NOYDB_PASSPHRASE!,
})
```

Each record becomes an S3 object containing only a ciphertext envelope. S3 never sees plaintext — even with full bucket access, an attacker learns nothing without the user's passphrase.

Best suited for:

- Infrequent-access archival with strong privacy guarantees
- Cold storage of audit trails and backups
- Lower-cost alternative to DynamoDB for small teams

## License

MIT © vLannaAi — see the [noy-db repo](https://github.com/vLannaAi/noy-db) for full documentation.
