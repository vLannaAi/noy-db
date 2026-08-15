/**
 * Read / write the pod-wide `_manifest/schema` envelope.
 *
 * Mirrors `with-shape/persisted-schemas/storage.ts`'s shape: the same
 * standard noy-db record envelope, AES-GCM encrypted with a collection DEK
 * (here, the `_manifest` collection's own DEK — the manifest INDEX
 * discloses collection names + hashes + generations + field ids, metadata
 * rather than schema bodies, so it gets the same encryption grain as
 * `_schemas` itself).
 *
 * Storage layout:
 *
 *   <vault>/_manifest/schema   →   EncryptedEnvelope
 *
 * Unlike `persisted-schemas/storage.ts` (which takes an already-resolved
 * `EnclaveKey`), these functions take a `getDEK` resolver and call
 * `getDEK(MANIFEST_COLLECTION)` themselves — there is exactly one manifest
 * record per pod, so there is no per-collection DEK the caller needs to
 * pick; resolving it here keeps every manifest call-site symmetric.
 *
 * @module
 */

import { buildSealedRecordEnvelope, openEnvelopeJson, writeEnvelopeBody, type EnclaveKey } from '../../kernel/enclave/index.js'
import { canonicalJson, sha256Hex } from '../../with-commit/history/ledger/index.js'
import type { NoydbStore } from '../../kernel/types.js'
import { MANIFEST_COLLECTION } from './reserved-collections.js'
import { MANIFEST_SCHEMA_RECORD_ID, type SchemaManifest, type SchemaManifestEntry } from './types.js'

/** A resolver for a collection's DEK — the same shape as `Vault`'s internal `getDEK`. */
export type GetManifestDEK = (collectionName: string) => Promise<EnclaveKey>

/**
 * A decrypted schema-manifest read paired with the wrapping envelope's `_v`
 * — the optimistic-concurrency token. Pass `version` back to
 * {@link saveSchemaManifest} (via `writeSchemaManifest`'s `expectedVersion`)
 * to make the write a strict CAS.
 */
export interface LoadedSchemaManifest {
  /** Wrapping envelope `_v`. */
  readonly version: number
  /** Decrypted schema manifest. */
  readonly manifest: SchemaManifest
}

/**
 * Read the `_manifest/schema` envelope together with its wrapping `_v`.
 * Returns `undefined` when no manifest has ever been written, when the
 * envelope fails to decrypt (wrong DEK), or when it doesn't parse as a
 * `v: 1, kind: 'schema'` manifest.
 */
export async function loadSchemaManifestEntry(
  store: NoydbStore,
  vault: string,
  getDEK: GetManifestDEK,
): Promise<LoadedSchemaManifest | undefined> {
  const envelope = await store.get(vault, MANIFEST_COLLECTION, MANIFEST_SCHEMA_RECORD_ID)
  if (!envelope) return undefined
  const dek = await getDEK(MANIFEST_COLLECTION)
  try {
    const plaintext = await openEnvelopeJson({ collection: MANIFEST_COLLECTION, id: MANIFEST_SCHEMA_RECORD_ID }, envelope, dek)
    const parsed = JSON.parse(plaintext) as SchemaManifest
    if (parsed.v !== 1 || parsed.kind !== 'schema') return undefined
    return { version: envelope._v, manifest: parsed }
  } catch {
    return undefined
  }
}

/**
 * Encrypt and persist the schema manifest as a strict CAS write:
 * `expectedVersion` must match the stored envelope's `_v` (0 when no
 * envelope exists yet) or `store.put` throws `ConflictError` — surfaced by
 * `writer.ts`'s `writeSchemaManifest` as `ManifestConflictError` rather than
 * retried.
 */
export async function saveSchemaManifest(
  store: NoydbStore,
  vault: string,
  manifest: SchemaManifest,
  expectedVersion: number,
  getDEK: GetManifestDEK,
): Promise<void> {
  const dek = await getDEK(MANIFEST_COLLECTION)
  const json = JSON.stringify(manifest)
  const env = await buildSealedRecordEnvelope(
    { collection: MANIFEST_COLLECTION, id: MANIFEST_SCHEMA_RECORD_ID },
    (identity) => writeEnvelopeBody(identity, json, dek),
    { version: expectedVersion + 1 },
  )
  await store.put(vault, MANIFEST_COLLECTION, MANIFEST_SCHEMA_RECORD_ID, env, expectedVersion)
}

/**
 * `sha256Hex(canonicalJson(collections))` — the pod-wide content binding
 * over a schema manifest's per-collection index. Canonical JSON sorts
 * object keys at every depth, so the result is independent of the map's
 * key insertion order. Shared by the writer's tests and (#941 Task 3) the
 * derivation path, so the hash is computed identically everywhere.
 */
export async function computeAggregateHash(
  collections: Record<string, SchemaManifestEntry>,
): Promise<string> {
  return sha256Hex(canonicalJson(collections))
}
