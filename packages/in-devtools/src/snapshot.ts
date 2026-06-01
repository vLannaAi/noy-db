import type { Vault } from '@noy-db/hub'
import type { InspectorSnapshot, InspectorCollection, VaultInfo, InspectorNoydb } from './types.js'

export async function listVaults(noydb: InspectorNoydb): Promise<ReadonlyArray<VaultInfo>> {
  return noydb.listAccessibleVaults()
}

export async function snapshot(vault: Vault): Promise<InspectorSnapshot> {
  // withStats populates per-collection record/byte stats; opaque to the store.
  const dump = await vault.dumpSchema({ withStats: true })
  const collections: InspectorCollection[] = Object.entries(dump.collections).map(([name, desc]) => ({
    name,
    fields: desc.fields,
    indexes: desc.indexes,
    refs: desc.refs,
    stats: desc.stats,
  }))
  return { vault: dump.vault, collections }
}
