/**
 * Recipe 4 — Analytics-heavy querying.
 *
 * The runnable verification of `docs/recipes/analytics-app.md`.
 * Two subsystems opted-in: indexing, aggregate (joins is currently
 * always-core; will become its own subsystem before v0.26).
 *
 * What this proves:
 *   1. Eager-mode indexes accelerate `where('field', '==', value)`
 *   2. Joins resolve by FK ref through a `ref()` declaration
 *   3. groupBy + aggregate compute multi-reducer rollups per bucket
 *   4. Streaming `scan().aggregate()` works without row ceilings
 *   5. Without `withAggregate()`, .aggregate() throws with a pointer
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createNoydb, ref, sum, avg, count, type Noydb } from '@noy-db/hub'
import { withIndexing } from '@noy-db/hub/indexing'
import { withAggregate } from '@noy-db/hub/aggregate'
import { withSession } from '@noy-db/hub/session'
import { memory } from '@noy-db/to-memory'

interface Client {
  id: string
  name: string
  segment: 'enterprise' | 'sme' | 'consumer'
}

interface Invoice {
  id: string
  clientId: string
  amount: number
  status: 'draft' | 'open' | 'paid' | 'overdue'
  region: 'EU' | 'US' | 'APAC'
}

const PASSPHRASE = 'analytics-pass'

describe('Recipe 4 — Analytics-heavy querying', () => {
  let db: Noydb

  beforeEach(async () => {
    db = await createNoydb({
      store: memory(),
      user: 'analyst',
      secret: PASSPHRASE,
      indexStrategy: withIndexing(),
      aggregateStrategy: withAggregate(),
      sessionStrategy: withSession(),
    })

    const vault = await db.openVault('reporting')

    const clients = vault.collection<Client>('clients')
    await clients.put('c1', { id: 'c1', name: 'Acme',  segment: 'enterprise' })
    await clients.put('c2', { id: 'c2', name: 'Bevco', segment: 'sme' })
    await clients.put('c3', { id: 'c3', name: 'Cosmo', segment: 'consumer' })

    const invoices = vault.collection<Invoice>('invoices', {
      indexes: ['clientId', 'status', 'region'],
      refs: { clientId: ref('clients') },
    })

    const seed: Invoice[] = [
      { id: 'i1', clientId: 'c1', amount: 1000, status: 'paid',    region: 'EU'   },
      { id: 'i2', clientId: 'c1', amount: 2500, status: 'paid',    region: 'EU'   },
      { id: 'i3', clientId: 'c2', amount:  500, status: 'paid',    region: 'US'   },
      { id: 'i4', clientId: 'c2', amount:  300, status: 'open',    region: 'US'   },
      { id: 'i5', clientId: 'c3', amount:  100, status: 'overdue', region: 'APAC' },
      { id: 'i6', clientId: 'c1', amount:  900, status: 'paid',    region: 'APAC' },
    ]
    for (const inv of seed) await invoices.put(inv.id, inv)
  })

  afterEach(() => {
    db.close()
  })

  it('indexed equality filter returns matching records', async () => {
    const invoices = db.vault('reporting').collection<Invoice>('invoices')
    const paid = await invoices.query().where('status', '==', 'paid').toArray()
    expect(paid).toHaveLength(4)
    expect(paid.map((i) => i.id).sort()).toEqual(['i1', 'i2', 'i3', 'i6'])
  })

  it('groupBy + aggregate computes sums + counts per region', async () => {
    const invoices = db.vault('reporting').collection<Invoice>('invoices')
    const byRegion = invoices.query()
      .where('status', '==', 'paid')
      .groupBy('region')
      .aggregate({ total: sum('amount'), n: count(), avg: avg('amount') })
      .run()

    const m = new Map(byRegion.map((r) => [r.region, r]))
    expect(m.get('EU')!.total).toBe(3500)
    expect(m.get('EU')!.n).toBe(2)
    expect(m.get('EU')!.avg).toBe(1750)
    expect(m.get('US')!.total).toBe(500)
    expect(m.get('APAC')!.total).toBe(900)
  })

  it('joins resolve through ref() into the target collection', async () => {
    const invoices = db.vault('reporting').collection<Invoice>('invoices')
    const enriched = await invoices.query()
      .where('status', '==', 'paid')
      .join<'client', Client>('clientId', { as: 'client' })
      .toArray()

    // Every joined row carries a `client: { name, segment, ... }` field
    const acmeRow = enriched.find((r) => r.id === 'i1')!
    expect(acmeRow.client).toBeTruthy()
    expect(acmeRow.client!.name).toBe('Acme')
    expect(acmeRow.client!.segment).toBe('enterprise')
  })

  it('streaming scan().aggregate() works without loading the full set', async () => {
    const invoices = db.vault('reporting').collection<Invoice>('invoices')
    const total = await invoices.scan()
      .where('status', '==', 'paid')
      .aggregate({ sum: sum('amount') })
    expect(total.sum).toBe(4900)
  })

  it('without withAggregate(), .aggregate() throws with a subpath pointer', async () => {
    const noAggDb = await createNoydb({
      store: memory(),
      user: 'analyst',
      secret: PASSPHRASE,
      // No aggregateStrategy on purpose.
    })
    const vault = await noAggDb.openVault('test')
    const items = vault.collection<{ id: string; amount: number }>('items')
    await items.put('a', { id: 'a', amount: 1 })

    expect(() =>
      items.query().aggregate({ s: sum('amount') }).run(),
    ).toThrow(/withAggregate/)

    noAggDb.close()
  })
})
