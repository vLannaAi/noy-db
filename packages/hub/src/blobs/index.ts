/**
 * @noy-db/hub/blobs — opt-in blob / document subsystem.
 *
 * @category capability
 *
 * This subpath groups every file whose reason-for-existing is blob
 * storage: `BlobSet` (slot-based attachments with chunked encryption
 * and dedup), `mime-magic` (MIME detection from magic bytes),
 * `blob-compaction` (TTL eviction via `blobFields`), `export-blobs`
 * (bulk export primitive), and the legacy `attachments` API.
 *
 * Hub's root barrel (`@noy-db/hub`) still re-exports `BlobSet` + the
 * MIME helpers for backward compatibility with `@noy-db/as-blob`,
 * `@noy-db/as-zip`, and any consumer written before this split. New
 * code should prefer this subpath so the import boundary is explicit.
 */

export { withBlobs } from './active.js'
export type { BlobStrategy, BlobStrategyOpenArgs } from './strategy.js'

export { BlobSet } from './blob-set.js'
export {
  BLOB_COLLECTION,
  BLOB_INDEX_COLLECTION,
  BLOB_CHUNKS_COLLECTION,
  BLOB_SLOTS_PREFIX,
  BLOB_VERSIONS_PREFIX,
  DEFAULT_CHUNK_SIZE,
} from './blob-set.js'
export type {
  BlobObject,
  SlotRecord,
  SlotInfo,
  VersionRecord,
  BlobPutOptions,
  BlobResponseOptions,
} from '../types.js'

export { detectMimeType, detectMagic, isPreCompressed } from './mime-magic.js'

export { runCompaction, BLOB_EVICTION_AUDIT_COLLECTION } from './blob-compaction.js'
export type {
  BlobFieldsConfig,
  BlobFieldPolicy,
  BlobEvictionEntry,
  CompactRunOptions,
  CompactionResult,
  CompactionContext,
} from './blob-compaction.js'

export {
  createExportBlobsHandle,
  ExportBlobsAbortedError,
  EXPORT_AUDIT_COLLECTION,
} from './export-blobs.js'
export type {
  ExportBlobsOptions,
  ExportedBlob,
  ExportBlobsHandle,
  ExportBlobsAuditEntry,
} from './export-blobs.js'
