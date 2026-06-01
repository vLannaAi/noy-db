import { describe, expect, it } from 'vitest'
import { createNoydb } from '../src/noydb.js'
import { memory } from '../../to-memory/src/index.js'

interface Inv extends Record<string, unknown> { id: string; amount: number }
const SECRET = 'tab-prop-pass-1234'

/**
 * Two same-origin/same-user "tabs" sharing one store. db1 seeds a write FIRST
 * so the per-collection DEK is minted + persisted; only then is db2 created, so
 * it loads the same keyring + DEK (otherwise each tab mints its own DEK and the
 * cross-read fails with TamperedError). See persistence.test.ts:41.
 */
async function twoTabs(store = memory()) {
  const db1 = await createNoydb({ store, user: 'alice', secret: SECRET })
  const v1 = await db1.openVault('books'); const c1 = v1.collection<Inv>('invoices')
  await c1.put('seed', { id: 'seed', amount: 0 }) // mint + persist the invoices DEK
  const db2 = await createNoydb({ store, user: 'alice', secret: SECRET })
  const v2 = await db2.openVault('books'); const c2 = v2.collection<Inv>('invoices')
  return { store, db1, db2, v1, v2, c1, c2 }
}

describe('apply primitives (#228b)', () => {
  it('_applyRemoteChange refreshes the cache from the shared store and emits change', async () => {
    const { db1, db2, v2, c1, c2 } = await twoTabs()
    await c2.get('seed') // hydrate db2's eager cache (loads the shared DEK too)
    let changed = 0
    db2.on('change', (e) => { if (e.id === 'i1') changed++ })

    await c1.put('i1', { id: 'i1', amount: 7 })       // db1 persists to the shared store
    expect(await c2.get('i1')).toBeNull()              // db2 hasn't seen it yet (stale cache)

    await v2._applyRemoteWrite('invoices', 'i1', 'put') // simulate the relay's apply
    expect(await c2.get('i1')).toMatchObject({ amount: 7 })
    expect(changed).toBe(1)
    db1.close(); db2.close()
  })

  it('_applyRemoteWrite is a no-op for an unloaded collection', async () => {
    const db = await createNoydb({ store: memory(), user: 'alice', secret: SECRET })
    const v = await db.openVault('books')
    await expect(v._applyRemoteWrite('not-loaded', 'x', 'put')).resolves.toBeUndefined()
    db.close()
  })
})
