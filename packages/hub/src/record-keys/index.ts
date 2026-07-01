/**
 * Per-record content-encryption keys (CEK) — the policy layer.
 *
 * Today the DEK is per-*collection*: one AES-256-GCM key encrypts every record
 * body and every history envelope in a collection. The CEK layer adds a fresh
 * per-*record* key, AES-KW-wrapped under the collection/tier DEK and stamped on
 * the envelope's `_cek`, so erasure and sealing can act at record granularity:
 *
 *   - **Erase a record** (#304) = drop its CEK everywhere → body + all history
 *     versions undecryptable, every other record untouched. The residue is a
 *     {@link buildTombstone tombstone}.
 *   - **Seal one record** to an `at-*` host (#306) = seal that record's CEK,
 *     not the whole-collection DEK.
 *
 * This module is the home for that policy. The raw AES-KW wrap/unwrap
 * primitives stay in `crypto.ts` (the single chokepoint for the WebCrypto
 * `subtle` handle) and are re-exported here so callers depend on the
 * `record-keys` surface, not on `crypto.ts` directly. The collection-coupled
 * orchestration (CEK resolution, tombstone writes, tier/bundle re-wrap, the
 * `vault.sealRecordToHost`/`rotateRecordCek` grantor side) layers on top in
 * collection.ts / vault.ts and the `forget/` + `sealed-record/` subsystems.
 *
 * Internal subsystem — not exported as a `@noy-db/hub/*` subpath.
 */
export { wrapCek, unwrapCek } from '../kernel/enclave/crypto.js'
export { isTombstone, buildTombstone } from './tombstone.js'
export { resolveStableCek, rewrapBodyToDek, type StableCekDeps, type RewrappedBody } from './lifecycle.js'
export {
  sealRecordToHost,
  revokeSealedRecord,
  rotateRecordCek,
  SEALED_CEK_NS,
  type SealingContext,
} from './sealing.js'
export { findByDet, queryByDet, type DeterministicContext } from './deterministic.js'
