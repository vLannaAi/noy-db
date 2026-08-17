/**
 * Known-answer vectors for the enclave conformance kit.
 *
 * Random IVs make ciphertext *pinning* impossible (every fresh `encrypt()`
 * call — even under the same key + plaintext — produces different bytes),
 * so these vectors don't assert "the reference enclave still produces THIS
 * exact ciphertext". Instead they pin STRUCTURE + DECRYPTABILITY: a fixed
 * secret + salt deterministically re-derives the same KEK on every run
 * (PBKDF2 is deterministic), which unwraps a fixed wrapped-DEK captured
 * below, which then must decrypt each captured envelope back to its known
 * plaintext. A fork that claims wire-compat with noy-db's reference codec
 * can run this same fixture against its own `deriveKey`/`unwrapKey`/
 * `openEnvelopeJson` to verify it.
 *
 * Generated ONCE (2026-07-03) via a scratch script run against noy-db's
 * real enclave (`packages/hub/src/kernel/enclave/crypto.ts`) with the fixed
 * `secret` + `saltBase64` below, then deleted — see git history of this
 * file for the generator if it ever needs to be regenerated (e.g. the KDF
 * parameters change).
 */
import type { EncryptedEnvelope } from '@noy-db/hub'

export interface EnclaveVector {
  /** Base64 AES-KW-wrapped DEK, wrapped under the KEK derived from `secret` + `salt`. */
  readonly wrappedDek: string
  readonly envelope: EncryptedEnvelope
  /** The exact JSON text `openEnvelopeJson` must recover. */
  readonly plaintext: string
}

/**
 * Fixed secret all three vectors' DEKs are wrapped under.
 *
 * ⚠️ **REGENERATED 2026-08-17 for #1093** (and before that 2026-08-15 for
 * #1041). The envelope ciphertexts below are sealed with record-identity AAD
 * for `{collection: 'conformance', id: 'r1', version: 1}` — the address AND the
 * version the suite reads them at. Each previous set was sealed under a
 * narrower tuple and cannot be opened by a conforming enclave, which is the
 * point: known-answer vectors are FORMAT-BOUND, so a format change invalidates
 * them by design rather than by accident.
 *
 * This is the kit's real job showing itself. A fork that implements the old
 * (pre-`_v`) AAD now FAILS conformance, loudly, instead of quietly producing
 * envelopes noy-db cannot read. That is what these vectors are for.
 *
 * To regenerate: derive the KEK from the fixed secret + salt below, unwrap the
 * (unchanged) `wrappedDek`, and re-run `writeEnvelopeBody` for each vector at
 * that REF. The wrapped DEK is deliberately reused so only the ciphertexts
 * move.
 *
 * The VALUE is frozen and deliberately still says "passphrase" after the
 * #862 rename. These are known-answer vectors: the wrapped DEKs below were
 * computed under this exact string, so changing it changes the derived KEK
 * and nothing decrypts. Only the symbol was renamed.
 */
export const VECTOR_SECRET = 'enclave-conformance-fixed-passphrase-v1'

/** Fixed 32-byte PBKDF2 salt (base64), paired with {@link VECTOR_SECRET}. */
export const VECTOR_SALT_BASE64 = 'RW5jbGF2ZUNvbmZvcm1hbmNlRml4ZWRTYWx0MTIzNDU2Nzg='

/** Vector 1 — plain body, keyed directly off the (unwrapped) DEK. */
export const VECTOR_1_PLAIN: EnclaveVector = {
  wrappedDek: 'AidWtmfRCuj8Kckzekd0lvFAHjQr6sY25KOKH9wqEJ2FKBGBSVzkKg==',
  envelope: {
    _noydb: 1,
    _v: 1,
    _ts: '2026-01-01T00:00:00.000Z',
    _iv: 'huUUvbRw95BFg/7Y',
    _data: '/cKNYzwffV8YmOPZH9fwhyaFpvbeliK65Zd17Imq3XpG218D8uP/a892lxg3jeE=',
  },
  plaintext: '{"name":"Somchai","amount":100}',
}

/** Vector 2 — per-record-key body: `_cek` wrapped under the (unwrapped) DEK. */
export const VECTOR_2_PER_RECORD_KEY: EnclaveVector = {
  wrappedDek: 'AidWtmfRCuj8Kckzekd0lvFAHjQr6sY25KOKH9wqEJ2FKBGBSVzkKg==',
  envelope: {
    _noydb: 1,
    _v: 1,
    _ts: '2026-01-01T00:00:00.000Z',
    _iv: 'VG1KYkkiLYgZHa3y',
    _data: '/AfIScyk28VVJQ2eWD5ck1BKx8Rt+B5WmTm5vS1iPiZJ3FFycOqretqKew==',
    _cek: '6j5LstUpJr1F656GCCIGtKukDWRVuW/r9dhA7A12vGmKqqlJzcWGsA==',
  },
  plaintext: '{"name":"Nok","amount":250}',
}

/** Vector 3 — sealed-shaped: plain body plus a `_sealed` field. */
export const VECTOR_3_SEALED: EnclaveVector = {
  wrappedDek: 'AidWtmfRCuj8Kckzekd0lvFAHjQr6sY25KOKH9wqEJ2FKBGBSVzkKg==',
  envelope: {
    _noydb: 1,
    _v: 1,
    _ts: '2026-01-01T00:00:00.000Z',
    _iv: 'mxV6gQcfb3aSak3V',
    _data: 'fqlWzaY/YJNy3jZf5MsFQq6OvA/x+3N+bTREbVoK5mzNmQdgI9tY9yDiCA==',
    _sealed: { taxId: 'vF13eL+NovJP0ANs:HHk+qL3pQ3d/ZLFOULvndKjdwFnmOo+y0x3UpN/+' },
  },
  plaintext: '{"name":"Kob","amount":500}',
}

/** The `_sealed.taxId` slot on {@link VECTOR_3_SEALED} was sealed under this key path. */
export const VECTOR_3_SEALED_FIELD = {
  collectionName: 'customers',
  field: 'taxId',
  value: 'TAX-1234567890',
}

export const ALL_VECTORS: readonly EnclaveVector[] = [VECTOR_1_PLAIN, VECTOR_2_PER_RECORD_KEY, VECTOR_3_SEALED]
