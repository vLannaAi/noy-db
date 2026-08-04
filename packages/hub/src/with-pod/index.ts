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

// Redirect record (#944): a signed "this moved, go there" pointer carried
// in the pod's plaintext header, plus the followRedirects resolver.
export { readPodRedirect } from './bundle.js'
export { signRedirect, verifyRedirect, followRedirects } from './redirect.js'
export type { Redirect, RedirectHop, FollowRedirectsResult } from './redirect.js'
// DocSigner is signRedirect's signer param — re-exported here so it's
// nameable from the same entry (type-reachability guard).
export type { DocSigner } from '../with-audit/attestation/signer.js'
export {
  RedirectDepthExceededError,
  RedirectLoopError,
  RedirectBadSignatureError,
  RedirectUnreachableError,
} from '../kernel/errors.js'

// Manifest engine (#941): the pod read-path orchestrator — header → verify
// → unlock → manifest → generation fence → data — plus the schema manifest
// (an INDEX over per-collection `_schemas/<collection>` entries, not the
// schemas themselves) it re-derives on every open.
export { open } from './open.js'
export type { OpenPodOptions, OpenPodResult } from './open.js'
export { deriveSchemaManifest } from '../with-shape/manifest/derive.js'
export type { DeriveSchemaManifestResult, LookupDEK } from '../with-shape/manifest/derive.js'
export { loadSchemaManifestEntry } from '../with-shape/manifest/storage.js'
export type { GetManifestDEK, LoadedSchemaManifest } from '../with-shape/manifest/storage.js'
export type { SchemaManifest, SchemaManifestEntry } from '../with-shape/manifest/types.js'
export { MANIFEST_COLLECTION, isManifestReservedCollection } from '../with-shape/manifest/reserved-collections.js'
export { ManifestConflictError, MigrationRequiredError, PodHeaderVerificationError } from '../kernel/errors.js'
// Types `open()`'s own signature names, so a `/pod`-only consumer can spell
// them without a dual-import from the root barrel.
export type { Noydb } from '../kernel/noydb.js'
export type { Vault } from '../kernel/vault.js'
export type { NoydbOptions, NoydbStore } from '../kernel/types.js'
export type { EchoSecretParts } from '../kernel/enclave/index.js'
