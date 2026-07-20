/**
 * #597 — persisted satellite/classified markers carry a lifetime epoch.
 *
 * Both `PairingMarker` (satellites) and `ClassifiedMarker` (classified) are
 * written into the SAME shared `_schemas/<collectionName>` record, keyed
 * purely by collection name — with no signal today that ties a marker to a
 * specific collection *lifetime*. If a collection name were ever reused
 * (latent: no delete-collection API exists yet), a stale marker would
 * silently reactivate old semantics for the new collection.
 *
 * This suite covers the additive fix landed here: an `epoch` field, stamped
 * once on first persist and carried forward untouched by every later
 * re-declare of the SAME collection. The epoch-MISMATCH REJECTION itself is
 * intentionally deferred (see marker.ts / config-drift.ts / register.ts
 * comments) until a delete-collection API makes name reuse reachable — this
 * suite only proves the field round-trips and stays stable across a live
 * collection re-opening itself.
 */
import { describe, it, expect } from 'vitest'
import { inlineMemory } from '../classified/harness.js'
import { generateDEK } from '../../src/kernel/enclave/index.js'
import { ensureSatelliteMarker } from '../../src/with-shape/satellites/marker.js'
import { persistClassifiedMarkerForFields } from '../../src/via/classified/config-drift.js'
import { loadPersistedSchema } from '../../src/with-shape/persisted-schemas/storage.js'
import type { SatelliteSpec } from '../../src/with-shape/satellites/types.js'
import type { VdigFieldPolicy } from '../../src/kernel/types.js'

const spec: SatelliteSpec = {
  base: 'msgs',
  satellite: 'msgs_text',
  fields: ['subject', 'body'],
  joined: 'msgs_full',
}

const vdigFields = new Map<string, VdigFieldPolicy>([
  ['password', { normalize: 'password', notLastN: 0, equatable: false }],
])

describe('#597 — persisted marker lifetime epoch', () => {
  describe('satellite pairing marker', () => {
    it('stamps an epoch into the persisted marker on first declaration', async () => {
      const store = inlineMemory()
      const dek = await generateDEK()
      await ensureSatelliteMarker(store, 'v1', spec, dek)
      const stored = await loadPersistedSchema(store, 'v1', spec.satellite, dek)
      expect(typeof stored?.satellite?.epoch).toBe('string')
      expect(stored?.satellite?.epoch).toBeTruthy()
    })

    it('keeps the same epoch when a live collection re-declares itself (R-S9 no-op fast path)', async () => {
      const store = inlineMemory()
      const dek = await generateDEK()
      await ensureSatelliteMarker(store, 'v1', spec, dek)
      const firstEpoch = (await loadPersistedSchema(store, 'v1', spec.satellite, dek))?.satellite?.epoch

      // Re-open with the IDENTICAL declaration — must still hit the "same
      // marker, no-op" fast path (proves the normal live-reopen path is
      // untouched) and must NOT mint a new epoch.
      await expect(ensureSatelliteMarker(store, 'v1', spec, dek)).resolves.toBeUndefined()
      const secondEpoch = (await loadPersistedSchema(store, 'v1', spec.satellite, dek))?.satellite?.epoch
      expect(secondEpoch).toBe(firstEpoch)
    })
  })

  describe('classified marker', () => {
    it('stamps an epoch into the persisted marker on first persist', async () => {
      const store = inlineMemory()
      const dek = await generateDEK()
      await persistClassifiedMarkerForFields(store, 'v1', 'users', vdigFields, dek)
      const stored = await loadPersistedSchema(store, 'v1', 'users', dek)
      expect(typeof stored?.classified?.epoch).toBe('string')
      expect(stored?.classified?.epoch).toBeTruthy()
    })

    it('keeps the same epoch across an identical re-persist (no-op fast path)', async () => {
      const store = inlineMemory()
      const dek = await generateDEK()
      await persistClassifiedMarkerForFields(store, 'v1', 'users', vdigFields, dek)
      const firstEpoch = (await loadPersistedSchema(store, 'v1', 'users', dek))?.classified?.epoch

      await persistClassifiedMarkerForFields(store, 'v1', 'users', vdigFields, dek)
      const secondEpoch = (await loadPersistedSchema(store, 'v1', 'users', dek))?.classified?.epoch
      expect(secondEpoch).toBe(firstEpoch)
    })
  })
})
