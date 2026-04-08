# @noy-db/s3

## 0.5.0

### Initial release

AWS S3 adapter for `@noy-db/core` — encrypted object storage with zero-knowledge cloud sync. Intended for long-term archival, cheapest-possible storage, and workloads where an S3 bucket is the natural destination.

One S3 object per record, organized as `{compartment}/{collection}/{id}.json` under an optional prefix. ETag-based optimistic concurrency implements the `expectedVersion` check: `put` uses `If-Match` against the last known ETag and translates S3's `PreconditionFailed` into noy-db's `ConflictError`. Implements every mandatory method on `NoydbAdapter` (`get`, `put`, `delete`, `list`, `loadAll`, `saveAll`) plus the optional `listPage` pagination capability (cursor is the S3 `ContinuationToken`).

Zero-knowledge property: S3 bucket owners, IAM role holders, and anyone with `s3:GetObject` on the bucket see only encrypted envelopes. The DEKs required to decrypt any record live exclusively in the user's in-memory keyring.

Peer dependencies: `@aws-sdk/client-s3 ^3.0.0`.
