/**
 * Read / write the per-collection persisted-schema envelope. Mirrors the
 * standard noy-db record envelope shape and is **AES-GCM encrypted with
 * the collection's DEK** — the schema body (field names, enum values,
 * constraints) is sensitive metadata, so it gets the same encryption
 * envelope as the records it describes.
 *
 * Storage layout:
 *
 *   <vault>/_schemas/<collection>   →   EncryptedEnvelope
 *
 * The DEK passed to {@link savePersistedSchema} / {@link loadPersistedSchema}
 * is the same key the collection uses for its records.
 *
 * @module
 */

import { encrypt, openEnvelopeJson, type EnclaveKey } from '../../kernel/enclave/index.js'
import { NOYDB_FORMAT_VERSION } from '../../kernel/types.js'
import type { NoydbStore, EncryptedEnvelope } from '../../kernel/types.js'
import type { PersistedSchemaEnvelope } from './types.js'

/** Reserved collection name where persisted schemas live. */
export const SCHEMAS_COLLECTION = '_schemas' as const

/**
 * Read and decrypt the persisted-schema envelope for one collection.
 * Returns `undefined` when no envelope has been written or when decryption
 * fails (e.g. wrong DEK passed). Tolerates corrupted records — JSON parse
 * failures surface as `undefined`, mirroring `_meta/handle`'s contract.
 */
export async function loadPersistedSchema(
  store: NoydbStore,
  vault: string,
  collection: string,
  dek: EnclaveKey,
): Promise<PersistedSchemaEnvelope | undefined> {
  const envelope = await store.get(vault, SCHEMAS_COLLECTION, collection)
  if (!envelope) return undefined
  try {
    const plaintext = await openEnvelopeJson(envelope, dek)
    const parsed = JSON.parse(plaintext) as PersistedSchemaEnvelope
    if (parsed._noydb_schema !== 1) return undefined
    return parsed
  } catch {
    return undefined
  }
}

/**
 * Encrypt and persist a schema envelope for one collection. Always
 * overwrites any prior write (callers gate on hash equality before calling
 * to avoid no-op writes).
 */
export async function savePersistedSchema(
  store: NoydbStore,
  vault: string,
  collection: string,
  dek: EnclaveKey,
  payload: PersistedSchemaEnvelope,
): Promise<void> {
  const json = JSON.stringify(payload)
  const { iv, data } = await encrypt(json, dek)
  const prior = await store.get(vault, SCHEMAS_COLLECTION, collection)
  const env: EncryptedEnvelope = {
    _noydb: NOYDB_FORMAT_VERSION,
    _v: (prior?._v ?? 0) + 1,
    _ts: new Date().toISOString(),
    _iv: iv,
    _data: data,
  }
  await store.put(vault, SCHEMAS_COLLECTION, collection, env)
}
