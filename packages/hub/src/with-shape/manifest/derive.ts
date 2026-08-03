/**
 * Derive the pod-wide {@link SchemaManifest} from the per-collection
 * `_schemas/<collection>` records — the source of truth (#941 Task 3).
 *
 * The manifest is an INDEX, never a cache with independent state: every
 * field in a {@link SchemaManifestEntry} is a direct projection of the
 * matching `PersistedSchemaEnvelope` (`hash` → `contentHash`, `fieldIds` →
 * `fieldIds`, `generation` → `generation`, falling back to the live fence's
 * `currentSchemaVersion` for a legacy pre-#946 envelope that never got a
 * generation stamp). Re-running this function against the same stored state
 * always produces the same manifest — that's what makes round-trip identity
 * (AC #2: dump → restore → re-derive matches the original) hold for free,
 * with no special-cased restore logic.
 *
 * A collection whose `_schemas/<collection>` envelope has no derivable
 * content (`hash === null` — a stub envelope for a non-Zod validator, or one
 * that failed to decrypt/parse) is omitted from the index: there is no
 * content hash to bind, so an entry for it would carry no verifiable
 * information.
 *
 * @module
 */

import { loadFence } from '../schema-update/fence.js'
import { loadPersistedSchema, SCHEMAS_COLLECTION } from '../persisted-schemas/storage.js'
import { computeAggregateHash, type GetManifestDEK } from './storage.js'
import type { NoydbStore } from '../../kernel/types.js'
import type { SchemaManifest, SchemaManifestEntry } from './types.js'

/**
 * Read the fence generation + every `_schemas/<collection>` envelope and
 * project them into a fresh {@link SchemaManifest}. `getDEK` is called once
 * per collection found under `_schemas` (each collection's schema envelope
 * is encrypted under that collection's OWN DEK, not a shared one) plus once
 * more by callers that also need the `_manifest` collection's DEK to persist
 * the result (see `sync.ts` / `writer.ts`).
 */
export async function deriveSchemaManifest(
  store: NoydbStore,
  vault: string,
  getDEK: GetManifestDEK,
): Promise<SchemaManifest> {
  const fence = await loadFence(store, vault)
  const collectionNames = await store.list(vault, SCHEMAS_COLLECTION)

  const collections: Record<string, SchemaManifestEntry> = {}
  for (const name of collectionNames) {
    const dek = await getDEK(name)
    const payload = await loadPersistedSchema(store, vault, name, dek)
    if (!payload || payload.hash === null) continue // no derivable content — see module doc

    const entry: SchemaManifestEntry = {
      generation: payload.generation ?? fence.currentSchemaVersion,
      contentHash: payload.hash,
    }
    collections[name] = payload.fieldIds !== undefined ? { ...entry, fieldIds: payload.fieldIds } : entry
  }

  const aggregateHash = await computeAggregateHash(collections)
  return { v: 1, kind: 'schema', generation: fence.currentSchemaVersion, collections, aggregateHash }
}
