import type { NoydbStore } from '../../kernel/types.js'
import type { EnclaveKey } from '../../kernel/enclave/index.js'
import { SatelliteConfigError } from '../../kernel/errors.js'
import { hashFields } from './validate.js'
import type { PairingMarker, SatelliteSpec } from './types.js'

/**
 * Persist-or-reconcile the pairing marker in `_schemas/<satellite>`.
 * First declaration writes { base, fieldsHash, joined }; later declarations
 * must match exactly or are refused (R-S9). Lazy imports keep the satellite
 * spine tree-shakeable (config-drift.ts pattern).
 */
export async function ensureSatelliteMarker(
  store: NoydbStore, vaultName: string, spec: SatelliteSpec, dek: EnclaveKey,
): Promise<void> {
  // #597: `epoch` only matters the first time this marker is ever persisted —
  // when a `prior` marker already exists below we return without ever using
  // it, so re-declaring a LIVE collection never mints (or compares) a new
  // epoch; the persisted one is carried forward untouched. Stamped here as a
  // timestamp (mirrors `derivedAt` in persisted-schemas/register.ts) rather
  // than a counter, since there's nothing to count from yet.
  const next: PairingMarker = {
    base: spec.base, fieldsHash: hashFields(spec.fields), joined: spec.joined,
    epoch: new Date().toISOString(),
  }
  const { loadPersistedSchema } = await import('../persisted-schemas/storage.js')
  const persisted = await loadPersistedSchema(store, vaultName, spec.satellite, dek)
  const prior = persisted?.satellite
  if (prior) {
    if (prior.base !== next.base || prior.fieldsHash !== next.fieldsHash || (prior.joined ?? null) !== (next.joined ?? null)) {
      throw new SatelliteConfigError(
        `R-S9: satellite "${spec.satellite}" re-declared divergently from its persisted pairing marker ` +
        `(persisted base="${prior.base}" fieldsHash=${prior.fieldsHash}; declared base="${next.base}" fieldsHash=${next.fieldsHash}). ` +
        `Evolve the marker deliberately, don't redeclare.`,
      )
    }
    return
  }
  const { persistSatelliteMarker } = await import('../persisted-schemas/register.js')
  await persistSatelliteMarker({ store, vault: vaultName, collectionName: spec.satellite, dek, marker: next })
}
