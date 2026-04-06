---
"@noy-db/core": minor
"@noy-db/memory": minor
"@noy-db/file": minor
"@noy-db/browser": minor
"@noy-db/dynamo": minor
"@noy-db/s3": minor
---

Add `listPage()` adapter extension and `Collection.scan()` streaming API.

The 6-method core adapter contract is unchanged — `listPage` is an **optional** extension that adapters opt into. All five built-in adapters (memory, file, browser, dynamo, s3) now implement it natively. Adapters that don't get a synthetic fallback over `list() + get()` with a one-time console warning.

```ts
// Stream every record without loading the whole collection into memory
for await (const record of invoices.scan({ pageSize: 500 })) {
  await processOne(record);
}

// Or fetch a single page directly
const page = await invoices.listPage({ limit: 100 });
// page.items = decrypted records
// page.nextCursor = opaque cursor for the next page (null on the last page)
```

Each adapter encodes its own paging state:

- **memory**, **file**, **browser**: numeric offset of a sorted id list
- **dynamo**: base64-encoded `LastEvaluatedKey` JSON
- **s3**: native `ContinuationToken`

Adapters now also have an optional `name` field for diagnostic logging. The encryption boundary is preserved — every page is decrypted in core after the adapter returns ciphertext.

Closes #14.
