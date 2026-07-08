/**
 * Tombstone shape + predicate for the per-record-key (CEK) layer.
 *
 * A *tombstone* is the residue a GDPR crypto-shred (`vault.forget()`)
 * leaves on disk: the live envelope rewritten to `{ _noydb, _v, _ts, _by,
 * _iv:'', _data:'' }`, dropping `_iv`/`_data`/`_cek`/`_det`. With the wrapped
 * per-record CEK gone, the body — and every history version under the same
 * CEK — is permanently undecryptable, while the record KEY survives so the
 * version counter and "record existed and was erased" persist for the audit
 * ledger.
 *
 * These two helpers are the pure, collection-independent core of that
 * contract: {@link buildTombstone} mints the shape, {@link isTombstone}
 * recognises it on the read path. The orchestration that *writes* a tombstone
 * (`_writeTombstone`) and drives `vault.forget()` lives with the collection /
 * vault; it calls into these.
 */
import { NOYDB_FORMAT_VERSION, type EncryptedEnvelope } from '../../types.js'

/**
 * Shape-only tombstone recognition for layers that have no per-collection
 * context (the sync engine, #590): a tombstone carries an empty `_data` and
 * no wrapped CEK. No live envelope can match — record bodies never serialize
 * to the empty string (the `_sync` meta envelope carries non-empty `_data`,
 * and legacy migration envelopes carry non-empty `_iv`/`_data`).
 */
export function isTombstoneShape(envelope: EncryptedEnvelope): boolean {
  return envelope._data === '' && envelope._cek === undefined
}

/**
 * Is this envelope a crypto-shred tombstone?
 *
 * A tombstone carries no body (`_data` empty) and no wrapped CEK (`_cek`
 * absent) — decrypting it would call `decrypt('', '', dek)` → an AES-GCM
 * throw, so every read choke point must short-circuit to `null` instead.
 *
 * `encrypted` is the collection's encryption flag: on an unencrypted
 * collection there are no envelopes to shred, so nothing is ever a tombstone.
 * (Legacy migration envelopes carry non-empty `_iv`/`_data`, so they are not
 * tombstones and stay readable.)
 */
export function isTombstone(envelope: EncryptedEnvelope, encrypted: boolean): boolean {
  if (!encrypted) return false
  return isTombstoneShape(envelope)
}

/**
 * Mint a tombstone envelope from a record's live version + actor.
 *
 * Keeps `_v` (the displaced version) so the counter is monotonic across the
 * shred, stamps a fresh `_ts`, and records `_by` when an actor is supplied.
 * Deliberately omits `_iv`/`_data`/`_cek`/`_det` — that omission *is* the
 * erasure.
 */
export function buildTombstone(version: number, actor: string): EncryptedEnvelope {
  return {
    _noydb: NOYDB_FORMAT_VERSION,
    _v: version,
    _ts: new Date().toISOString(),
    _iv: '',
    _data: '',
    ...(actor ? { _by: actor } : {}),
  }
}
