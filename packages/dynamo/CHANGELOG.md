# @noy-db/dynamo

## 1.0.0

### Patch Changes

- Updated dependencies [2d38d62]
- Updated dependencies [2d38d62]
- Updated dependencies [2d38d62]
- Updated dependencies [2d38d62]
- Updated dependencies [2d38d62]
  - @noy-db/core@0.7.0

## 0.6.0

### Patch Changes

- Updated dependencies [755f151]
- Updated dependencies [92f2000]
- Updated dependencies [36dbdbc]
- Updated dependencies [f968f83]
- Updated dependencies [bd21ad7]
- Updated dependencies [d90098a]
- Updated dependencies [958082b]
- Updated dependencies [f65908a]
  - @noy-db/core@0.6.0

## 0.5.0

### Initial release

AWS DynamoDB adapter for `@noy-db/core` — single-table design, zero-knowledge cloud sync. Intended for multi-device workloads where the cloud provides the sync substrate and `noy-db`'s encryption ensures DynamoDB only ever sees ciphertext.

Single-table schema: one DynamoDB table per `Noydb` instance, with a composite primary key `(compartment#collection, id)` so every compartment's data lives in the same table with natural partition boundaries. Implements every mandatory method on `NoydbAdapter` (`get`, `put`, `delete`, `list`, `loadAll`, `saveAll`) plus the optional `listPage` pagination capability (cursor is a base64-encoded `LastEvaluatedKey` JSON) and `ping` for connectivity checks.

Zero-knowledge property: DynamoDB admins, IAM role holders, and anyone with `dynamodb:GetItem` on the table see only encrypted envelopes. The DEKs required to decrypt any record live exclusively in the user's in-memory keyring, wrapped by their KEK which is derived from their passphrase via PBKDF2.

Peer dependencies: `@aws-sdk/client-dynamodb ^3.0.0`, `@aws-sdk/lib-dynamodb ^3.0.0`.
