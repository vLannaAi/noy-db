import type { NoydbStore } from '../../kernel/types.js'
import type { EnclaveKey } from '../../kernel/enclave/index.js'
import { liveBaseIdSet } from './existence.js'

/**
 * Build a live-base id set for every satellite collection detectable from
 * its persisted `_schemas/<name>` pairing marker (#591 Task 10).
 *
 * The bundle-export path (`with-pod/bundle.ts`) has no reachable
 * `SatelliteRegistry` — that registry is private to `Vault` and adding an
 * accessor would grow a kernel file past its line-ceiling ratchet. The
 * marker persisted by `ensureSatelliteMarker` (`_schemas/<satellite>`,
 * decrypted with the satellite collection's own DEK — see
 * `with-shape/persisted-schemas/storage.ts`) is the fallback pairing-info
 * source that's always reachable from just a raw store + a per-collection
 * DEK accessor, so export uses that instead of the in-memory registry.
 *
 * Returns a `Map` from satellite collection name to its base's live id set
 * (existence.ts rule 1: absent or tombstoned base ⇒ not live). Only
 * satellite collections are present as keys — callers should treat a
 * missing key as "not a satellite, don't filter."
 */
export async function liveBaseIdSetsForBundle(
  store: NoydbStore,
  vaultName: string,
  collectionNames: readonly string[],
  getDEK: (collectionName: string) => Promise<EnclaveKey>,
): Promise<Map<string, Set<string>>> {
  const { loadPersistedSchema } = await import('../persisted-schemas/storage.js')
  const out = new Map<string, Set<string>>()
  for (const name of collectionNames) {
    if (name.startsWith('_')) continue
    let dek: EnclaveKey
    try {
      dek = await getDEK(name)
    } catch {
      continue // no DEK reachable for this collection — can't read its marker, treat as non-satellite
    }
    const persisted = await loadPersistedSchema(store, vaultName, name, dek)
    const marker = persisted?.satellite
    if (!marker) continue
    out.set(name, await liveBaseIdSet(store, vaultName, marker.base))
  }
  return out
}
