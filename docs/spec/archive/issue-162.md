# Issue #162 — feat(core): split-store routing — records to DynamoDB, blobs to S3 (tiered storage topology)

- **State:** closed
- **Author:** @vLannaAi
- **Created:** 2026-04-10
- **Closed:** 2026-04-10
- **Milestone:** v0.12.0
- **Labels:** type: feature, priority: medium, area: core, area: adapters

---

## Target package

`@noy-db/hub`

## Spawned from

v0.12 implementation session — blob store (#105) + multi-backend topology (#158). The blob store uses `_blob_chunks` as a regular collection routed through the same `NoydbStore` as records. This works but is the wrong trade-off for the most common production topology.

## Problem

Today, `createNoydb({ store })` takes a single `NoydbStore`. All data — records, keyrings, blob chunks, blob index, blob metadata — goes through that one store. This forces a painful choice:

### Option A: Everything in DynamoDB

```ts
const db = await createNoydb({
  store: dynamo({ table: 'myapp' }),
  ...
})
```

**Records:** Great. DynamoDB is fast, atomic CAS, scales to zero, ~$1.25/M writes.

**Blobs:** Terrible. A 10 MB PDF becomes **40 chunks** at 256 KB each (the max that fits after base64 inflation within DynamoDB's 400 KB item limit). That's:
- 40 write capacity units per upload ($0.00005 per upload — acceptable)
- 40 × 342 KB of **on-demand storage** at $0.25/GB/month — but the real cost is WCU/RCU for reads
- **No multipart upload** — each chunk is a separate `PutItem` call
- **No presigned URL** — can't let the browser upload directly to DynamoDB
- **No CDN integration** — can't put CloudFront in front of DynamoDB items

At 1,000 invoices × 3 PDFs × 2 MB average = **6 GB of blob data** stored as ~23,000 DynamoDB items instead of ~3,000 S3 objects. The DynamoDB bill is 10-50x the S3 bill for the same bytes.

### Option B: Everything in S3

```ts
const db = await createNoydb({
  store: s3Store({ bucket: 'myapp' }),
  ...
})
```

**Blobs:** Great. S3 handles any object size, has multipart upload, presigned URLs, CloudFront integration, and costs $0.023/GB/month.

**Records:** Terrible. S3 is an object store, not a database. Every `get()` is an HTTP round-trip (~50-100ms). `list()` returns 1,000 keys per page. No atomic CAS — the S3 store has `casAtomic: false`. No secondary indexes, no conditional writes, no transactions. For 5,000 small JSON records, S3 is 10-100x slower than DynamoDB for reads.

### The right answer is obvious

Every AWS architect draws the same diagram: **DynamoDB for structured data, S3 for binary objects.** This is the [Well-Architected](https://docs.aws.amazon.com/wellarchitected/latest/framework/welcome.html) baseline. But noy-db forces you to pick one.

The same pattern applies beyond AWS:
- **PostgreSQL + local filesystem** — records in Postgres, blobs on disk
- **Firestore + Cloud Storage** — records in Firestore, blobs in GCS
- **SQLite + filesystem** — records in SQLite, attachments in a sibling directory
- **IndexedDB + OPFS** — records in IDB, large files in Origin Private File System

## Existing infrastructure

v0.12 already ships the building blocks:

1. **Well-known collection prefixes** — blob data lives in `_blob_chunks`, `_blob_index`, `_blob_slots_*`, `_blob_versions_*`. These are distinguishable from user collections by prefix.
2. **`SyncTarget[]` (#158)** — multi-backend topology for *replicas*, but not for *primary storage splits*.
3. **`StoreCapabilities.maxBlobBytes`** — lets stores declare their chunk size limit. But chunking 100 MB into 400 small DynamoDB items is a workaround, not a solution, when S3 exists.
4. **`NoydbStore` is 6 methods** — `get`, `put`, `delete`, `list`, `loadAll`, `saveAll`. A router that dispatches these to different backends based on collection name is trivial to build.

## Proposed solution: `routeStore()`

A store multiplexer that dispatches operations to different backends based on collection name:

```ts
import { routeStore } from '@noy-db/hub'
import { dynamo } from '@noy-db/to-aws-dynamo'
import { s3Store } from '@noy-db/to-aws-s3'

const db = await createNoydb({
  store: routeStore({
    // All user collections, keyrings, sync metadata
    default: dynamo({ table: 'myapp' }),
    // Binary blob chunks only — stored as single S3 objects (no chunking needed)
    blobs: s3Store({ bucket: 'myapp-blobs' }),
  }),
  user: 'alice',
  secret: passphrase,
})
```

### Routing rules

```ts
interface RouteStoreOptions {
  /** Store for records, keyrings, sync metadata, and blob metadata. */
  default: NoydbStore
  /**
   * Store for blob chunk data (`_blob_chunks` collection).
   * When set, `maxBlobBytes` is automatically `undefined` (no chunking) —
   * each blob is stored as a single object, leveraging S3's native
   * multipart upload and CDN integration.
   */
  blobs: NoydbStore
  /**
   * Optional: route blob index and slot metadata to the blob store too.
   * Default: false — keeps blob metadata in the default store for
   * fast queries alongside records.
   */
  routeBlobMeta?: boolean
}
```

**Default routing (recommended):**

| Collection pattern | Routes to | Rationale |
|---|---|---|
| `_blob_chunks` | `blobs` | Large binary data → S3/filesystem |
| `_blob_index` | `default` | Small metadata, needs fast lookup → DynamoDB |
| `_blob_slots_*` | `default` | Slot metadata, queried alongside records → DynamoDB |
| `_blob_versions_*` | `default` | Version metadata → DynamoDB |
| `_keyring` | `default` | Auth material → DynamoDB |
| `_sync*`, `_ledger*` | `default` | System metadata → DynamoDB |
| Everything else | `default` | User collections → DynamoDB |

When `routeBlobMeta: true`, `_blob_index`, `_blob_slots_*`, and `_blob_versions_*` also route to `blobs`. This is useful when the blob store is a full database (PostgreSQL, SQLite) not just an object store.

### Automatic `maxBlobBytes` override

When `routeStore({ blobs })` is used, the blob store's `maxBlobBytes` is automatically set to `undefined` (no chunking). This means:
- A 10 MB PDF is stored as **one S3 object**, not 40 DynamoDB items
- The `BlobObject.chunkCount` will be `1` for any blob size
- S3's native multipart upload handles large files efficiently

### `loadAll` / `saveAll` composition

`loadAll(vault)` merges snapshots from both stores. `saveAll(vault, data)` partitions the snapshot and writes to each store. The router handles this transparently.

### Capabilities composition

```ts
routeStore.capabilities = {
  casAtomic: default.capabilities.casAtomic,  // inherits from default
  auth: default.capabilities.auth,
  maxBlobBytes: undefined,  // always undefined — blobs go to the blob store
}
```

## Implementation sketch

```ts
export function routeStore(opts: RouteStoreOptions): NoydbStore {
  const { default: primary, blobs, routeBlobMeta = false } = opts

  function isBlob(collection: string): boolean {
    if (collection === '_blob_chunks') return true
    if (!routeBlobMeta) return false
    return collection === '_blob_index'
      || collection.startsWith('_blob_slots_')
      || collection.startsWith('_blob_versions_')
  }

  function storeFor(collection: string): NoydbStore {
    return isBlob(collection) ? blobs : primary
  }

  return {
    name: `route(${primary.name ?? 'default'}+${blobs.name ?? 'blobs'})`,

    get:    (v, c, id)          => storeFor(c).get(v, c, id),
    put:    (v, c, id, env, ev) => storeFor(c).put(v, c, id, env, ev),
    delete: (v, c, id)          => storeFor(c).delete(v, c, id),
    list:   (v, c)              => storeFor(c).list(v, c),

    async loadAll(vault) {
      const [a, b] = await Promise.all([primary.loadAll(vault), blobs.loadAll(vault)])
      return { ...a, ...b }
    },
    async saveAll(vault, data) {
      const primaryData: VaultSnapshot = {}
      const blobData: VaultSnapshot = {}
      for (const [coll, records] of Object.entries(data)) {
        (isBlob(coll) ? blobData : primaryData)[coll] = records
      }
      await Promise.all([
        primary.saveAll(vault, primaryData),
        blobs.saveAll(vault, blobData),
      ])
    },
  }
}
```

## Scope

- [ ] `routeStore(options)` exported from `@noy-db/hub`
- [ ] Routes `_blob_chunks` to `blobs` store by default
- [ ] Optional `routeBlobMeta: true` routes all blob collections to `blobs`
- [ ] `loadAll` / `saveAll` correctly compose across both stores
- [ ] Automatic `maxBlobBytes: undefined` when blob store is set
- [ ] Forward optional methods (`listPage`, `listVaults`, `ping`, `listSince`) to the appropriate store
- [ ] Tests: route correctness, loadAll merging, saveAll partitioning, mixed blob+record operations
- [ ] Integration test: DynamoDB records + S3 blobs round-trip
- [ ] Changeset

## Non-goals

- Store-level transactions across both backends (not possible with S3)
- Automatic migration from single-store to split-store topology
- Per-collection custom routing beyond the blob/default split (v2 maybe)

## Invariant compliance

- [x] Adapters never see plaintext — both stores receive only ciphertext
- [x] KEK/DEK handling unchanged — encryption happens in hub before reaching any store
- [x] Zero new crypto dependencies
- [x] 6-method store contract preserved — `routeStore` returns a standard `NoydbStore`

## Related

- #105 — Encrypted binary blob store (creates the `_blob_*` collections)
- #158 — Multi-backend topology SyncTarget[] (parallel concept for replicas)
- #103 — NoydbBundleStore (bundle stores may also benefit from split routing)
- Discussion #137 — multi-backend design rationale

## Cost comparison (1,000 invoices × 3 PDFs × 2 MB avg)

| Topology | Monthly blob storage | Monthly blob I/O | Total blob cost |
|---|---|---|---|
| DynamoDB only | ~$1.50 (6 GB × $0.25) | ~$2.90 (23K items × $1.25/M WCU × writes) | **~$4.40/mo** |
| S3 only | ~$0.14 (6 GB × $0.023) | ~$0.02 (3K PUTs × $5/M) | **~$0.16/mo** |
| **Split (proposed)** | ~$0.14 (S3) + ~$0.01 (DynamoDB metadata) | ~$0.02 (S3) + ~$0.01 (DynamoDB) | **~$0.18/mo** |

**27x cost reduction** for blob storage by routing chunks to S3.

v0.12.
