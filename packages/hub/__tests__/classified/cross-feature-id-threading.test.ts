/**
 * #629 whole-branch review fix wave (C1) — record `id` threaded through
 * out-of-`collection.ts` classified read paths.
 *
 * Task 6 threaded `id` into every `RecordCodec.decryptRecord` call site
 * inside `collection.ts`, but five other in-repo consumers were missed:
 * `findByDet`/`queryByDet` (kernel/enclave/record-keys/deterministic.ts),
 * the `getAtTier` tier-0 branch (with-audit/tiers/index.ts), and
 * `rebuildIndexes`/`reconcileIndex` (with-lookup/indexing/collection-facade.ts).
 * Each hits `RecordCodec.decryptRecord`'s "caller bug" guard
 * (`hasAtRestHooks && envelope._sealed && opts.id === undefined`) on any
 * collection that combines `classifiedFields` with the cross-feature surface
 * exercised here — this suite proves each one round-trips instead of
 * throwing.
 */
import { describe, it, expect } from 'vitest'
import { createNoydb } from '../../src/kernel/noydb.js'
import { classified } from '../../src/shape/via-classified/presets.js'
import { withTiers } from '../../src/with-audit/tiers/index.js'
import { withIndexing } from '../../src/with-lookup/indexing/index.js'
import { inlineMemory } from './harness.js'

const PAN_1 = '4242424242424242'

describe('#629 whole-branch fix wave — cross-feature classified id threading (C1)', () => {
  it('findByDet round-trips a classified record (classified + deterministicFields on a different field)', async () => {
    const db = await createNoydb({ store: inlineMemory(), user: 'a', secret: 'pw-c1-det' })
    const v = await db.openVault('v1')
    const c = v.collection<{ pan: string; email: string; name: string }>('cards', {
      classifiedFields: { card: classified.creditCard({ pan: 'pan' }) },
      deterministicFields: ['email'],
      acknowledgeDeterministicRisk: true,
    })
    await c.put('r1', { pan: PAN_1, email: 'nok@example.com', name: 'Nok' })

    const found = await c.findByDet('email', 'nok@example.com')

    expect(found).not.toBeNull()
    expect((found as Record<string, unknown>).name).toBe('Nok')
    expect((found as Record<string, unknown>).pan).toBe(PAN_1)
    await db.close()
  })

  it('queryByDet round-trips a classified record (classified + deterministicFields on a different field)', async () => {
    const db = await createNoydb({ store: inlineMemory(), user: 'a', secret: 'pw-c1-det-q' })
    const v = await db.openVault('v1')
    const c = v.collection<{ pan: string; email: string; name: string }>('cards', {
      classifiedFields: { card: classified.creditCard({ pan: 'pan' }) },
      deterministicFields: ['email'],
      acknowledgeDeterministicRisk: true,
    })
    await c.put('r1', { pan: PAN_1, email: 'nok@example.com', name: 'Nok' })

    const matches = await c.queryByDet('email', 'nok@example.com')

    expect(matches).toHaveLength(1)
    expect((matches[0] as Record<string, unknown>).pan).toBe(PAN_1)
    await db.close()
  })

  it('getAtTier (tier-0 branch) returns a classified record', async () => {
    const db = await createNoydb({ store: inlineMemory(), user: 'a', secret: 'pw-c1-tier', tiersStrategy: withTiers() })
    const v = await db.openVault('v1')
    const c = v.collection<{ pan: string; name: string }>('cards', {
      classifiedFields: { card: classified.creditCard({ pan: 'pan' }) },
      tiers: [0, 1],
    })
    // Plain put() writes with no `_tier` stamp -> getAtTier's implicit tier-0 branch.
    await c.put('r1', { pan: PAN_1, name: 'Nok' })

    const got = await c.getAtTier('r1')

    expect(got).not.toBeNull()
    expect((got as Record<string, unknown>).pan).toBe(PAN_1)
    await db.close()
  })

  it('rebuildIndexes (lazy) and reconcileIndex complete on a classified collection with a non-classified indexed field', async () => {
    const db = await createNoydb({ store: inlineMemory(), user: 'a', secret: 'pw-c1-idx', indexStrategy: withIndexing() })
    const v = await db.openVault('v1')
    const c = v.collection<{ pan: string; name: string }>('cards', {
      classifiedFields: { card: classified.creditCard({ pan: 'pan' }) },
      prefetch: false,
      cache: { maxRecords: 100 },
      indexes: ['name'],
    })
    await c.put('r1', { pan: PAN_1, name: 'Nok' })

    await expect(c.rebuildIndexes()).resolves.toBeUndefined()

    const report = await c.reconcileIndex('name')
    expect(report.missing).toEqual([])
    expect(report.stale).toEqual([])
    await db.close()
  })
})
