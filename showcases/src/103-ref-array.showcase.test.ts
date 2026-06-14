/**
 * Showcase 103 — refArray (many-to-many integrity)
 *
 * What you'll learn
 * ─────────────────
 * `refArray(target, mode)` gives a field that holds an ARRAY of ids
 * referential integrity — the M:N counterpart of `ref()`. Each element is
 * validated against the target collection independently, with the same
 * strict / warn / cascade modes applied per element.
 *
 *   - strict put rejects if any linked id is missing.
 *   - cascade delete removes every record whose array contained the id.
 *   - checkIntegrity() reports one orphan per dangling element.
 *
 * Why it matters
 * ──────────────
 * M:N links (order↔product, post↔tag, line-item linking) otherwise store
 * raw id arrays with zero integrity — the "stale link" and "deleted thing
 * still referenced" bug classes. refArray makes the link set self-checking.
 *
 * Prerequisites
 * ─────────────
 * - Showcase 00 + 12 (joins / ref).
 *
 * What to read next
 * ─────────────────
 *   - docs/core/05-schema-and-refs.md
 *
 * Spec mapping
 * ────────────
 * features.yaml → features → schema-and-refs
 */

import { describe, it, expect } from 'vitest'
import { createNoydb, refArray, RefIntegrityError } from '@noy-db/hub'
import { memory } from '@noy-db/to-memory'

interface Product { id: string; name: string }
interface Order { id: string; productIds: string[] }

async function open() {
  const db = await createNoydb({ store: memory(), user: 'alice', secret: 'ref-array-showcase-2026' })
  const vault = await db.openVault('shop')
  return { db, vault }
}

describe('Showcase 103 — refArray (M:N)', () => {
  it('strict mode validates every linked product on put', async () => {
    const { db, vault } = await open()
    const products = vault.collection<Product>('products')
    const orders = vault.collection<Order>('orders', {
      refs: { productIds: refArray('products', 'strict') },
    })

    await products.put('p1', { id: 'p1', name: 'Widget' })
    await products.put('p2', { id: 'p2', name: 'Gadget' })

    // Every element must resolve, or the whole put is rejected.
    await orders.put('o1', { id: 'o1', productIds: ['p1', 'p2'] })
    await expect(orders.put('o2', { id: 'o2', productIds: ['p1', 'ghost'] }))
      .rejects.toBeInstanceOf(RefIntegrityError)

    db.close()
  })

  it('cascade mode removes every order whose array contained the deleted product', async () => {
    const { db, vault } = await open()
    const products = vault.collection<Product>('products')
    const orders = vault.collection<Order>('orders', {
      refs: { productIds: refArray('products', 'cascade') },
    })

    await products.put('p1', { id: 'p1', name: 'Widget' })
    await products.put('p3', { id: 'p3', name: 'Doohickey' })
    await orders.put('o1', { id: 'o1', productIds: ['p1', 'p9'] }) // cascade put is unchecked
    await orders.put('o3', { id: 'o3', productIds: ['p3'] })

    await products.delete('p1')
    expect(await orders.get('o1')).toBeNull()    // contained p1 → cascaded
    expect(await orders.get('o3')).toBeTruthy()  // only p3 → untouched

    db.close()
  })

  it('warn mode surfaces dangling links via checkIntegrity()', async () => {
    const { db, vault } = await open()
    const products = vault.collection<Product>('products')
    const orders = vault.collection<Order>('orders', {
      refs: { productIds: refArray('products', 'warn') },
    })
    await products.put('p1', { id: 'p1', name: 'Widget' })
    await products.put('p2', { id: 'p2', name: 'Gadget' })
    await orders.put('o1', { id: 'o1', productIds: ['p1', 'p2'] })

    await products.delete('p2') // warn — allowed, leaves an orphan link
    const { violations } = await vault.checkIntegrity()
    expect(violations).toHaveLength(1)
    expect(violations[0]).toMatchObject({ collection: 'orders', id: 'o1', field: 'productIds', refId: 'p2' })

    db.close()
  })
})
