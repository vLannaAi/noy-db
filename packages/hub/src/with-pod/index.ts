/**
 * @noy-db/hub/pod — opt-in .noydb container-format (artifact) service.
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
  writePod,
  readPod,
  readPodHeader,
  readPodCover,
  writeNoydbBundle,
  readNoydbBundle,
  readNoydbBundleHeader,
  resetBrotliSupportCache,
} from './bundle.js'
// The cover type rides the pod header (frozen wire key `publicEnvelope`),
// so orchestrator-side consumers get it from this frozen seam (#799).
export type { Cover } from '../with-party/directory/cover/types.js'
export type {
  WritePodOptions,
  WriteNoydbBundleOptions,
  ReadNoydbBundleOptions,
  NoydbBundleReadResult,
} from './bundle.js'

// Pod header authentication (#943): a pure, dependency-free, WebCrypto-only
// verifier for the sig/keyId/sigAlg tuple written by `writePod` — this is
// the subpath a static verifier page tree-shakes down to.
export { verifyPodHeader } from './bundle.js'
export type { PodVerifyResult } from './bundle.js'

// The family-wide signing convention (pod header, Redirect record #944,
// manifest writes #941) — see with-pod/signature.ts for the canonical-JSON
// + Ed25519 details.
export { signRecord, verifyRecord, signedBytes, POD_SIG_ALG } from './signature.js'

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
  // #820: the magic-bytes predicate belongs beside NOYDB_BUNDLE_MAGIC —
  // klum's multi-bundle reader needed it and had to keep a root-barrel
  // import alive for this one symbol.
  hasNoydbBundleMagic,
} from './format.js'
export type {
  CompressionAlgo,
  NoydbPodHeader,
  NoydbBundleHeader,
  UnlockMethod,
} from './format.js'

export { generateULID, isULID } from './ulid.js'

export { wrapPodStore, createPodStore, wrapBundleStore, createBundleStore } from './pod-store.js'
export type {
  WrappedPodNoydbStore,
  WrapPodStoreOptions,
  WrappedBundleNoydbStore,
  WrapBundleStoreOptions,
} from './pod-store.js'

// Errors thrown by the artifact/backup paths above (#812), so subpath
// consumers can `instanceof` them without falling back to the root
// barrel — the retiring /bundle was their only other published home.
export {
  BundleIntegrityError,
  BundleSealMismatchError,
  PodVersionConflictError,
  BundleVersionConflictError,
  BackupLedgerError,
  BackupCorruptedError,
} from '../kernel/errors.js'
