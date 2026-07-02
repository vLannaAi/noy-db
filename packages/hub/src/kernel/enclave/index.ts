/**
 * **kernel/enclave** — the hub's crypto interior, behind one door.
 *
 * This barrel is **the fork-swap contract**: a sister project that wants a
 * different crypto engine (a different KDF, a hardware-backed keystore, a
 * post-quantum wrap algorithm, …) replaces the entire `kernel/enclave/`
 * folder wholesale and only has to honor the exports below. Nothing outside
 * `kernel/enclave/**` may deep-import `crypto.js` or `record-keys/*` directly
 * — `scripts/check-architecture.mjs`'s `enclave-barrel-only` check enforces
 * that mechanically. Import sites inside `kernel/enclave/**` keep their
 * existing relative imports; this door is for everyone else.
 *
 * The export list is the OBSERVED contract — exactly the symbols consumed
 * from outside this folder today — grouped by the module that defines them:
 *
 *   - crypto ops     — `crypto.ts`: AES-256-GCM encrypt/decrypt (+ bytes, AAD,
 *                       deterministic variants), SHA-256 / HMAC-SHA-256 hashing.
 *   - key lifecycle  — `crypto.ts` + `record-keys/lifecycle.ts`: KEK/DEK
 *                       derivation, AES-KW wrap/unwrap, per-record CEK
 *                       wrap/unwrap + resolution/re-wrap, HKDF-derived
 *                       presence/sealed-field keys, base64 helpers.
 *   - record codec   — `record-keys/record-codec.ts`: the per-record
 *                       encode/decode engine.
 *   - sealing        — `record-keys/sealing.ts`: the sealed-record grantor
 *                       primitives (seal/revoke/rotate to an `at-*` host).
 *   - deterministic  — `record-keys/deterministic.ts`: blind-equality lookup
 *                       over deterministically-encrypted fields.
 *   - tombstone      — `record-keys/tombstone.ts`: the erased-record residue.
 *
 * Additive changes only — removing or renaming an export here is breaking
 * for any fork. Frozen by `__tests__/enclave-surface-golden.test.ts`.
 */

// ─── crypto ops ────────────────────────────────────────────────────
export {
  encrypt,
  decrypt,
  encryptBytes,
  decryptBytes,
  encryptBytesWithAAD,
  decryptBytesWithAAD,
  encryptDeterministic,
  decryptDeterministic,
  sha256Hex,
  hmacSha256Hex,
} from './crypto.js'

// ─── key lifecycle ─────────────────────────────────────────────────
export {
  deriveKey,
  generateDEK,
  generateSalt,
  generateIV,
  wrapKey,
  unwrapKey,
  bufferToBase64,
  base64ToBuffer,
  derivePresenceKey,
  deriveSealedFieldKey,
  deriveSealedFieldKeyFromCek,
  wrapCek,
  unwrapCek,
} from './crypto.js'
export { resolveStableCek, rewrapBodyToDek } from './record-keys/lifecycle.js'

// ─── record codec ──────────────────────────────────────────────────
export { RecordCodec } from './record-keys/record-codec.js'

// ─── sealing ───────────────────────────────────────────────────────
export { SEALED_CEK_NS, sealRecordToHost, revokeSealedRecord, rotateRecordCek } from './record-keys/sealing.js'
export type { SealingContext } from './record-keys/sealing.js'

// ─── deterministic ─────────────────────────────────────────────────
export { findByDet, queryByDet } from './record-keys/deterministic.js'
export type { DeterministicContext } from './record-keys/deterministic.js'

// ─── tombstone ─────────────────────────────────────────────────────
export { isTombstone, buildTombstone } from './record-keys/tombstone.js'
