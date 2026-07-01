/**
 * @noy-db/hub/bundle — DEPRECATED compatibility alias.
 *
 * @category capability
 * @deprecated The `/bundle` subpath has been split into two services:
 *   the `.noydb` artifact format now lives at `@noy-db/hub/pod`, and the
 *   partition-transfer ops at `@noy-db/hub/cargo`. This barrel re-exports
 *   the union so existing `@noy-db/hub/bundle` pins keep resolving the
 *   same surface. Prefer `/pod` and `/cargo` in new code.
 */

// ─── Artifact (.noydb container format) → @noy-db/hub/pod ──
export {
  writeNoydbBundle,
  readNoydbBundle,
  readNoydbBundleHeader,
  resetBrotliSupportCache,
  NOYDB_BUNDLE_MAGIC,
  NOYDB_BUNDLE_PREFIX_BYTES,
  NOYDB_BUNDLE_FORMAT_VERSION,
  FLAG_COMPRESSED,
  FLAG_HAS_INTEGRITY_HASH,
  COMPRESSION_NONE,
  COMPRESSION_GZIP,
  COMPRESSION_BROTLI,
  validateBundleHeader,
  encodeBundleHeader,
  generateULID,
  isULID,
} from '../with-pod/index.js'
export type {
  WriteNoydbBundleOptions,
  ReadNoydbBundleOptions,
  NoydbBundleReadResult,
  CompressionAlgo,
  NoydbBundleHeader,
} from '../with-pod/index.js'

// ─── Partition extraction → @noy-db/hub/cargo ─────────────
export { walkClosure } from '../with-cargo/walk-closure.js'
export type { WalkClosureOptions, ClosureResult } from '../with-cargo/walk-closure.js'
export { describeExtraction } from '../with-cargo/describe-extraction.js'
export type { ExtractionPreview } from '../with-cargo/describe-extraction.js'
export { extractPartition } from '../with-cargo/extract-partition.js'
export type { ExtractPartitionResult } from '../with-cargo/extract-partition.js'
export { adoptPartition, unsealDeks, createOwnerOnAdoptedPartition } from '../with-cargo/adopt-partition.js'
export { decryptExtractedPartition } from '../with-cargo/decrypt-partition.js'
export type { DecryptedRecord } from '../with-cargo/decrypt-partition.js'
export type {
  AdoptPartitionOptions,
  AdoptPartitionResult,
  CreateOwnerResult,
  CreateOwnerOptions,
  CreateOwnerStandardOptions,
  CreateOwnerManagedOptions,
} from '../with-cargo/adopt-partition.js'
export { TransferSealError, AdoptionStateError } from '../kernel/errors.js'

// ─── Bundle / backup errors ─────────────────────────────
// Re-exported from the central errors module so subpath consumers can
// `instanceof BundleIntegrityError` without falling back to the root barrel.
export {
  BundleIntegrityError,
  BundleSealMismatchError,
  BundleVersionConflictError,
  BackupLedgerError,
  BackupCorruptedError,
  PartitionExtractionError,
} from '../kernel/errors.js'
