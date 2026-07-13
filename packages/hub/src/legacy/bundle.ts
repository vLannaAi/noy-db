/**
 * @noy-db/hub/bundle — DEPRECATED compatibility alias.
 *
 * @category capability
 * @deprecated The `/bundle` subpath has been split into two services:
 *   the `.noydb` artifact format now lives at `@noy-db/hub/pod`, and the
 *   partition-transfer ops at `@noy-db/hub/cargo`. This barrel re-exports
 *   the union so existing `@noy-db/hub/bundle` pins keep resolving the
 *   same surface. Prefer `/pod` and `/cargo` in new code.
 *
 * `/adapter` and `/describe` were retired (and their `src/legacy/*.ts` files
 * deleted) in the same sweep that left this one standing — `/bundle` survives
 * as a published subpath until klum-db's interchange migrates off it (tracked
 * as phase 2/3). `kernel.ts` also remains in this folder, but only as
 * `/cargo`'s internal re-export floor — it is no longer a published subpath.
 */

// ─── Artifact (.noydb container format) → @noy-db/hub/pod ──
export {
  writePod,
  readPod,
  readPodHeader,
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
  WritePodOptions,
  WriteNoydbBundleOptions,
  ReadNoydbBundleOptions,
  NoydbBundleReadResult,
  CompressionAlgo,
  NoydbPodHeader,
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
  PodVersionConflictError,
  BundleVersionConflictError,
  BackupLedgerError,
  BackupCorruptedError,
  PartitionExtractionError,
} from '../kernel/errors.js'
