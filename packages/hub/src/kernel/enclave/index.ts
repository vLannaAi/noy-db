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
 *   - key type       — `crypto.ts`: `EnclaveKey`, the opaque key type every
 *                       barrel-facing signature traffics in (`= CryptoKey` in
 *                       noy-db's reference enclave; a fork redefines it to its
 *                       own key representation — see the type's own doc for
 *                       the fork contract).
 *   - crypto ops     — `crypto.ts`: AES-256-GCM encrypt/decrypt (+ bytes, AAD,
 *                       deterministic variants), SHA-256 / HMAC-SHA-256 hashing.
 *   - key lifecycle  — `crypto.ts` + `record-keys/lifecycle.ts`: KEK/DEK
 *                       derivation, AES-KW wrap/unwrap, per-record CEK
 *                       wrap/unwrap/import + resolution/re-wrap, HKDF-derived
 *                       presence/sealed-field keys, base64 helpers.
 *   - record codec   — `record-keys/record-codec.ts`: the per-record
 *                       encode/decode engine.
 *   - sealing        — `record-keys/sealing.ts`: the sealed-record grantor
 *                       primitives (seal/revoke/rotate to an `at-*` host).
 *   - deterministic  — `record-keys/deterministic.ts`: blind-equality lookup
 *                       over deterministically-encrypted fields.
 *   - tombstone      — `record-keys/tombstone.ts`: the erased-record residue.
 *   - envelope body  — `record-keys/envelope-body.ts`: the C1 protected-body
 *                       access contract (`openEnvelopeJson`,
 *                       `writeEnvelopeBody`, `hasPerRecordKey`,
 *                       `hasSealedBody`, `envelopeBodyForHash`) — the
 *                       sanctioned door onto
 *                       `_iv`/`_data`/`_cek`/`_sealed` for everyone outside
 *                       this folder.
 *   - reserved envelopes — `record-keys/sealed-slots.ts`: `makeReservedEnvelopes`,
 *                       the whole-envelope encrypt/decrypt door scoped to a
 *                       declared collection-name prefix (e.g. `_dict_`) —
 *                       `kernel/vault.ts` binds it for `DictionaryHandle`
 *                       (#629 Task 4).
 *
 * Additive changes only — removing or renaming an export here is breaking
 * for any fork. Frozen by `__tests__/enclave-surface-golden.test.ts`.
 *
 * **Refusal contract:** the barrel above is frozen — every symbol must
 * exist in any fork — but the optional groups (sealing, deterministic,
 * per-record-key lifecycle) MAY throw `EnclaveNotSupportedError` instead
 * of implementing the reference behavior. The core groups (crypto ops,
 * record codec, tombstone) MUST NOT throw it — they are load-bearing for
 * every consumer regardless of which enclave is wired in. noy-db's own
 * enclave supports every group, so it never throws this error.
 */

// ─── key type ──────────────────────────────────────────────────────
export type { EnclaveKey, EncryptResult } from './crypto.js'

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
  deriveBlobAddressKey, // #1126
} from './crypto.js'

// ─── key lifecycle ─────────────────────────────────────────────────
export {
  deriveKey,
  deriveSecretKey,
  generateDEK,
  exportDekSet,
  importDekSet,
  generateSalt,
  generateRecoverySecret,
  generateIV,
  wrapKey,
  unwrapKey,
  bufferToBase64,
  base64ToBuffer,
  derivePresenceKey,
  deriveDeterministicKey,
  deriveSealedFieldKey,
  deriveSealedFieldKeyFromCek,
  wrapCek,
  unwrapCek,
  importCek,
  encodeEchoParts,
  deriveEchoKey,
} from './crypto.js'
export type { SecretKeyUsage } from './crypto.js'
export type { EchoSecretParts } from './crypto.js'
export { resolveStableCek, rewrapBodyToDek, rewrapEnvelope, applyRewrappedBody, isRewrappedUnder } from './record-keys/lifecycle.js'
export type { RewrappedBody } from './record-keys/lifecycle.js'

// ─── record codec ──────────────────────────────────────────────────
// #1041 — record-identity AAD. Internal: the sweep binding each encrypt/decrypt
// pair uses it; it is not part of the published surface.
export { rekeyEnvelopeToDek, rekeyEnvelopeIfNeeded, envelopeOpensUnderAny } from './record-keys/rekey.js'
export { rekeyBlobSet } from './record-keys/rekey-blob.js'
export { buildRecordEnvelope, buildSealedRecordEnvelope } from './record-envelope.js'
export type { RecordEnvelopeBody } from './record-envelope.js'
export { buildRecordAad, recordAadFor } from './record-aad.js'
export type { RecordIdentity, RecordRef } from './record-aad.js'
export { RecordCodec } from './record-keys/record-codec.js'
export type { SealedShredSlot } from './record-keys/record-codec.js'

// ─── sealing ───────────────────────────────────────────────────────
export { SEALED_CEK_NS, sealRecordToHost, revokeSealedRecord, rotateRecordCek } from './record-keys/sealing.js'
export type { SealingContext } from './record-keys/sealing.js'

// ─── deterministic ─────────────────────────────────────────────────
export { findByDet, queryByDet } from './record-keys/deterministic.js'
export type { DeterministicContext } from './record-keys/deterministic.js'

// ─── tombstone ─────────────────────────────────────────────────────
export { isTombstone, isTombstoneShape, buildTombstone, isDeleteMarker, buildDeleteMarker } from './record-keys/tombstone.js'

// ─── envelope body (C1 protected-body access contract) ──────────────
export { openEnvelopeJson, writeEnvelopeBody, hasPerRecordKey, hasSealedBody, envelopeBodyForHash, envelopeBodySize, verifyRecordIdentity } from './record-keys/envelope-body.js'

// ─── reserved envelopes (ViaCryptoCtx.reservedEnvelopes capability) ──
export { makeReservedEnvelopes } from './record-keys/sealed-slots.js'

// ─── classify (stage-2 verify oracle primitives) ────────────────────
// ADDITIVE per Enclave Contract v1. A fork must provide these four; the
// verify/matchGroup orchestration (classify/verify.ts) sits behind the
// with-shape dynamic-import seam and is not part of the fork contract.
export { deriveVdigSlotKey } from './classify/vdig.js'
export { pbkdf2VerifyDigest } from './classify/digest.js'
export { ctEqualTags } from './classify/compare.js'
export { evaluateKofN } from './classify/kofn.js'

// ─── classify (slice-2b equatable blind index) ──────────────────────
// ADDITIVE per Enclave Contract v1. A fork must provide these four; the
// findByDigest orchestration (collection.ts) sits behind the with-shape
// dynamic-import seam and is not part of the fork contract.
export { deriveClassifyIndexKey, deriveClassifyIndexSalt, mintBidxTag } from './classify/bidx.js'
export { computeBidxTarget } from './classify/find.js'

// ─── broker (proof derivation + challenge/verify, #479 slice 2) ─────
// ADDITIVE per Enclave Contract v1. A fork must provide these five; the
// seed lifecycle + network/cache orchestration (with-party/broker/**) sits
// behind its own dynamic-import seam and is not part of the fork contract.
export {
  deriveBrokerProofBits,
  deriveBrokerProofKey,
  computeBrokerProof,
  issueChallenge,
  verifyBrokerProof,
} from './broker/proof.js'
export type { BrokerProofCanonicalParts, VerifyBrokerProofArgs, IssuedChallenge } from './broker/proof.js'
