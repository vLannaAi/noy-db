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
