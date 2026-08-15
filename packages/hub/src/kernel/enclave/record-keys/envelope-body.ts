/**
 * Enclave body helpers — the C1 protected-body access contract.
 *
 * `EncryptedEnvelope` splits into a protocol header (family-owned; `_noydb`,
 * `_v`, `_ts`, `_by`, `_source`, `_sourceTs`, `_tier`, `_elevatedBy`) and a
 * protected body (enclave-owned; `_iv`, `_data`, `_cek`, `_det`, `_sealed`,
 * `_debug`). The four helpers below are the ONLY sanctioned way for code
 * outside `kernel/enclave/**` to read or construct the protected body —
 * later migration batches move the ~121 direct `_iv`/`_data`/`_cek`/`_sealed`
 * access sites in `with-*` services onto these.
 *
 * Each helper reproduces an EXISTING behavior byte-for-byte (see the
 * per-function doc for its oracle call site) — this file introduces no new
 * crypto or semantics, only a narrower door onto what already runs.
 */
import type { RecordIdentity } from '../record-aad.js'
import { encrypt, decrypt, generateDEK, wrapCek, unwrapCek, type EnclaveKey } from '../crypto.js'
import type { EncryptedEnvelope } from '../../types.js'

/**
 * Open an envelope's protected body to its JSON text.
 *
 * Mirrors the dominant direct-decrypt call-site shape (e.g.
 * `with-audit/consent/consent.ts`'s `decryptEntry`):
 *  - `opts.encrypted === false` (default `true`) → plaintext collection;
 *    returns `env._data` as-is, `key` untouched.
 *  - `env._cek` present → per-record-key envelope (mirrors
 *    `record-codec.ts`'s `resolveEnvelopeCek`): unwrap the CEK under `key`
 *    (the collection DEK), decrypt the body under the unwrapped CEK.
 *  - `env._cek` absent → legacy path, decrypt the body directly under `key`.
 */
export async function openEnvelopeJson(
  ref: { readonly collection: string; readonly id: string },
  env: EncryptedEnvelope,
  key: EnclaveKey,
  opts?: { encrypted?: boolean },
): Promise<string> {
  void ref // AAD binding lands in the switch-on commit (#1041)
  if (opts?.encrypted === false) return env._data
  if (env._cek !== undefined) {
    const cek = await unwrapCek(env._cek, key)
    return decrypt(env._iv, env._data, cek)
  }
  return decrypt(env._iv, env._data, key)
}

/**
 * Produce the protected-body fields (`_iv`/`_data`/`_cek`) for an envelope a
 * caller is assembling.
 *
 *  - `opts.encrypted === false` (default `true`) → plaintext collection;
 *    emits `{ _iv: '', _data: json }` (today's `buildPlaintextEnvelope`
 *    shape), `key` untouched.
 *  - `opts.perRecordKey === true` → mints a fresh per-record CEK, encrypts
 *    the body under it, and AES-KW-wraps the CEK under `key` (mirrors
 *    `encryptJsonString`'s `cek !== undefined` branch, except the CEK is
 *    generated here rather than supplied by the caller).
 *  - otherwise → legacy path, body encrypted directly under `key`.
 */
export async function writeEnvelopeBody(
  identity: RecordIdentity,
  json: string,
  key: EnclaveKey,
  opts?: { encrypted?: boolean; perRecordKey?: boolean },
): Promise<Pick<EncryptedEnvelope, '_iv' | '_data' | '_cek'>> {
  void identity // AAD binding lands in the switch-on commit (#1041)
  if (opts?.encrypted === false) return { _iv: '', _data: json }

  if (opts?.perRecordKey === true) {
    const cek = await generateDEK()
    const { iv, data } = await encrypt(json, cek)
    const wrapped = await wrapCek(cek, key)
    return { _iv: iv, _data: data, _cek: wrapped }
  }

  const { iv, data } = await encrypt(json, key)
  return { _iv: iv, _data: data }
}

/**
 * Approximate protected-body payload size for KPI/telemetry (#807's
 * period-scoped pull download counters): `_data` + `_iv` string length —
 * ≈ ciphertext bytes for base64 payloads, exact for plaintext (`_iv: ''`)
 * collections. A measuring door, not a crypto one: callers get a size
 * without touching the protected fields directly.
 */
export function envelopeBodySize(env: EncryptedEnvelope): number {
  return env._data.length + env._iv.length
}

/**
 * Discriminant: does this envelope carry a per-record key?
 *
 * Replaces raw `envelope._cek !== undefined` checks scattered across
 * services — `_cek` presence is the format discriminant (see
 * `record-codec.ts`'s `resolveEnvelopeCek` doc).
 */
export function hasPerRecordKey(env: EncryptedEnvelope): boolean {
  return env._cek !== undefined
}

/**
 * Canonical body string for the ledger hash chain — the exact bytes
 * `with-commit/history/ledger/hash.ts`'s `envelopePayloadHash` derives from
 * `_data` + `_sealed` + `_vdig` + `_bidx` before hashing:
 *  - no `_sealed`, no `_vdig`, no `_bidx` → `_data` alone (back-compat: every
 *    pre-existing ledger entry and non-sealed backup hashes byte-identically).
 *  - any map present → canonical JSON of `{ _data, _sealed?, _vdig?, _bidx? }`
 *    with sorted keys at every level, each map bound ONLY when present, so
 *    the result is independent of the maps' field-insertion / store-
 *    serialization order. `_bidx` is always the LAST segment, so a legacy
 *    `_vdig`-only / `_bidx`-absent envelope hashes byte-identically to its
 *    stage-2 value.
 *
 * Deliberately reimplements the two-key-object canonicalization inline
 * rather than importing `with-commit/history/ledger/entry.ts`'s general
 * `canonicalJson` — `kernel/enclave/**` may import only spine types (C3),
 * never a `with-*` service. For this fixed `{ _data: string; _sealed:
 * Record<string, string> }` shape the two produce byte-identical output
 * (verified against that exact call site's oracle expression in
 * `envelope-body.test.ts`).
 */
export function envelopeBodyForHash(env: EncryptedEnvelope): string {
  // Conditional widen (stage 2): bind `_vdig` exactly the way `_sealed` is
  // bound — only when present. No existing envelope carries `_vdig`, so this
  // ships with no flag-day PROVIDED it lands in the same slice as the first
  // `_vdig` writer (it does — Tasks 7/8/11 are one branch). This binding is
  // the temporal-rollback detector completing C1: AAD stops cross-record/
  // cross-field splices; the ledger hash catches same-slot rollbacks.
  //
  // Conditional widen (slice 2b, SM #5): bind `_bidx` the same way, appended
  // LAST (after `_vdig`) so a `_bidx`-absent envelope keeps its stage-2
  // byte-identical hash.
  if (env._sealed === undefined && env._vdig === undefined && env._bidx === undefined) return env._data
  const mapPart = (key: '_sealed' | '_vdig' | '_bidx', map: Record<string, string>): string => {
    const parts = Object.keys(map).sort().map(
      (k) => `${JSON.stringify(k)}:${JSON.stringify(map[k])}`,
    )
    return `${JSON.stringify(key)}:{${parts.join(',')}}`
  }
  const segments = [`"_data":${JSON.stringify(env._data)}`]
  if (env._sealed !== undefined) segments.push(mapPart('_sealed', env._sealed))
  if (env._vdig !== undefined) segments.push(mapPart('_vdig', env._vdig))
  if (env._bidx !== undefined) segments.push(mapPart('_bidx', env._bidx))
  return `{${segments.join(',')}}`
}
