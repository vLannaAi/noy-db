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
 * ⚠️ **REGENERATED 2026-08-15 for #1041.** The envelope ciphertexts below are
 * now sealed with record-identity AAD for `{collection: 'conformance', id:
 * 'r1'}` — the address the suite reads them at. The previous values were sealed
 * without AAD and cannot be opened by a conforming enclave, which is the point:
 * known-answer vectors are FORMAT-BOUND, so a format change invalidates them by
 * design rather than by accident.
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
    _iv: 'MmYqPz9Qm9WiCKsT',
    _data: '35VA96UQdb1ixNLRUe+37bqAYALdGfUq5JSLhGyYsgxm46iBF5NQkNEGDXD6xAg=',
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
    _iv: 'MNIvdgciFarubKop',
    _data: 'ml5VXKUOaG5XTe36eNuV+4brCA59wKYaKoS2uETs46xMTP1jdyk00V4ERA==',
    _cek: 'CPPZAWdkxxmk3Tk6VcG5SX1a/QnE7Oo+nYaeXJNrCBeUqp0HLaHB6A==',
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
    _iv: '+wz5Wby+sJ/MYfy5',
    _data: 'Ih7Qnjr+gKuimQM0meyRAhP3ZdMnu+41KAjYGuA0ua4j+mZKJnwEmopRUw==',
    _sealed: { taxId: 'vFajgQH7YjcK77Fh:GWD48tQkOQnW59vKU+/8tA3iIOTU/gzWH2eSJe2x' },
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
