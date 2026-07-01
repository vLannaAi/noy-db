import type { NoydbStore, EncryptedEnvelope } from '../../types.js'
import { NOYDB_FORMAT_VERSION } from '../../types.js'
import { encrypt, decrypt } from '../../kernel/enclave/crypto.js'
import { ConflictError } from '../../errors.js'
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
 * Pure read: return the firm's persisted document-signing keypair, or `null`
 * if none has been minted yet. Never writes — callers that must NOT mint
 * (e.g. an ungated public-key getter) use this instead of `loadOrCreateSigner`.
 *
 * Stored as an encrypted record `_attestations/_signer` under the
 * `_attestations` collection DEK (resolved via `getDEK`, which is
 * AES-KW-wrapped under the owner KEK + persisted by the keyring). The KEK
 * itself is AES-KW-only and cannot AES-GCM-encrypt these bytes — hence
 * storage under a normal collection DEK.
 */
export async function loadSigner(
  store: NoydbStore,
  vault: string,
  getDEK: (collection: string) => Promise<CryptoKey>,
): Promise<DocSigner | null> {
  const existing = await store.get(vault, ATTESTATIONS_COLLECTION, SIGNER_RECORD_ID)
  if (!existing) return null
  const dek = await getDEK(ATTESTATIONS_COLLECTION)
  const json = await decrypt(existing._iv, existing._data, dek)
  return JSON.parse(json) as DocSigner
}

/**
 * Lazily mint (or load) the firm's Ed25519 document-signing keypair.
 *
 * On a concurrent first-mint, two callers can both read `null` and both mint
 * distinct keypairs. The `put(…, expectedVersion: 0)` ("must not already
 * exist") lets exactly one win; the loser catches `ConflictError`, re-reads,
 * and returns the winner's signer — converging on a single keypair rather than
 * clobbering it or surfacing a raw conflict. (All real stores treat a missing
 * record + `ev: 0` as a no-conflict write, so the catch fires on lost-race only.)
 */
export async function loadOrCreateSigner(
  store: NoydbStore,
  vault: string,
  getDEK: (collection: string) => Promise<CryptoKey>,
): Promise<DocSigner> {
  const existing = await loadSigner(store, vault, getDEK)
  if (existing) return existing

  const dek = await getDEK(ATTESTATIONS_COLLECTION)
  const signer = await generateDocSigningKeyPair()
  const { iv, data } = await encrypt(JSON.stringify(signer), dek)
  const env: EncryptedEnvelope = {
    _noydb: NOYDB_FORMAT_VERSION, _v: 1, _ts: new Date().toISOString(), _iv: iv, _data: data,
  }
  try {
    await store.put(vault, ATTESTATIONS_COLLECTION, SIGNER_RECORD_ID, env, 0)
    return signer
  } catch (e) {
    if (!(e instanceof ConflictError)) throw e
    // Lost the race — another writer minted first. Adopt the winner.
    const winner = await loadSigner(store, vault, getDEK)
    if (!winner) {
      throw new ConflictError(0, 'loadOrCreateSigner: signer mint lost a concurrent race but the winning record could not be re-read.')
    }
    return winner
  }
}
