import type { Vault } from '@noy-db/hub'
import type { InspectorSnapshot, InspectorCollection, VaultInfo, InspectableContainer } from './types.js'

export async function listVaults(noydb: InspectableContainer): Promise<ReadonlyArray<VaultInfo>> {
  return noydb.listAccessibleVaults()
}

export async function snapshot(vault: Vault): Promise<InspectorSnapshot> {
  // withStats populates per-collection record/byte stats; opaque to the store.
  const dump = await vault.dumpSchema({ withStats: true })
  // Omit optional properties when absent rather than setting them to `undefined` —
  // the repo's tsconfig sets `exactOptionalPropertyTypes`, so optional fields must
  // be omitted, not explicitly set to undefined.
  const collections: InspectorCollection[] = Object.entries(dump.collections).map(([name, desc]) => {
    // Attempt to call describe() on the live collection to get rich field descriptors.
    // Guard: a collection that was not live-declared on this Vault instance (e.g. from a
    // prior open or a different process) may throw or return minimal output — skip
    // `described` for it without failing the whole snapshot.
    let described: InspectorCollection['described'] | undefined
    try {
      const coll = vault.collection(name)
      const collDesc = coll.describe()
      described = collDesc.fields
    } catch {
      // Not live-declared or no schema — skip described for this collection.
    }

    return {
      name,
      fields: desc.fields,
      indexes: desc.indexes,
      refs: desc.refs,
      ...(desc.stats !== undefined ? { stats: desc.stats } : {}),
      ...(desc.meta !== undefined ? { meta: desc.meta } : {}),
      ...(desc.config !== undefined ? { config: desc.config } : {}),
      ...(described !== undefined ? { described } : {}),
    }
  })

  return {
    vault: dump.vault,
    collections,
    ...(dump.meta !== undefined ? { meta: dump.meta } : {}),
  }
}
