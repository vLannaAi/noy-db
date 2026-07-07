import type { NoydbStore } from '../../kernel/types.js'
import type { EnclaveKey } from '../../kernel/enclave/index.js'
import type { SatelliteSpec } from './types.js'
import type { SatelliteRegistry } from './registry.js'
import { ensureSatelliteMarker } from './marker.js'

/** Async post-registration: R-S9 marker reconcile + R-S1/R-S5 derivable-schema cross-check. Failures poison, never throw. */
export async function postRegister(
  store: NoydbStore, vaultName: string, spec: SatelliteSpec,
  getDEK: (collectionName: string) => Promise<EnclaveKey>,
  baseSchema: unknown, registry: SatelliteRegistry,
): Promise<void> {
  try {
    await ensureSatelliteMarker(store, vaultName, spec, await getDEK(spec.satellite))
  } catch (err) {
    registry.poison(spec.satellite, (err as Error).message); return
  }
  if (baseSchema !== undefined) {
    try {
      const { derivePersistedSchema } = await import('../persisted-schemas/derive.js')
      const envelope = await derivePersistedSchema(baseSchema)
      const properties = (envelope.jsonSchema as Record<string, unknown> | null)?.['properties'] as Record<string, unknown> | undefined
      const baseFields: string[] = Object.keys(properties ?? {})
      const overlap = spec.fields.filter(f => baseFields.includes(f))
      if (overlap.length > 0) {
        registry.poison(spec.satellite,
          `R-S1: satellite "${spec.satellite}" fields overlap the base schema: ${overlap.join(', ')} — routing must be unambiguous.`)
      }
    } catch { /* non-derivable validator → cross-check unavailable, by design (spec R-S5) */ }
  }
}
