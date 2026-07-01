/**
 * @noy-db/hub/pod — opt-in .noydb container-format (artifact) subsystem.
 *
 * @category capability
 *
 * The `.noydb` binary wrapper around `vault.dump()` for safe
 * cloud-storage drops: 10-byte magic prefix + JSON header +
 * compressed body, plus the ULID helpers. This is the artifact half of
 * the former `/bundle` subpath (partition-transfer ops now live under
 * `@noy-db/hub/cargo`). Consumers that don't export/import bundles can
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
