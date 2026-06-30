import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createNoydb } from '../../src/noydb.js'
import { memory } from '../../../to-memory/src/index.js'
import { coordinatedCutover } from '../../src/with-shape/schema-update/index.js'
import type { NoydbStore } from '../../src/types.js'

const oldS = z.object({ id: z.string(), total: z.number() })
const newS = z.object({ id: z.string(), amount: z.object({ gross: z.number() }) })
const transform = (d: Record<string, unknown>) => ({ id: d['id'], amount: { gross: d['total'] } })

async function open(store: NoydbStore) {
  const db = await createNoydb({ store, user: 'a', secret: 'fence-state-pass-1234' })
  return { db, vault: await db.openVault('demo') }
}

describe('vault.schemaFenceState()', () => {
  it('reports normal generation 0 on a fresh vault', async () => {
    const { vault } = await open(memory())
    expect(await vault.schemaFenceState()).toEqual({ currentSchemaVersion: 0, fenceState: 'normal' })
  })

  it('reflects the bumped generation after a completed cutover', async () => {
    const store = memory()
    let v = (await open(store)).vault
    const o = v.collection('invoices', { schema: oldS, persistJsonSchema: true })
    await v._drainPendingSchemaWrites()
    await o.put('i1', { id: 'i1', total: 100 })

    v = (await open(store)).vault
    v.collection('invoices', { schema: newS, persistJsonSchema: true, schemaUpdate: [coordinatedCutover({ transform })] })
    await v._drainPendingSchemaWrites()
    await v.runSchemaCutover()

    expect(await v.schemaFenceState()).toEqual({ currentSchemaVersion: 1, fenceState: 'normal' })
  })
})
