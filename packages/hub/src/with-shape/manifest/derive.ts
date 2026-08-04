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
 * A collection whose `_schemas/<collection>` envelope decrypts successfully
 * but has no derivable content (`hash === null` — a stub envelope for a
 * non-Zod validator) is legitimately omitted from the index: there is no
 * content hash to bind.
 *
 * ## Scoped principals: "cannot decrypt" is NOT "doesn't exist"
 *
 * A `_schemas/<collection>` envelope is encrypted under **that data
 * collection's own DEK** — the same key its records use — NOT a shared
 * `_schemas`-wide key. In a team vault, a collection-scoped grantee (e.g.
 * `grant(..., { role: 'operator', permissions: { invoices: 'rw' } })`) holds
 * only the DEKs their `permissions` name, plus every system-prefixed (`_*`)
 * collection's DEK — `_manifest` included, by `grant()`'s "propagate system
 * collections to every role" rule (`keyring.ts`). So a member scoped to
 * `invoices` CAN decrypt `_manifest/schema` (the pod-wide index) but CANNOT
 * decrypt a sibling's `_schemas/customers` envelope — even though that
 * envelope is right there in `store.list(vault, SCHEMAS_COLLECTION)`.
 *
 * `lookupDEK` (the {@link LookupDEK} passed in) reflects this: it returns
 * `undefined` for a collection name whose DEK the caller does not hold —
 * deliberately NEVER minting a fresh one (see the module doc on
 * `LookupDEK` for why). This function distinguishes that case
 * (`undecodableCollections`) from "the schema envelope legitimately has no
 * derivable content" (`hash === null`) — the caller (`sync.ts`) MUST treat
 * an incomplete view differently: writing a manifest derived from a
 * partial view would silently drop every collection this principal can't
 * see. See `sync.ts`'s module doc for how the sync path handles this.
 *
 * @module
 */

import type { EnclaveKey } from '../../kernel/enclave/index.js'
import { loadFence } from '../schema-update/fence.js'
import { loadPersistedSchema, SCHEMAS_COLLECTION } from '../persisted-schemas/storage.js'
import { computeAggregateHash } from './storage.js'
import type { NoydbStore } from '../../kernel/types.js'
import type { SchemaManifest, SchemaManifestEntry } from './types.js'

/**
 * A NON-MINTING DEK lookup: returns the collection's DEK if the caller
 * already holds it, `undefined` otherwise. Deliberately distinct from
 * `storage.ts`'s `GetManifestDEK` (which mints+persists a fresh DEK for an
 * absent collection — correct for a caller about to WRITE that collection,
 * e.g. `_manifest` itself). `deriveSchemaManifest` only ever READS sibling
 * collections it never created and has no business minting keys for — an
 * absent DEK here means "not my collection to see," never "new collection
 * that needs a key." Minting here would be worse than a no-op: it would
 * silently persist a garbage DEK into the caller's OWN `_keyring/<user>`
 * file (via `ensureCollectionDEK`'s `persistKeyring` side effect) that
 * still can't decrypt anything — see `sync.ts` / `with-pod/open.ts`'s
 * fix notes (#941 review).
 */
export type LookupDEK = (collectionName: string) => Promise<EnclaveKey | undefined>

export interface DeriveSchemaManifestResult {
  /** The derived manifest — an index over every collection this principal could decrypt. */
  readonly manifest: SchemaManifest
  /**
   * Names present in `_schemas` (per `store.list`) whose envelope this
   * principal could NOT decrypt — either no DEK held for that collection,
   * or the DEK held failed to decrypt/parse it (treated the same: the
   * caller cannot verify what's there, so it cannot safely be omitted or
   * asserted). Empty for a principal with full visibility (typically the
   * owner/admin/custodian). Non-empty means `manifest.collections` is
   * DEFINITELY INCOMPLETE relative to the pod's true collection set —
   * see `sync.ts` for why that must gate whether the manifest gets written.
   */
  readonly undecodableCollections: readonly string[]
}

/**
 * Read the fence generation + every `_schemas/<collection>` envelope this
 * principal can decrypt, and project them into a fresh {@link SchemaManifest}.
 * `lookupDEK` is called once per collection found under `_schemas` (never
 * mints — see {@link LookupDEK}). Names whose DEK isn't held, or whose
 * envelope fails to decrypt/parse despite holding a DEK, are reported via
 * `undecodableCollections` rather than silently dropped from the result.
 */
export async function deriveSchemaManifest(
  store: NoydbStore,
  vault: string,
  lookupDEK: LookupDEK,
): Promise<DeriveSchemaManifestResult> {
  const fence = await loadFence(store, vault)
  const collectionNames = await store.list(vault, SCHEMAS_COLLECTION)

  const collections: Record<string, SchemaManifestEntry> = {}
  const undecodableCollections: string[] = []
  for (const name of collectionNames) {
    const dek = await lookupDEK(name)
    if (dek === undefined) {
      undecodableCollections.push(name) // present in _schemas, but not decodable by this principal
      continue
    }

    const payload = await loadPersistedSchema(store, vault, name, dek)
    if (!payload) {
      // Held a DEK but still couldn't decrypt/parse — cannot distinguish
      // "wrong key after all" from real corruption from here; treat as
      // undecodable (never silently drop) rather than "no content."
      undecodableCollections.push(name)
      continue
    }
    if (payload.hash === null) continue // legitimately no derivable content (stub envelope)

    const entry: SchemaManifestEntry = {
      generation: payload.generation ?? fence.currentSchemaVersion,
      contentHash: payload.hash,
    }
    collections[name] = payload.fieldIds !== undefined ? { ...entry, fieldIds: payload.fieldIds } : entry
  }

  const aggregateHash = await computeAggregateHash(collections)
  const manifest: SchemaManifest = { v: 1, kind: 'schema', generation: fence.currentSchemaVersion, collections, aggregateHash }
  return { manifest, undecodableCollections }
}
