/**
 * `envelope-body.ts` — the four enclave body helpers (Enclave Contract v1,
 * C1a). These are the seam later migration batches move the ~121 direct
 * `_iv`/`_data`/`_cek`/`_sealed` access sites onto, so they must reproduce
 * today's behaviors byte-for-byte — especially `envelopeBodyForHash`, whose
 * output feeds the audit ledger hash chain (byte-equality is a security
 * invariant, not a style preference).
 *
 * Oracles copied in verbatim from the sites this helper set replaces:
 *  - the direct-decrypt call site: `with-audit/consent/consent.ts`'s
 *    `decryptEntry` (`decrypt(envelope._iv, envelope._data, dek)` /
 *    plaintext `envelope._data` passthrough).
 *  - the `_cek` unwrap flow: `record-codec.ts`'s `resolveEnvelopeCek`
 *    (`_cek` undefined → legacy DEK path; else unwrap under DEK, decrypt
 *    body under the unwrapped CEK).
 *  - the hash derivation: `with-commit/history/ledger/hash.ts`'s
 *    `envelopePayloadHash` — the exact `_data`/`_sealed` expression is
 *    copied below (using the SAME `canonicalJson` it imports) as the oracle
 *    for `envelopeBodyForHash`.
 */
import { describe, it, expect } from 'vitest'
import {
  openEnvelopeJson,
  writeEnvelopeBody,
  hasPerRecordKey,
  envelopeBodyForHash,
  generateDEK,
  wrapCek,
  encrypt,
  type EnclaveKey,
} from '../src/kernel/enclave/index.js'
import { canonicalJson, sha256Hex as entrySha256Hex } from '../src/with-commit/history/ledger/entry.js'
import { NOYDB_FORMAT_VERSION, type EncryptedEnvelope } from '../src/kernel/types.js'

/** Oracle: the exact expression `ledger/hash.ts`'s `envelopePayloadHash` hashes. */
function oracleBodyForHash(envelope: EncryptedEnvelope): string {
  if (envelope._sealed === undefined) return envelope._data
  return canonicalJson({ _data: envelope._data, _sealed: envelope._sealed })
}

function baseEnvelope(fields: Partial<EncryptedEnvelope> = {}): EncryptedEnvelope {
  return {
    _noydb: NOYDB_FORMAT_VERSION,
    _v: 1,
    _ts: new Date().toISOString(),
    _iv: '',
    _data: '',
    ...fields,
  }
}

describe('envelope-body helpers', () => {
  describe('openEnvelopeJson / writeEnvelopeBody round-trip', () => {
    it('round-trips JSON through the encrypted path (default)', async () => {
      const dek = await generateDEK()
      const json = JSON.stringify({ hello: 'world' })
      const body = await writeEnvelopeBody({ collection: 'c', id: 'r1' }, json, dek)
      const envelope = baseEnvelope(body)

      const opened = await openEnvelopeJson({ collection: 'c', id: 'r1' }, envelope, dek)
      expect(opened).toBe(json)
    })

    it('round-trips JSON through the plaintext path (encrypted: false)', async () => {
      const dek = await generateDEK()
      const json = JSON.stringify({ hello: 'plaintext' })
      const body = await writeEnvelopeBody({ collection: 'c', id: 'r1' }, json, dek, { encrypted: false })

      // Exact plaintext body shape today's direct writers emit.
      expect(body._iv).toBe('')
      expect(body._data).toBe(json)
      expect(body._cek).toBeUndefined()

      const envelope = baseEnvelope(body)
      const opened = await openEnvelopeJson({ collection: 'c', id: 'r1' }, envelope, dek, { encrypted: false })
      expect(opened).toBe(json)
    })

    it('plaintext openEnvelopeJson returns `_data` as-is without touching the key', async () => {
      const envelope = baseEnvelope({ _iv: '', _data: '{"raw":true}' })
      // Passing a key that could never decrypt anything still succeeds,
      // because the plaintext path never calls decrypt().
      const opened = await openEnvelopeJson({ collection: 'c', id: 'r1' }, envelope, null as unknown as EnclaveKey, { encrypted: false })
      expect(opened).toBe('{"raw":true}')
    })
  })

  describe('per-record-key (`_cek`) path', () => {
    it('writeEnvelopeBody({ perRecordKey: true }) produces an envelope openEnvelopeJson can open with only the DEK', async () => {
      const dek = await generateDEK()
      const json = JSON.stringify({ secret: 42 })
      const body = await writeEnvelopeBody({ collection: 'c', id: 'r1' }, json, dek, { perRecordKey: true })

      expect(body._cek).toBeDefined()
      const envelope = baseEnvelope(body)

      const opened = await openEnvelopeJson({ collection: 'c', id: 'r1' }, envelope, dek)
      expect(opened).toBe(json)
    })

    it('mirrors resolveEnvelopeCek: unwraps `_cek` under the passed key, decrypts body under the unwrapped CEK', async () => {
      const dek = await generateDEK()
      const cek = await generateDEK()
      const json = JSON.stringify({ mirrored: true })
      const { iv, data } = await encrypt(json, cek)
      const wrapped = await wrapCek(cek, dek)
      const envelope = baseEnvelope({ _iv: iv, _data: data, _cek: wrapped })

      const opened = await openEnvelopeJson({ collection: 'c', id: 'r1' }, envelope, dek)
      expect(opened).toBe(json)
    })

    it('rejects a `_cek` envelope opened with the wrong DEK', async () => {
      const dek = await generateDEK()
      const wrongDek = await generateDEK()
      const json = JSON.stringify({ x: 1 })
      const body = await writeEnvelopeBody({ collection: 'c', id: 'r1' }, json, dek, { perRecordKey: true })
      const envelope = baseEnvelope(body)

      await expect(openEnvelopeJson({ collection: 'c', id: 'r1' }, envelope, wrongDek)).rejects.toThrow()
    })
  })

  describe('hasPerRecordKey truth table', () => {
    it('false when `_cek` is absent', () => {
      expect(hasPerRecordKey(baseEnvelope())).toBe(false)
    })

    it('true when `_cek` is present', () => {
      expect(hasPerRecordKey(baseEnvelope({ _cek: 'anything' }))).toBe(true)
    })
  })

  describe('envelopeBodyForHash — byte-equality against the ledger/hash.ts oracle', () => {
    it('matches the oracle for an envelope WITHOUT `_sealed` (plain `_data`)', () => {
      const envelope = baseEnvelope({ _iv: 'iv-1', _data: 'ciphertext-blob' })
      expect(envelopeBodyForHash(envelope)).toBe(oracleBodyForHash(envelope))
      expect(envelopeBodyForHash(envelope)).toBe(envelope._data)
    })

    it('matches the oracle for an envelope WITH `_sealed` (canonical-JSON widened hash)', () => {
      const envelope = baseEnvelope({
        _iv: 'iv-2',
        _data: 'ciphertext-blob-2',
        _sealed: { zebra: 'iv:z-data', alpha: 'iv:a-data' },
      })
      expect(envelopeBodyForHash(envelope)).toBe(oracleBodyForHash(envelope))
    })

    it('feeding the result through the same sha256Hex `ledger/hash.ts` uses reproduces `envelopePayloadHash` byte-for-byte', async () => {
      const withSealed = baseEnvelope({
        _iv: 'iv-3',
        _data: 'ciphertext-blob-3',
        _sealed: { field: 'iv:data' },
      })
      const withoutSealed = baseEnvelope({ _iv: 'iv-4', _data: 'ciphertext-blob-4' })

      for (const envelope of [withSealed, withoutSealed]) {
        const viaHelper = await entrySha256Hex(envelopeBodyForHash(envelope))
        const viaOracle = await entrySha256Hex(oracleBodyForHash(envelope))
        expect(viaHelper).toBe(viaOracle)
      }
    })
  })
})
