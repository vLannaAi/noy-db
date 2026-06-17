/**
 * @noy-db/hub/bundle — opt-in .noydb container format subsystem.
 *
 * @category capability
 *
 * The `.noydb` binary wrapper around `vault.dump()` for safe
 * cloud-storage drops: 10-byte magic prefix + JSON header +
 * compressed body. Consumers that don't export/import bundles can
 * omit this subpath and save ~805 LOC of format code + Brotli/gzip
 * wiring.
 */

export {
  writeNoydbBundle,
  readNoydbBundle,
  readNoydbBundleHeader,
  resetBrotliSupportCache,
} from './bundle.js'
export type {
  WriteNoydbBundleOptions,
  ReadNoydbBundleOptions,
  NoydbBundleReadResult,
} from './bundle.js'

export {
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
} from './format.js'
export type {
  CompressionAlgo,
  NoydbBundleHeader,
} from './format.js'

export { generateULID, isULID } from './ulid.js'

// ─── Multi-compartment bundle (NDBM) ─────────────────────────────────
export {
  writeMultiVaultBundle,
  readNoydbBundleManifest,
  readMultiVaultBundleCompartment,
  encodeMultiBundle,
  decodeMultiBundle,
  NOYDB_MULTI_BUNDLE_MAGIC,
  NOYDB_MULTI_BUNDLE_PREFIX_BYTES,
  NOYDB_MULTI_BUNDLE_VERSION,
} from './multi-bundle.js'
export type {
  CompartmentManifest,
  MultiBundleManifest,
  MultiVaultCompartmentInput,
} from './multi-bundle.js'

// ─── Partition extraction ────────────────────────────────
export { walkClosure } from './walk-closure.js'
export type { WalkClosureOptions, ClosureResult } from './walk-closure.js'
export { describeExtraction } from './describe-extraction.js'
export type { ExtractionPreview } from './describe-extraction.js'
export { extractPartition } from './extract-partition.js'
export type { ExtractPartitionResult } from './extract-partition.js'
export { adoptPartition, unsealDeks, createOwnerOnAdoptedPartition } from './adopt-partition.js'
export type {
  AdoptPartitionOptions,
  AdoptPartitionResult,
  CreateOwnerResult,
  CreateOwnerOptions,
  CreateOwnerStandardOptions,
  CreateOwnerManagedOptions,
} from './adopt-partition.js'
export { TransferSealError, AdoptionStateError } from '../errors.js'

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
} from '../errors.js'
