/**
 * Known-answer vectors for the enclave conformance kit.
 *
 * Random IVs make ciphertext *pinning* impossible (every fresh `encrypt()`
 * call — even under the same key + plaintext — produces different bytes),
 * so these vectors don't assert "the reference enclave still produces THIS
 * exact ciphertext". Instead they pin STRUCTURE + DECRYPTABILITY: a fixed
 * passphrase + salt deterministically re-derives the same KEK on every run
 * (PBKDF2 is deterministic), which unwraps a fixed wrapped-DEK captured
 * below, which then must decrypt each captured envelope back to its known
 * plaintext. A fork that claims wire-compat with noy-db's reference codec
 * can run this same fixture against its own `deriveKey`/`unwrapKey`/
 * `openEnvelopeJson` to verify it.
 *
 * Generated ONCE (2026-07-03) via a scratch script run against noy-db's
 * real enclave (`packages/hub/src/kernel/enclave/crypto.ts`) with the fixed
 * `passphrase` + `saltBase64` below, then deleted — see git history of this
 * file for the generator if it ever needs to be regenerated (e.g. the KDF
 * parameters change).
 */
import type { EncryptedEnvelope } from '@noy-db/hub'

export interface EnclaveVector {
  /** Base64 AES-KW-wrapped DEK, wrapped under the KEK derived from `passphrase` + `salt`. */
  readonly wrappedDek: string
  readonly envelope: EncryptedEnvelope
  /** The exact JSON text `openEnvelopeJson` must recover. */
  readonly plaintext: string
}

/** Fixed passphrase all three vectors' DEKs are wrapped under. */
export const VECTOR_PASSPHRASE = 'enclave-conformance-fixed-passphrase-v1'

/** Fixed 32-byte PBKDF2 salt (base64), paired with {@link VECTOR_PASSPHRASE}. */
export const VECTOR_SALT_BASE64 = 'RW5jbGF2ZUNvbmZvcm1hbmNlRml4ZWRTYWx0MTIzNDU2Nzg='

/** Vector 1 — plain body, keyed directly off the (unwrapped) DEK. */
export const VECTOR_1_PLAIN: EnclaveVector = {
  wrappedDek: 'AidWtmfRCuj8Kckzekd0lvFAHjQr6sY25KOKH9wqEJ2FKBGBSVzkKg==',
  envelope: {
    _noydb: 1,
    _v: 1,
    _ts: '2026-01-01T00:00:00.000Z',
    _iv: 'FYZywb2VWaxgnbyP',
    _data: 'nOpWUESr6QljwjZhBKn4LiM0s4yJD4hF88G3LG5vkAqRY2u5r9uppevOl5vcfK8=',
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
    _iv: 'bwJq3WRnmqwMqBGN',
    _data: 'g8wlcblbf74ACJ+tRHt5BoOSKc0nz7hRRm89SYZlhCYL5Tc6lRjTi9FD0w==',
    _cek: 'O1QQ/iKvm3PkqPcK+EuI3jY/O4l4HNs7BCWO7b8udhThWaeH5UVInw==',
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
    _iv: '6ibwqK2quz+m6dYu',
    _data: 'b3YcKiDtVsruQ+rS4rmi7m89dfKhoULtJXZIROnAhhpyi1QCDBfOHsAvQA==',
    _sealed: { taxId: '90M6L+iwXGKkp0eg:FhpbYBk4XB2KumfmYlsqQAnnFUp55hUO7R8kpTFn' },
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
