import { describe, it, expect, vi, afterEach } from 'vitest'
import { createNoydb } from '../src/kernel/noydb.js'
import { memoryStore } from '../src/kernel/memory-store.js'
import { withIndexing } from '../src/with-lookup/indexing/index.js'

/**
 * #1421 — declaring `indexes:` without `indexingStrategy: withIndexing()` is
 * legitimate (one collection definition shared between a full app and a
 * lightweight script), so this WARNS rather than throws. But silence is the
 * wrong default: nothing builds the declared indexes and every lookup scans,
 * which is exactly how the reporter's production lookups became scans.
 *
 * The warning is fired once per Collection construction, not per query —
 * `vault.collection()` caches, so repeated declarations and repeated queries
 * stay at one line.
 */
interface Client { id: string; entityId: string; name: string }

const opts = { store: memoryStore(), user: 'u1', secret: 'correct horse battery staple' }

afterEach(() => { vi.restoreAllMocks() })

describe('#1421 — indexes declared with no indexingStrategy', () => {
  it('warns once, naming the collection, the declared fields, and the remedy', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const db = await createNoydb({ ...opts, store: memoryStore() })
    const vault = await db.openVault('acme')

    const c = vault.collection<Client>('clients', { indexes: [{ fields: ['entityId'] }] })
    await c.put('c1', { id: 'c1', entityId: 'ent-c3', name: 'A' })

    const hits = warn.mock.calls.filter((c) => String(c[0]).includes('declares indexes'))
    expect(hits).toHaveLength(1)
    const message = String(hits[0]?.[0])
    expect(message).toContain('"clients"')
    expect(message).toContain('entityId')
    expect(message).toContain('will scan')
    expect(message).toContain('withIndexing()')
    expect(message).toContain('@noy-db/hub/indexing')
  })

  it('warns once per collection, not per re-declaration and not per query', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const db = await createNoydb({ ...opts, store: memoryStore() })
    const vault = await db.openVault('acme')

    const declare = (): ReturnType<typeof vault.collection<Client>> =>
      vault.collection<Client>('clients', { indexes: [{ fields: ['entityId'] }] })
    const c = declare()
    await c.put('c1', { id: 'c1', entityId: 'ent-c3', name: 'A' })
    declare(); declare()
    await c.list()
    c.query().where('entityId', '==', 'ent-c3').toArray()
    c.query().where('entityId', '==', 'ent-c3').toArray()

    expect(warn.mock.calls.filter((c) => String(c[0]).includes('declares indexes'))).toHaveLength(1)
  })

  it('does not warn when the indexing strategy is present', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const db = await createNoydb({ ...opts, store: memoryStore(), indexingStrategy: withIndexing() })
    const vault = await db.openVault('acme')

    const c = vault.collection<Client>('clients', { indexes: [{ fields: ['entityId'] }] })
    await c.put('c1', { id: 'c1', entityId: 'ent-c3', name: 'A' })

    expect(warn.mock.calls.filter((c) => String(c[0]).includes('declares indexes'))).toHaveLength(0)
  })

  it('does not warn when no indexes are declared', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const db = await createNoydb({ ...opts, store: memoryStore() })
    const vault = await db.openVault('acme')

    const c = vault.collection<Client>('clients')
    await c.put('c1', { id: 'c1', entityId: 'ent-c3', name: 'A' })

    expect(warn.mock.calls.filter((c) => String(c[0]).includes('declares indexes'))).toHaveLength(0)
  })
})
