import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createNoydb, type NoydbStore } from '../src/noydb.js'
import { memory } from '../../to/to-memory/src/index.js'
import { withGuard } from '../src/guards/with-guard.js'
import { additiveOnly, coordinatedCutover } from '../src/schema-update/index.js'

interface Inv extends Record<string, unknown> { id: string; amount: number }

describe('vault.introspect() (#229)', () => {
  it('reports collections with counts, guards, schemaUpdate, and grants', async () => {
    const store: NoydbStore = memory()
    const db = await createNoydb({
      store, user: 'alice', secret: 'introspect-pass-1234',
      guardStrategies: [withGuard<Inv>({ collection: 'invoices', check: () => {} })],
    })
    const v = await db.openVault('demo')
    const invoices = v.collection<Inv>('invoices', {
      schema: z.object({ id: z.string(), amount: z.number() }),
      persistJsonSchema: true,
      schemaUpdate: [coordinatedCutover({ transform: (d) => d }), additiveOnly()],
    })
    await v._drainPendingSchemaWrites()
    v.collection('notes')
    await invoices.put('i1', { id: 'i1', amount: 1 })
    await invoices.put('i2', { id: 'i2', amount: 2 })

    const snap = await v.introspect()

    expect(snap.collections.find(c => c.name === 'invoices')?.docCount).toBe(2)
    expect(snap.collections.map(c => c.name)).toContain('notes')
    expect(snap.guards).toContainEqual({ collection: 'invoices', count: 1 })
    expect(snap.schemaUpdate).toContainEqual({ collection: 'invoices', strategies: ['coordinatedCutover', 'additiveOnly'] })

    const inv = snap.grants.find(g => g.collection === 'invoices')
    expect(inv).toBeDefined()
    expect(['rw', 'ro']).toContain(inv!.permission)
  })

  it('a subsystems-off vault yields empty guard/MV/schemaUpdate arrays without error', async () => {
    const db = await createNoydb({ store: memory(), user: 'a', secret: 'introspect-pass-1234' })
    const v = await db.openVault('demo')
    v.collection('plain')
    const snap = await v.introspect()
    expect(snap.guards).toEqual([])
    expect(snap.materializedViews).toEqual([])
    expect(snap.schemaUpdate).toEqual([])
    expect(snap.collections.map(c => c.name)).toContain('plain')
  })
})
