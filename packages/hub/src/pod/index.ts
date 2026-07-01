/**
 * **@noy-db/hub/pod** — the vault-serialization artifact seam.
 *
 * @category capability
 *
 * In the architecture lexicon a *pod* is a vault **serialized + saved** —
 * the `.noydb` binary container: 10-byte magic prefix + JSON header +
 * compressed body. This seam is the canonical successor to `/bundle`
 * (which remains as a deprecated alias). The primary ops carry pod-named
 * canonical aliases (`writePod`/`readPod`/`readPodHeader`) over the
 * underlying bundle implementations; the format constants and error
 * classes keep their existing names (renaming the errors would break
 * `instanceof`).
 *
 * Partition / interchange ops (extract, adopt, transfer re-keyed slices)
 * are NOT here — managing pods & slices is *cargo*'s job (`@noy-db/hub/cargo`).
 *
 * See docs/superpowers/specs/2026-07-01-noydb-architecture-lexicon.md.
 *
 * @packageDocumentation
 */

// ─── Canonical pod ops (aliases over the bundle impls) ───────────
// The bundle names stay exported from /bundle as the deprecated alias.
export {
  writeNoydbBundle as writePod,
  readNoydbBundle as readPod,
  readNoydbBundleHeader as readPodHeader,
  resetBrotliSupportCache,
} from '../with-share/bundle/bundle.js'
export type {
  WriteNoydbBundleOptions as WritePodOptions,
  ReadNoydbBundleOptions as ReadPodOptions,
  NoydbBundleReadResult as PodReadResult,
} from '../with-share/bundle/bundle.js'

// ─── Format constants + header helpers + types (existing names) ──
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
} from '../with-share/bundle/format.js'
export type {
  CompressionAlgo,
  NoydbBundleHeader,
} from '../with-share/bundle/format.js'

export { generateULID, isULID } from '../with-share/bundle/ulid.js'

// ─── Pod / backup errors (existing names — instanceof) ───────────
// Re-exported from the central errors module so subpath consumers can
// `instanceof BundleIntegrityError` without falling back to the root barrel.
export {
  BundleIntegrityError,
  BundleSealMismatchError,
  BundleVersionConflictError,
  BackupLedgerError,
  BackupCorruptedError,
} from '../errors.js'
