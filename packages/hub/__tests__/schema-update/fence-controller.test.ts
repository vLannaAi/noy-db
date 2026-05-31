import { describe, expect, it } from 'vitest'
import { memory } from '../../../to-memory/src/index.js'
import { SchemaFenceController } from '../../src/schema-update/fence-controller.js'
import { saveFence, loadFence } from '../../src/schema-update/fence.js'
import { SchemaFenceError, MigrationRequiredError } from '../../src/errors.js'

function ctrl(store = memory()) {
  return { store, c: new SchemaFenceController({ store, vault: 'v', onFlush: async () => {} }) }
}

describe('SchemaFenceController', () => {
  it('init snapshots the live counter; assertWritable passes when normal', async () => {
    const { store, c } = ctrl()
    await saveFence(store, 'v', { currentSchemaVersion: 2, fenceState: 'normal' })
    await c.init()
    await expect(c.assertWritable('invoices')).resolves.toBeUndefined()
  })

  it('throws MigrationRequiredError when live counter advanced past the snapshot', async () => {
    const { store, c } = ctrl()
    await saveFence(store, 'v', { currentSchemaVersion: 2, fenceState: 'normal' })
    await c.init()
    await saveFence(store, 'v', { currentSchemaVersion: 3, fenceState: 'normal' }) // bumped under us
    await expect(c.assertWritable('invoices')).rejects.toBeInstanceOf(MigrationRequiredError)
  })

  it('throws SchemaFenceError for a collection with a pending cutover', async () => {
    const { c } = ctrl()
    await c.init()
    c.registerPendingCutover('invoices', (d) => d)
    await expect(c.assertWritable('invoices')).rejects.toBeInstanceOf(SchemaFenceError)
    await expect(c.assertWritable('other')).resolves.toBeUndefined()
  })

  it('runCutover: flushes, runs each pending transform, bumps counter, clears pending, ends normal', async () => {
    const { store, c } = ctrl()
    await c.init()
    const applied: string[] = []
    c.registerPendingCutover('invoices', (d) => d)
    c.registerPendingCutover('payments', (d) => d)
    await c.runCutover(async (collection, transform) => { applied.push(collection); await transform({}) })
    expect(applied.sort()).toEqual(['invoices', 'payments'])
    const fence = await loadFence(store, 'v')
    expect(fence.currentSchemaVersion).toBe(1)
    expect(fence.fenceState).toBe('normal')
    await expect(c.assertWritable('invoices')).resolves.toBeUndefined() // migrator advanced its own snapshot
  })

  it('runCutover with nothing pending is a no-op (no counter bump)', async () => {
    const { store, c } = ctrl()
    await c.init()
    await c.runCutover(async () => {})
    expect((await loadFence(store, 'v')).currentSchemaVersion).toBe(0)
  })
})
