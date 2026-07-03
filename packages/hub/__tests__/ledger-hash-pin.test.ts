/**
 * Enclave Contract v1 — Task 7 (C1d, batch 2) pin test.
 *
 * Pins `envelopePayloadHash`'s output for 3 representative envelope shapes —
 * (a) plain encrypted (no `_cek`, no `_sealed`), (b) per-record-key (`_cek`
 * present, no `_sealed`), (c) sealed-fields (`_sealed` present) — as fixed
 * hex-string literals, computed against the CURRENT (`_data`+`_sealed`
 * inline) implementation of `hash.ts`.
 *
 * `hash.ts` is about to be migrated to read the envelope body via the
 * enclave barrel's `envelopeBodyForHash(env)` (Task 4 helper) instead of
 * reaching into `_data`/`_sealed` directly. This test is the byte-identical
 * proof that the migration changes NO hash-chain input: the literals below
 * must NOT change across that migration. If they would need to change, the
 * helper diverges from the pre-migration behavior — fix the helper (or stop
 * and report BLOCKED), never these literals.
 */
import { describe, it, expect } from 'vitest'
import { NOYDB_FORMAT_VERSION } from '../src/kernel/types.js'
import type { EncryptedEnvelope } from '../src/kernel/types.js'
import { envelopePayloadHash } from '../src/with-commit/history/ledger/hash.js'

function envelope(fields: Partial<EncryptedEnvelope>): EncryptedEnvelope {
  return {
    _noydb: NOYDB_FORMAT_VERSION,
    _v: 1,
    _ts: '2026-01-01T00:00:00.000Z',
    _iv: 'iv-value',
    _data: 'ciphertext-value',
    ...fields,
  } as EncryptedEnvelope
}

// (a) plain encrypted — no `_cek`, no `_sealed`.
const plainEnvelope = envelope({ _data: 'plain-ciphertext-a' })

// (b) per-record-key — `_cek` present, no `_sealed`. `_cek` is deliberately
// NOT bound by the hash (see hash.ts's doc), so this exercises the same
// no-`_sealed` branch as (a) but with the per-record-key envelope shape.
const perRecordKeyEnvelope = envelope({
  _data: 'per-record-key-ciphertext-b',
  _cek: 'wrapped-cek-b',
})

// (c) sealed-fields — `_sealed` present, widens the hash to also bind the
// sealed-field ciphertext map.
const sealedEnvelope = envelope({
  _data: 'sealed-ciphertext-c',
  _sealed: { ssn: 'sealed-ssn-c', dob: 'sealed-dob-c' },
})

describe('Task 7 pin — envelopePayloadHash byte-identical across body-hash migration', () => {
  it('(a) plain encrypted envelope hashes to the pinned literal', async () => {
    expect(await envelopePayloadHash(plainEnvelope)).toBe(
      'c363835b636e40f2fab1785af9f829b504cdb3df8e319cfe9e2b00fcc6714fdc',
    )
  })

  it('(b) per-record-key envelope hashes to the pinned literal', async () => {
    expect(await envelopePayloadHash(perRecordKeyEnvelope)).toBe(
      '1cbfd39ed55435c3467f4d8e9c03e1c0b1b6456eb8113ed44493b45f9b5ff99c',
    )
  })

  it('(c) sealed-fields envelope hashes to the pinned literal', async () => {
    expect(await envelopePayloadHash(sealedEnvelope)).toBe(
      '69fe7458cfbef635dc84fed531252194000659b74bdfad4deefc1e9a91cb6920',
    )
  })
})
