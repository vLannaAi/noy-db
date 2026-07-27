# Blobs — the `blob` via-feature

`blobFields` declares which fields on a collection carry binary attachments (images, PDFs,
receipts) instead of ordinary JSON values — content lives in chunked, AEAD-encrypted
side-collections (`BlobSet`), not the record's own envelope. Since #629 (phase B), the
declaration itself is a **via-feature** (`_viaBrand: 'blob'`): it participates in the same
posture-enforcement machinery money/i18n/classified do (see [`docs/subsystems/via.md`](via.md)) —
but the binding is deliberately **thin**. Blob content crypto is real chunked-AEAD/key-lifecycle
engine work that the `via-enclave-isolation` architecture rule forbids under `via/*`, so
that machinery stays exactly where it was pre-#629, at `with-shape/blobs/` (service-side); the
via binding contributes only declaration + posture + `describeFragment` + an `erase` hook.

Enable blob storage with `blobsStrategy: withBlobs()` (subpath `@noy-db/hub/blobs`).

## Declaring fields

```ts
import { createNoydb } from '@noy-db/hub'
import { withBlobs } from '@noy-db/hub/blobs'

interface InvoiceScan {
  id: string
  status: string
}

const db = await createNoydb({ user: 'owner', secret: 'pw', blobsStrategy: withBlobs() })
const vault = await db.openVault('v1')
const scans = vault.collection<InvoiceScan>('invoiceScans', {
  blobFields: {
    image: { evictWhen: (rec) => rec.status === 'confirmed' },
  },
})
await scans.put('s1', { id: 's1', status: 'confirmed' })
await scans.blob('s1').put('image', new TextEncoder().encode('x'))
```

(from `packages/hub/__tests__/blob-compaction.test.ts`). A field's policy object is a plain
literal — every knob is optional (`{}` is a valid, no-op policy):

- `retainDays: number` — TTL eviction: `vault.compact()` evicts slots older than
  `now - retainDays × 86400s`.
- `evictWhen: (record) => boolean` — predicate eviction over the decrypted record.
- `legalHold: (record) => boolean` — a `true` result blocks eviction outright, TTL or predicate.
- `retainUntil: (record) => Date | string | number | null | undefined` — a hard floor date (or
  `null`/`undefined` for no floor) under which eviction never fires.
- `external: true` — the slot is treated as an externally-stored object (see
  `ObjectProjection`), not an inline `BlobSet` chunk.
- `public: true` — opts the slot into unauthenticated public URL serving.
- `backlink: 'opaque-token' | 'encrypted' | 'plain' | 'none'` — for an `external` field, selects
  how a backlink (this record's vault/collection/id/field) is stamped onto the object's metadata,
  the self-describing "secondary store" that powers reconcile / DR / import re-pairing:
  `'opaque-token'` (default) is a random id, preserving the opaque-bucket property (no names
  leak), also recorded on the slot; `'encrypted'` is the reference encrypted under the blob DEK
  (ZK-preserving; falls back to `'opaque-token'` on a plaintext vault); `'plain'` is the reference
  in cleartext metadata — leaks structure to bucket readers, only for non-sensitive deployments;
  `'none'` means no backlink.

Run eviction with `vault.compact()`, which returns a `CompactionResult` — `evicted`, `records`,
`collections`, `auditEntries`, `held`, `pinned`, `budgetEvicted`, `budgetBytesFreed`, and a
per-collection `byCollection: Record<string, { records, evicted }>` breakdown
(`packages/hub/src/with-shape/blobs/blob-compaction.ts`).

## Mobile blob strategy — offline pinning + cache budget (#808)

On top of the on-demand read path, blobs carry a client-intent layer for
mobile/offline consumers: **"keep this document offline"** per slot, plus a
size-budgeted LRU for everything else.

### Pin / unpin

```ts
const blob = scans.blob('s1')
await blob.pin('image')            // eager download (call while online) + eviction exemption
await blob.isPinned('image')       // → true
await blob.unpin('image')          // back to the normal lifecycle
```

- **Eager download.** Pinning an unfetched slot fetches it immediately: an internal
  blob's chunks are read once to prove they are locally available; an `external`
  slot's bytes are fetched from the object store into a local encrypted side-cache.
- **Eviction exemption.** A pinned slot is skipped by BOTH `vault.compact()` passes —
  the `blobFields` policy pass (counted in `CompactionResult.pinned`) and the
  `cacheBudget` LRU pass (not even counted toward the budget). `unpin()` returns the
  slot to the normal lifecycle.
- **Device-local, never synced.** Pin state lives in the `withBlobs()` **pin
  registry**, never in the vault store — each device pins for itself. The default
  registry is in-memory (pins last one app session); pass a durable, device-local
  backend to keep them across restarts:

```ts
import { withBlobs, type BlobPinStore } from '@noy-db/hub/blobs'
const blobsStrategy = withBlobs({ pinStore: myIdbBackedPinStore }) // 4-method BlobPinStore
```

The hub itself ships only the in-memory default — it has no device-persistence
layer of its own (persistence backends are the `to-*` family), so a production
mobile/web app supplies an IndexedDB/SQLite-backed `BlobPinStore`.

### Cache budget (LRU)

```ts
await vault.compact({ cacheBudget: { maxBytes: 50 * 1024 * 1024 } })
```

After the policy pass, a dedicated budget pass inside the SAME compaction run
walks every collection's slots and evicts **oldest-access-first** until the
locally-cached **unpinned** bytes fit `maxBytes`:

- internal slots evict through the standard eviction writer (`delete()` + a
  `'budget'`-reason audit entry) and count their uncompressed `size`;
- `external` slots only drop their **device-local cached copy** (the object-store
  copy is authoritative and untouched) and count `cachedBytes`;
- pinned slots and `legalHold`/`retainUntil`-held slots are exempt and uncounted.

LRU order comes from the device-local last-read stamp (`SlotInfo.lastAccessAt`,
maintained by `get()`), falling back to `uploadedAt`. Results land in
`CompactionResult.budgetEvicted` / `budgetBytesFreed`; `dryRun: true` previews.

### Offline read taxonomy

`get()` never hangs and never silently returns an empty file:

| State | internal (chunked) | `external: true` |
|---|---|---|
| pinned | readable (chunks local, eviction-exempt) | readable (encrypted local copy) |
| unpinned + cached | readable | readable (reads auto-populate the local cache) |
| unpinned + cold + offline | `BlobOfflineError` (chunk absent from the local store) | `BlobOfflineError` (no local copy, object store unreachable) |

`BlobOfflineError` (`code: 'BLOB_OFFLINE'`, fields `collection`/`recordId`/`slotName`,
original network failure as `cause`) means "exists, just not here right now" — UIs
render *available when online*. A genuinely absent slot stays `null`; a genuinely
deleted external object (fetch succeeded, nothing there) stays `null` too.

### External pins — encryption posture

An `external: true` slot's object-store copy sits **outside the zero-knowledge
envelope by design** (raw, servable). The local pinned/cached copy does NOT: it is
AES-256-GCM-encrypted under the vault's `_blob` DEK through the same enclave path
that encrypts blob chunks (`encryptBytesWithAAD`, AAD-bound to the registry row's
key) before it touches the pin registry. A stolen device store therefore leaks
nothing the vault store wouldn't; plaintext bytes never rest in the registry. On an
unencrypted vault (`encrypt: false`) the copy is stored base64-plain, mirroring the
envelope convention.

### KPI counters

```ts
const blobsStrategy = withBlobs()
// … reads happen …
blobsStrategy.cacheStats() // → { hits, misses, bytesDownloaded }
```

Local reads (internal chunks, cached external copies) count as `hits`; object-store
fetches count as `misses` and add to `bytesDownloaded` — the number a 4G-budget
demo charts. Counters are per-`withBlobs()`-instance (per device), like the registry.

## Query posture — `queryable: 'none'`: a NEW refusal (not parity)

Unlike classified's `det-exact` (silent no-match, unchanged by phase B — see
[`via-classified.md`](via-classified.md)), blob's `queryable: 'none'` posture is a genuinely new
behavior: before #629 a `blobFields`-declared field simply wasn't present in the decrypted record,
so `.where()`/`.orderBy()`/`.aggregate()` silently no-op or (for a bare-spec `sum()`) coerce to
`0`. After #629 the query DSL explicitly refuses it with `FieldNotQueryableError`:

```ts
interface Doc { id: string; title: string; receipt: string }

// aggregateStrategy: withAggregate() is required for .aggregate() itself — unrelated to blob
const db = await createNoydb({ user: 'a', secret: 'pw', aggregateStrategy: withAggregate() })
const v = await db.openVault('v1')
const c = v.collection<Doc>('docs', { blobFields: { receipt: {} } })
await c.put('d1', { id: 'd1', title: 'x', receipt: 'unused-placeholder' })

expect(() => c.query().where('receipt', '==', 'x')).toThrow(FieldNotQueryableError)
expect(() => c.query().orderBy('receipt')).toThrow(FieldNotQueryableError)
expect(() => c.query().aggregate({ n: sum('receipt') })).toThrow(FieldNotQueryableError)
expect(() => c.scan().where('receipt', '==', 'x')).toThrow(FieldNotQueryableError)
```

(from `packages/hub/__tests__/via/query-posture-b.test.ts`, `TDD (#629 Task 8): blobFields refuse
.where()/.orderBy()/.aggregate()`). This refusal is driven purely by the declared posture — it
fires even without `blobsStrategy: withBlobs()` configured, since it's a metadata check, not a
crypto operation. A reducer with no `.field` (bare `count()`) is unaffected — there's nothing to
gate:

```ts
expect(await c.scan().aggregate({ n: count() })).toEqual({ n: 1 })  // still works
```

## Export posture — unredacted, by design

Blob's `ViaPosture.exportable` is `true` — a `blobFields`-declared field is ordinary plain data on
the record (no write-pipeline hook strips it), so `Vault.exportStream()`'s posture-driven
redaction leaves it untouched:

```ts
const b = blobBinding({ fields: { receipt: {} }, collectionName: 'c' })
const p = ViaPipeline.build([b])!
const record = { id: 'r1', receipt: 'stored-plain-value' }
expect(p.redactForExport(record)).toBe(record)   // same reference — nothing to redact
```

(from `packages/hub/__tests__/via/export-posture-b.test.ts`). Actual blob *content* (the bytes
themselves) has its own dedicated bulk-extraction door, `vault.exportBlobs()` — unaffected by
this posture flip, unchanged since before #629.

## Forget / erasure

Blob's `ViaPosture.forgettable` is `true`, and the binding declares a real, unit-tested `erase`
hook (`purgeBlobsForRecord`, mapping `collection.blob(id).shredAllForRecord()`'s
`{shredded, retainedShared, residue}` accounting onto the shared `ViaEraseReport` shape):

```ts
const report: ViaEraseReport = { shredded: 2, residue: [{ kind: 'blob-legacy-residue', eTag: 'etag-1' }] }
const purgeBlobsForRecord = vi.fn(async (_id: string) => report)
const b = blobBinding(cfg({ purgeBlobsForRecord }))
await expect(b.erase!(eraseCtxFixture())).resolves.toEqual(report)
```

(from `packages/hub/__tests__/via/blob-binding.test.ts`). **This hook is not wired into
production, on purpose.** `vault.forget()`'s blob-shred call site
(`this.collection(ref.collection).blob(ref.id).shredAllForRecord()`) is gated by DEFAULT **only**
on whether the vault's `blobsStrategy` is configured — never on whether the specific collection
declared `blobFields` — proven by `per-blob-cek.test.ts`/`forget.test.ts`, which crypto-shred blobs
on `forget()` for collections calling `.blob(id)` with **no** `blobFields` declaration at all. Routing
blob-shred exclusively through this binding's `erase()` hook would silently stop crypto-shredding
blobs for every such collection, so `vault.forget()` keeps calling
`collection.blob(id).shredAllForRecord()` directly; `purgeBlobsForRecord` stays real, tested, and
available for a future collection-scoping-aware caller. See
[`via.md`](via.md) (Phase B section) for the identical note on classified's sealed-CEK purge.

### #633 — the opt-in `scopedPurge` knob, blob arm

The same `SubjectDeclaration.scopedPurge` knob documented in
[`via-classified.md`](via-classified.md#633--the-opt-in-scopedpurge-knob) also gates this arm, keyed
off whether the collection declared a `blobFields` config (`this.blobFieldsRegistry.has(ref.collection)`
inside `vault.forget()`) rather than any `classifiedFields` binding:

```ts
const declared = vault.collection('invoicesDeclared', { blobFields: { 'contract.pdf': {} } })
// undeclared: no blobFields option, yet `.blob(id)` is still called directly —
// exactly the gap #633 names.
const undeclared = vault.collection('invoicesUndeclared')
```

Under `scopedPurge: true`, an undeclared collection's blob scan is skipped **entirely** — no
`.blob(id).shredAllForRecord()` call AND no `_blob_slots_<collection>` residue-detection `list()`
call either, which is the perf win scoping buys (`scoped-purge.test.ts` (c) spies the store's
`list()` calls to pin that the skipped collection is never scanned at all). The skip is reported,
never silent: `ForgetResult.scopedPurgeResidue` gains a `{ reason:
'skipped-undeclared-blob-scan', collection, count }` entry, `count` counting the refs whose scan was
skipped (aggregated per collection across the whole `forget()` call). The undeclared collection's
blobs survive completely untouched — never scanned, never shredded — until either `blobFields` is
declared for it or `scopedPurge` is turned off.

## Architecture

`blobBinding(cfg)` (`packages/hub/src/via/blob/binding.ts`) returns a `ViaBinding` with
`brand: 'blob'` and
`posture: { encryptedAtRest: 'envelope', queryable: 'none', exportable: true, forgettable: true }`.
It declares **no** write/read pipeline hooks at all — no `enforceWrite`, no `encodeAtRest`/
`decodeAtRest`, no query-clause hooks:

```ts
const b = blobBinding(cfg())
expect(b.encodeAtRest).toBeUndefined()
expect(b.decodeAtRest).toBeUndefined()
expect(b.enforceWrite).toBeUndefined()
```

(from `packages/hub/__tests__/via/blob-binding.test.ts`) — because blob content never flows
through `_putInternal` or the record codec at all (`collection.blob(id)` writes directly to
`BlobSet` side-collections). This matters mechanically: a blob-only pipeline must keep
`hasAtRestHooks` `false`, or the codec would abandon its inline seal path for a feature that never
actually seals a record field:

```ts
const pipeline = ViaPipeline.build([blobBinding(cfg())])
expect(pipeline!.hasAtRestHooks).toBe(false)
```

`via-blob`'s barrel (`packages/hub/src/via/blob/index.ts`, subpath `@noy-db/hub/blobs`) is
where `withBlobs()` and the declarative/strategy layer live; `BlobSet`, `mime-magic`,
`blob-compaction`, and `export-blobs` — the actual content-crypto machinery — stay at
`packages/hub/src/with-shape/blobs/`, re-exported through the same barrel for backward
compatibility. `via-blob` never imports `kernel/enclave/` and never touches `ViaCryptoCtx`
(`via-enclave-isolation` holds with an empty allowlist for it, same as `via-classified`).

## See also

- [`docs/subsystems/via.md`](via.md) — the Via port (field features, unified pipeline, phases)
- [`docs/subsystems/via-classified.md`](via-classified.md) — the sibling phase-B security feature
- `packages/hub/src/via/blob/` — the thin binding + strategy/barrel
- `packages/hub/src/with-shape/blobs/` — `BlobSet` + compaction + export-blobs (service-side content crypto)
- `packages/hub/__tests__/via/blob-binding.test.ts`, `packages/hub/__tests__/via/query-posture-b.test.ts`, `packages/hub/__tests__/via/export-posture-b.test.ts` — the phase-B binding/posture suites
- `packages/hub/__tests__/blob-compaction.test.ts`, `packages/hub/__tests__/per-blob-cek.test.ts` — the pre-existing content/compaction/forget suites
