/**
 * The one place an `EncryptedEnvelope` is constructed (#1051).
 *
 * ## Why this exists
 *
 * 49 files built envelopes with an object literal, bypassing
 * `RecordCodec.buildEnvelope` (which had 4 callers). That is **writer
 * fan-out**: N independent places each had to know the envelope contract, and
 * nothing checked that they agreed.
 *
 * It only became load-bearing with #1041. Binding a record's identity into the
 * AEAD requires every writer to supply that identity — and a writer that
 * doesn't produces data the reader rejects. Reader fan-out you fix by threading
 * an argument through call sites; **writer fan-out cannot be migrated
 * incrementally**, because the first migrated writer emits envelopes the
 * unmigrated readers refuse.
 *
 * ## Why adopting it is safe
 *
 * `identity` is **required but not yet used**. Output is byte-identical to the
 * literals it replaces, so every producer can migrate independently and the
 * existing suite verifies each step. The behaviour change happens **once**,
 * when AAD is switched on here — by which point every writer already supplies
 * identity, and the compiler proved it.
 *
 * That ordering is deliberate: a required-but-unused parameter converts "did
 * we find every writer?" from a question into a compile error, the same trick
 * that made the `NOYDB_FORMAT_VERSION` single-sourcing safe in #1048.
 *
 * @packageDocumentation
 */
import { NOYDB_FORMAT_VERSION } from '../types.js'
import type { EncryptedEnvelope } from '../types.js'
import type { RecordIdentity } from './record-aad.js'

/** The body an envelope carries, independent of who is writing it. */
export interface RecordEnvelopeBody {
  /** AES-GCM IV, base64. Empty string for a plaintext or tombstone envelope. */
  readonly iv: string
  /** Ciphertext (or plaintext JSON when the collection stores plaintext). */
  readonly data: string
  /** ISO timestamp. Defaults to now — pass it when the caller has a real one. */
  readonly ts?: string | undefined
  /** Wrapped per-record CEK, when the record has one. */
  readonly cek?: string | undefined
  readonly provenance?: { readonly source: string; readonly sourceTs: string } | undefined
  /**
   * Slots the envelope may additionally carry.
   *
   * `_tier`, `_by` and `_v` are deliberately NOT here — they come from
   * `identity`, which is the single source for all three. See
   * {@link buildRecordEnvelope}.
   */
  readonly extra?: Partial<Pick<EncryptedEnvelope, '_det' | '_sealed' | '_vdig' | '_bidx'>> | undefined
}

/**
 * Build an envelope for `identity`.
 *
 * ## `identity` is the SINGLE SOURCE for `_by`, `_tier` and `_v`
 *
 * All three are stamped from it, and `RecordEnvelopeBody` deliberately cannot
 * carry them. That is not tidiness — it is what makes the AAD binding safe.
 *
 * The caller encrypts the body under AAD derived from `{collection, id, tier,
 * by, version}`. A reader recomputes that AAD from the address it fetched from
 * plus `_tier`/`_by`/`_v` read back **off the envelope** (`recordAadFor`). So if the
 * identity a writer *declares* could differ from the fields it *stamps*, the
 * AAD would not reproduce and the record would be undecryptable — silently, at
 * write time, discoverable only on the next read, and invisible to every gate
 * because the envelope is perfectly well-formed.
 *
 * An earlier draft took both and asserted they agreed. The assertion fired 230
 * times on the existing tree, which is the argument against it: a rule that can
 * be violated is a rule someone must remember. Taking one source removes the
 * violation instead of reporting it.
 */
export function buildRecordEnvelope(
  identity: RecordIdentity,
  body: RecordEnvelopeBody,
): EncryptedEnvelope {
  return {
    _noydb: NOYDB_FORMAT_VERSION,
    _v: identity.version,
    _ts: body.ts ?? new Date().toISOString(),
    _iv: body.iv,
    _data: body.data,
    ...(identity.by !== undefined ? { _by: identity.by } : {}),
    ...(identity.tier !== undefined && identity.tier > 0 ? { _tier: identity.tier } : {}),
    ...(body.cek !== undefined ? { _cek: body.cek } : {}),
    ...(body.provenance !== undefined
      ? { _source: body.provenance.source, _sourceTs: body.provenance.sourceTs }
      : {}),
    ...(body.extra ?? {}),
  }
}

/**
 * Build an envelope from an already-sealed body — the output of
 * `writeEnvelopeBody` — **without the caller ever naming `_iv`/`_data`/`_cek`**.
 *
 * This exists because of a guard, and the guard was right. Migrating
 * `writeEnvelopeBody` callers to {@link buildRecordEnvelope} meant rewriting
 * `...body` (a spread, which names nothing) into `iv: body._iv, data:
 * body._data, cek: body._cek` — and `enclave-body-only` failed it: three new
 * protected-body accesses in files that previously had zero.
 *
 * That is the correct outcome rather than an obstacle. #1051 exists to move
 * knowledge of the envelope's shape *inward*; a migration that spreads the
 * protected field names outward to every caller would have defeated its own
 * purpose while looking like progress. The pairing belongs here.
 *
 * ## It takes a SEALER, not a sealed body — and that is load-bearing (#1041)
 *
 * The obvious shape is `(identity, alreadySealedBody, rest)`. That requires the
 * caller to name the identity TWICE — once for `writeEnvelopeBody` and once
 * here — and the two must agree byte for byte or the record is sealed under
 * AAD no reader can reproduce.
 *
 * They did not agree. `with-party/broker/seed.ts` sealed against
 * `{collection, id}` and stamped `{collection, id, by}`, so every broker seed
 * became unreadable the moment AAD switched on. Taking the sealer means the
 * identity is written once and handed to both — divergence stops being
 * possible rather than being something to remember.
 */
export async function buildSealedRecordEnvelope(
  identity: RecordIdentity,
  seal: (identity: RecordIdentity) => Promise<Pick<EncryptedEnvelope, '_iv' | '_data' | '_cek'>>,
  body: Omit<RecordEnvelopeBody, 'iv' | 'data' | 'cek'>,
): Promise<EncryptedEnvelope> {
  const sealed = await seal(identity)
  return buildRecordEnvelope(identity, {
    ...body,
    iv: sealed._iv,
    data: sealed._data,
    cek: sealed._cek,
  })
}
