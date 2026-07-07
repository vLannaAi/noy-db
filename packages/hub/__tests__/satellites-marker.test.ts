/**
 * R-S9 — persisted pairing marker for satellite collections.
 *
 * `ensureSatelliteMarker` persists `{ base, fieldsHash, joined }` into
 * `_schemas/<satellite>` on first declaration and refuses (SatelliteConfigError,
 * "R-S9") a later re-declaration whose (base, fieldsHash, joined) diverges from
 * what's already persisted — the satellite-pair analogue of the classified
 * config-drift marker (#583's `_schemas` read-merge-write hardening applies
 * identically here).
 */
import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { inlineMemory } from './classified/harness.js'
import { generateDEK } from '../src/kernel/enclave/index.js'
import { ensureSatelliteMarker } from '../src/with-shape/satellites/marker.js'
import { persistSchemaIfNeeded } from '../src/with-shape/persisted-schemas/register.js'
import { loadPersistedSchema } from '../src/with-shape/persisted-schemas/storage.js'
import { SatelliteConfigError } from '../src/kernel/errors.js'
import type { SatelliteSpec } from '../src/with-shape/satellites/types.js'

async function makeFixture() {
  const store = inlineMemory()
  const dek = await generateDEK()
  return { store, dek }
}

const spec: SatelliteSpec = {
  base: 'msgs',
  satellite: 'msgs_text',
  fields: ['subject', 'body'],
  joined: 'msgs_full',
}

describe('ensureSatelliteMarker (R-S9)', () => {
  it('persists on first declaration and accepts an identical re-declaration', async () => {
    const { store, dek } = await makeFixture()
    await ensureSatelliteMarker(store, 'v1', spec, dek)
    await expect(ensureSatelliteMarker(store, 'v1', spec, dek)).resolves.toBeUndefined()
  })

  it('refuses a re-declaration with a divergent fields list', async () => {
    const { store, dek } = await makeFixture()
    await ensureSatelliteMarker(store, 'v1', spec, dek)
    await expect(
      ensureSatelliteMarker(store, 'v1', { ...spec, fields: ['body'] }, dek),
    ).rejects.toThrowError(/R-S9/)
  })

  it('refuses a re-declaration with a divergent base or joined name', async () => {
    const { store, dek } = await makeFixture()
    await ensureSatelliteMarker(store, 'v1', spec, dek)
    await expect(ensureSatelliteMarker(store, 'v1', { ...spec, base: 'mail' }, dek)).rejects.toThrowError(SatelliteConfigError)
    await expect(ensureSatelliteMarker(store, 'v1', { ...spec, joined: 'other' }, dek)).rejects.toThrowError(/R-S9/)
  })

  it('survives a JSON-Schema (re)derivation on the shared _schemas record', async () => {
    // Same #583 bug class as the classified marker: persistSchemaIfNeeded's
    // read-merge-write must carry the satellite marker forward, or the R-S9
    // drift signal silently dies the first time a satellite collection with
    // persistJsonSchema re-derives its schema.
    const { store, dek } = await makeFixture()
    await ensureSatelliteMarker(store, 'v1', spec, dek)

    // Schema writer touches _schemas/<satellite> (first registration writes).
    await persistSchemaIfNeeded({
      store, vault: 'v1', collectionName: spec.satellite,
      validator: z.object({ subject: z.string(), body: z.string() }), dek,
    })

    // Marker survived the merge — both signals coexist on the single record.
    const stored = await loadPersistedSchema(store, 'v1', spec.satellite, dek)
    expect(stored?.satellite).toBeDefined()
    expect(stored?.satellite?.base).toBe('msgs')
    expect(stored?.kind).toBe('Zod')

    // And the R-S9 guard still works end-to-end: same spec resolves,
    // divergent spec refuses.
    await expect(ensureSatelliteMarker(store, 'v1', spec, dek)).resolves.toBeUndefined()
    await expect(
      ensureSatelliteMarker(store, 'v1', { ...spec, fields: ['body'] }, dek),
    ).rejects.toThrowError(/R-S9/)
  })
})
