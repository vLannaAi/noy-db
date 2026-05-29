import type { NoydbStore, EncryptedEnvelope } from '../types.js'
import { NOYDB_FORMAT_VERSION } from '../types.js'
import { encrypt, decrypt } from '../crypto.js'
import { generateDocSigningKeyPair } from '@noy-db/attestation'

export const ATTESTATIONS_COLLECTION = '_attestations'
export const SIGNER_RECORD_ID = '_signer'
export const REVOKED_RECORD_ID = '_revoked'

export interface DocSigner {
  readonly keyId: string
  readonly publicKeyB64: string
  readonly privateKeyPkcs8B64: string
}

/**
 * Lazily mint (or load) the firm's Ed25519 document-signing keypair.
 *
 * Stored as an encrypted record `_attestations/_signer` under the
 * `_attestations` collection DEK (resolved via `getDEK`, which is
 * AES-KW-wrapped under the owner KEK + persisted by the keyring). The
 * KEK itself is AES-KW-only and cannot AES-GCM-encrypt these bytes —
 * hence storage under a normal collection DEK.
 */
export async function loadOrCreateSigner(
  store: NoydbStore,
  vault: string,
  getDEK: (collection: string) => Promise<CryptoKey>,
): Promise<DocSigner> {
  const dek = await getDEK(ATTESTATIONS_COLLECTION)
  const existing = await store.get(vault, ATTESTATIONS_COLLECTION, SIGNER_RECORD_ID)
  if (existing) {
    const json = await decrypt(existing._iv, existing._data, dek)
    return JSON.parse(json) as DocSigner
  }
  const signer = await generateDocSigningKeyPair()
  const { iv, data } = await encrypt(JSON.stringify(signer), dek)
  const env: EncryptedEnvelope = {
    _noydb: NOYDB_FORMAT_VERSION, _v: 1, _ts: new Date().toISOString(), _iv: iv, _data: data,
  }
  // expectedVersion 0 = "must not already exist" — guards a concurrent first-mint race.
  await store.put(vault, ATTESTATIONS_COLLECTION, SIGNER_RECORD_ID, env, 0)
  return signer
}
