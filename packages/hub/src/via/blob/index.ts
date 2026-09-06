/**
 * @noy-db/hub/blobs — opt-in blob / document service.
 *
 * @category capability
 *
 * This subpath fronts every blob-storage entry point: `BlobSet`
 * (slot-based attachments with chunked encryption and dedup),
 * `mime-magic` (MIME detection from magic bytes), `blob-compaction`
 * (TTL eviction via `blobFields`), `export-blobs` (bulk export
 * primitive), and the legacy `attachments` API. The barrel + the
 * `withBlobs()` factory live here in `via/blob/` (#629 Task 7);
 * the content-crypto machinery itself stays in `with-shape/blobs/`
 * (service-side — it does real chunk AEAD/key-lifecycle work the
 * `via-enclave-isolation` guard forbids under `via/*`).
 *
 * Hub's root barrel (`@noy-db/hub`) still re-exports `BlobSet` + the
 * MIME helpers for backward compatibility with `@noy-db/as-blob`,
 * `@noy-db/as-zip`, and any consumer written before this split. New
 * code should prefer this subpath so the import boundary is explicit.
 */

export { withBlobs } from './active.js'
export type { WithBlobsOptions } from './active.js'
export type { BlobsStrategy, BlobsStrategyOpenArgs } from '../../port/with/blob-strategy.js'

// #808 — offline pinning + mobile cache budget.
export { memoryBlobPinStore, blobPinKey } from '../../with-shape/blobs/blob-pinning.js'
export type { BlobPinStore, BlobPinEntry, BlobCacheStats } from '../../with-shape/blobs/blob-pinning.js'
export { BlobOfflineError } from '../../kernel/errors.js'

export { memoryObjectProjection } from '../../with-shape/blobs/object-projection.js'
export type {
  ObjectProjection,
  ObjectMeta,
  ObjectListEntry,
  PutObjectOptions,
  ObjectUrlOptions,
  PutUrlOptions,
} from '../../with-shape/blobs/object-projection.js'
export { importExternalObjects } from '../../with-shape/blobs/import-external.js'
export type {
  ImportableCollection,
  ImportExternalOptions,
  ImportExternalResult,
} from '../../with-shape/blobs/import-external.js'

export { BlobSet } from '../../with-shape/blobs/blob-set.js'
export {
  BLOB_COLLECTION,
  BLOB_INDEX_COLLECTION,
  BLOB_CHUNKS_COLLECTION,
  BLOB_SLOTS_PREFIX,
  BLOB_VERSIONS_PREFIX,
  DEFAULT_CHUNK_SIZE,
} from '../../with-shape/blobs/blob-set.js'
export type {
  BlobObject,
  SlotRecord,
  SlotInfo,
  VersionRecord,
  BlobPutOptions,
  BlobResponseOptions,
} from '../../kernel/types.js'

export { detectMimeType, detectMagic, isPreCompressed } from '../../with-shape/blobs/mime-magic.js'

export { runCompaction, BLOB_EVICTION_AUDIT_COLLECTION } from '../../with-shape/blobs/blob-compaction.js'
export { reportOrphanBlobChunks } from '../../with-shape/blobs/orphan-report.js' // #1133
export type { OrphanChunkReport } from '../../with-shape/blobs/orphan-report.js'
export type { UnreferencedLegacyBlobReport } from '../../with-shape/blobs/legacy-sweep.js' // #1453
// `reportOrphanBlobChunks` takes the store directly, so this subpath must make
// the type reachable — same re-export `./pod` and `./store` already carry
// (`check:types`, which is not part of build/test/lint).
export type { NoydbStore } from '../../kernel/types.js'
export type {
  BlobFieldsConfig,
  BlobFieldPolicy,
  BlobEvictionEntry,
  CompactRunOptions,
  CompactionResult,
  CompactionContext,
} from '../../with-shape/blobs/blob-compaction.js'

export {
  createExportBlobsHandle,
  ExportBlobsAbortedError,
  EXPORT_AUDIT_COLLECTION,
} from '../../with-shape/blobs/export-blobs.js'
export type {
  ExportBlobsOptions,
  ExportedBlob,
  ExportBlobsHandle,
  ExportBlobsAuditEntry,
} from '../../with-shape/blobs/export-blobs.js'

/** The un-opted-in stub for this service — exported so callers can compare against it (#844). */
export { NO_BLOBS } from '../../port/with/blob-strategy.js'
