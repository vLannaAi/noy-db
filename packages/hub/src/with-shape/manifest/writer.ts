/**
 * Strict-CAS schema-manifest writer (#941, AC #1).
 *
 * Every other reserved-collection writer in the hub (`persisted-schemas`'s
 * `savePersistedSchema` callers, the classified/satellite marker writers)
 * retries on a CAS conflict: re-read, re-apply, try again. The schema
 * manifest deliberately does NOT — two concurrent *direct* edits to the
 * manifest must be refused and surfaced, never silently merged or
 * retry-resolved, because a manifest write encodes a specific point-in-time
 * claim about the pod's schema generation/content-hash set. A caller that
 * lost the race must re-derive against the fresh state and decide what to
 * do, not have its stale write quietly re-applied on top of someone else's.
 *
 * Ledger audit: this writer does not have a `LedgerStore` handle at this
 * seam (mirroring `persisted-schemas`, whose `_schemas/<collection>` writes
 * are likewise not ledger-audited today). Wiring `LedgerStore.append({ op:
 * 'migration', ... })` around a manifest write belongs at the call site
 * where a ledger handle is already in scope (the open/write integration —
 * #941 Task 3/4), not here.
 *
 * @module
 */

import { isConflictError, ManifestConflictError } from '../../kernel/errors.js'
import { saveSchemaManifest, type GetManifestDEK } from './storage.js'
import type { NoydbStore } from '../../kernel/types.js'
import type { SchemaManifest } from './types.js'

/**
 * Write the schema manifest as a strict CAS: `expectedVersion` must match
 * the stored envelope's `_v` (0 when no manifest exists yet). On a
 * conflict, throws {@link ManifestConflictError} — this function never
 * retries.
 */
export async function writeSchemaManifest(
  store: NoydbStore,
  vault: string,
  manifest: SchemaManifest,
  expectedVersion: number,
  getDEK: GetManifestDEK,
): Promise<void> {
  try {
    await saveSchemaManifest(store, vault, manifest, expectedVersion, getDEK)
  } catch (err) {
    if (isConflictError(err)) {
      throw new ManifestConflictError(err.version, expectedVersion)
    }
    throw err
  }
}
