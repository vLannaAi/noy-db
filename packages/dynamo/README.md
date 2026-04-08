# @noy-db/dynamo

> AWS DynamoDB adapter for [noy-db](https://github.com/vLannaAi/noy-db) — single-table design, zero-knowledge cloud sync.

[![npm](https://img.shields.io/npm/v/@noy-db/dynamo.svg)](https://www.npmjs.com/package/@noy-db/dynamo)

## Install

```bash
pnpm add @noy-db/core @noy-db/dynamo @aws-sdk/client-dynamodb @aws-sdk/lib-dynamodb
```

`@aws-sdk/*` packages are peer dependencies — install them in your app.

## Usage

```ts
import { createNoydb } from '@noy-db/core'
import { dynamo } from '@noy-db/dynamo'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'

const client = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'ap-southeast-1' }))

const db = await createNoydb({
  adapter: dynamo({ client, tableName: 'noydb-prod' }),
  userId: 'alice',
  passphrase: process.env.NOYDB_PASSPHRASE!,
})
```

Uses a single-table design with composite keys `(PK=compartment, SK=collection#id)`. DynamoDB only ever sees encrypted envelopes — the ciphertext is useless without the user's passphrase.

## DynamoDB table schema

- Partition key: `PK` (String) — compartment name
- Sort key: `SK` (String) — `collection#id`
- Attributes: `_v`, `_ts`, `_iv`, `_data`, `_by` — the encrypted envelope

## License

MIT © vLannaAi — see the [noy-db repo](https://github.com/vLannaAi/noy-db) for full documentation.
