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

import { buildRecordEnvelope, encrypt, openEnvelopeJson, type EnclaveKey } from '../../kernel/enclave/index.js'
import type { NoydbStore } from '../../kernel/types.js'
import type { PersistedSchemaEnvelope } from './types.js'

/** Reserved collection name where persisted schemas live. */
export const SCHEMAS_COLLECTION = '_schemas' as const

/**
 * A decrypted persisted-schema read paired with the wrapping envelope's
 * `_v`. The version is the optimistic-concurrency token: pass it back to
 * {@link savePersistedSchema} as `expectedVersion` to make the write a CAS
 * that rejects a stale put (see #583 — the `_schemas` record is shared by
 * the JSON-Schema writer and the classified-marker writer).
 */
export interface PersistedSchemaEntry {
  /** Wrapping envelope `_v` (0 when no record exists yet). */
  readonly version: number
  /** Decrypted payload, or `undefined` when absent/corrupt/wrong-DEK. */
  readonly payload: PersistedSchemaEnvelope | undefined
}

/**
 * Read the persisted-schema envelope for one collection together with its
 * wrapping `_v`. The version reflects the raw stored envelope even when the
 * payload cannot be decrypted/parsed (so a CAS still guards a corrupt record
 * rather than silently clobbering it).
 */
export async function loadPersistedSchemaEntry(
  store: NoydbStore,
  vault: string,
  collection: string,
  dek: EnclaveKey,
): Promise<PersistedSchemaEntry> {
  const envelope = await store.get(vault, SCHEMAS_COLLECTION, collection)
  if (!envelope) return { version: 0, payload: undefined }
  const version = envelope._v
  try {
    const plaintext = await openEnvelopeJson({ collection: SCHEMAS_COLLECTION, id: collection }, envelope, dek)
    const parsed = JSON.parse(plaintext) as PersistedSchemaEnvelope
    if (parsed._noydb_schema !== 1) return { version, payload: undefined }
    return { version, payload: parsed }
  } catch {
    return { version, payload: undefined }
  }
}

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
  return (await loadPersistedSchemaEntry(store, vault, collection, dek)).payload
}

/**
 * Encrypt and persist a schema envelope for one collection. Always
 * overwrites any prior write (callers gate on hash equality before calling
 * to avoid no-op writes).
 *
 * Pass `expectedVersion` — the `version` from {@link loadPersistedSchemaEntry}
 * captured at load time — to make the write an optimistic CAS: on a store with
 * `casAtomic`, `store.put` throws {@link ConflictError} when the record was
 * bumped concurrently, so a lost update on the shared `_schemas` record is
 * rejected instead of silently clobbering the other writer's field (#583).
 * When omitted, keeps the legacy unconditional last-writer-wins behaviour.
 */
export async function savePersistedSchema(
  store: NoydbStore,
  vault: string,
  collection: string,
  dek: EnclaveKey,
  payload: PersistedSchemaEnvelope,
  expectedVersion?: number,
): Promise<void> {
  const json = JSON.stringify(payload)
  const { iv, data } = await encrypt(json, dek)
  const baseVersion = expectedVersion ?? (await store.get(vault, SCHEMAS_COLLECTION, collection))?._v ?? 0
  const env = buildRecordEnvelope(
    { collection: SCHEMAS_COLLECTION, id: collection },
    { version: baseVersion + 1, iv, data },
  )
  await store.put(vault, SCHEMAS_COLLECTION, collection, env, expectedVersion)
}
