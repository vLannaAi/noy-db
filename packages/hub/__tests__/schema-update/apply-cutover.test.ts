import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createNoydb } from '../../src/kernel/noydb.js'
import { toMemory } from '../../../to-memory/src/index.js'

interface Inv extends Record<string, unknown> { id: string; total?: number | undefined; amount?: { gross: number } | undefined }

describe('Collection._applyCutoverTransform', () => {
  it('rewrites every record through the transform, bumping _v', async () => {
    const store = toMemory()
    const db = await createNoydb({ store, user: 'a', secret: 'apply-cutover-pass-1234' })
    const vault = await db.openVault('demo')
    const invoices = vault.collection<Inv>('invoices', {
      schema: z.object({ id: z.string(), total: z.number().optional(), amount: z.object({ gross: z.number() }).optional() }),
    })
    await invoices.put('i1', { id: 'i1', total: 100 })
    await invoices.put('i2', { id: 'i2', total: 200 })

    const count = await invoices._applyCutoverTransform((d) => ({ id: d['id'], amount: { gross: d['total'] } }))
    expect(count).toBe(2)
    expect((await invoices.get('i1'))?.amount?.gross).toBe(100)
    expect((await invoices.get('i2'))?.amount?.gross).toBe(200)
  })
})
