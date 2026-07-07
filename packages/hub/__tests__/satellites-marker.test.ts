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
import { inlineMemory } from './classified/harness.js'
import { generateDEK } from '../src/kernel/enclave/index.js'
import { ensureSatelliteMarker } from '../src/with-shape/satellites/marker.js'
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
})
