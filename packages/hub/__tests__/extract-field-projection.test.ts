/**
 * extractPartition fieldProjection — structural field redaction (FR-7 Task 1).
 *
 * Verifies that `fieldProjection: { <collection>: [...keptFields] }` drops
 * every non-listed field from each record of the projected collection BEFORE
 * re-encryption, so excluded fields never travel in the bundle. `id` is always
 * preserved. Non-projected collections keep all their fields. The same holds
 * across both re-key branches: standard per-collection DEK AND per-record CEK
 * (`perRecordKeys: true`).
 */

import { describe, it, expect } from 'vitest'
import { createNoydb } from '../src/kernel/noydb.js'
import { withCargo } from '../src/index.js'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/kernel/types.js'
import { ConflictError } from '../src/kernel/errors.js'
import { extractPartition } from '../src/with-cargo/extract-partition.js'
import { decryptExtractedPartition } from '../src/with-cargo/decrypt-partition.js'

function memory(): NoydbStore {
  const store = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  function getCollection(c: string, col: string) {
    let comp = store.get(c)
    if (!comp) { comp = new Map(); store.set(c, comp) }
    let coll = comp.get(col)
    if (!coll) { coll = new Map(); comp.set(col, coll) }
    return coll
  }
  return {
    name: 'memory',
    async get(c, col, id) { return store.get(c)?.get(col)?.get(id) ?? null },
    async put(c, col, id, env, ev) {
      const coll = getCollection(c, col)
      const ex = coll.get(id)
      if (ev !== undefined && ex && ex._v !== ev) throw new ConflictError(ex._v)
      coll.set(id, env)
    },
    async delete(c, col, id) { store.get(c)?.get(col)?.delete(id) },
    async list(c, col) { const coll = store.get(c)?.get(col); return coll ? [...coll.keys()] : [] },
    async loadAll(c) {
      const comp = store.get(c); const s: VaultSnapshot = {}
      if (comp) for (const [n, coll] of comp) {
        if (!n.startsWith('_')) {
          const r: Record<string, EncryptedEnvelope> = {}
          for (const [id, e] of coll) r[id] = e
          s[n] = r
        }
      }
      return s
    },
    async saveAll(c, data) {
      const comp = new Map<string, Map<string, EncryptedEnvelope>>()
      for (const [name, records] of Object.entries(data)) {
        const coll = new Map<string, EncryptedEnvelope>()
        for (const [id, env] of Object.entries(records)) coll.set(id, env)
        comp.set(name, coll)
      }
      const existing = store.get(c)
      if (existing) {
        for (const [name, coll] of existing) {
          if (name.startsWith('_')) comp.set(name, coll)
        }
      }
      store.set(c, comp)
    },
  }
}

interface Client { id: string; name: string; phone: string }
interface Note { id: string; title: string; body: string }

describe('extractPartition — fieldProjection (structural redaction)', () => {
  it('drops non-listed fields from a projected collection; keeps all fields on a non-projected one', async () => {
    const db = await createNoydb({ cargoStrategy: withCargo(), store: memory(), user: 'alice', secret: 'test-passphrase-1234' })
    const company = await db.openVault('demo-co')

    const clients = company.collection<Client>('clients')
    await clients.put('c1', { id: 'c1', name: 'Acme', phone: '555-0001' })
    await clients.put('c2', { id: 'c2', name: 'Beta Corp', phone: '555-0002' })

    const notes = company.collection<Note>('notes')
    await notes.put('n1', { id: 'n1', title: 'Kickoff', body: 'agenda' })

    const { bundleBytes, transferKey } = await extractPartition(company, {
      seeds: { clients: () => true, notes: () => true },
      fieldProjection: { clients: ['name'] },
    })

    const out = await decryptExtractedPartition(bundleBytes, transferKey)
    expect(Object.keys(out).sort()).toEqual(['clients', 'notes'])

    // clients: each record has EXACTLY id + name (NO phone).
    for (const rec of out['clients']!) {
      expect(Object.keys(rec.record).sort()).toEqual(['id', 'name'])
      expect(rec.record).not.toHaveProperty('phone')
    }
    const c1 = out['clients']!.find((r) => r.id === 'c1')!
    expect(c1.record).toEqual({ id: 'c1', name: 'Acme' })
    const c2 = out['clients']!.find((r) => r.id === 'c2')!
    expect(c2.record).toEqual({ id: 'c2', name: 'Beta Corp' })

    // notes: NOT projected → keeps ALL fields.
    const n1 = out['notes']!.find((r) => r.id === 'n1')!
    expect(n1.record).toEqual({ id: 'n1', title: 'Kickoff', body: 'agenda' })
  })

  it('applies projection on the per-record-CEK branch (perRecordKeys: true)', async () => {
    const db = await createNoydb({ cargoStrategy: withCargo(), store: memory(), user: 'alice', secret: 'test-passphrase-1234' })
    const company = await db.openVault('demo-co')

    const clients = company.collection<Client>('clients', { perRecordKeys: true })
    await clients.put('c1', { id: 'c1', name: 'Acme', phone: '555-0001' })
    await clients.put('c2', { id: 'c2', name: 'Beta Corp', phone: '555-0002' })

    const { bundleBytes, transferKey } = await extractPartition(company, {
      seeds: { clients: () => true },
      fieldProjection: { clients: ['name'] },
    })

    const out = await decryptExtractedPartition(bundleBytes, transferKey)
    for (const rec of out['clients']!) {
      expect(Object.keys(rec.record).sort()).toEqual(['id', 'name'])
      expect(rec.record).not.toHaveProperty('phone')
    }
    const c1 = out['clients']!.find((r) => r.id === 'c1')!
    expect(c1.record).toEqual({ id: 'c1', name: 'Acme' })
  })

  it('always preserves id even when id is not listed in the projection', async () => {
    const db = await createNoydb({ cargoStrategy: withCargo(), store: memory(), user: 'alice', secret: 'test-passphrase-1234' })
    const company = await db.openVault('demo-co')

    const clients = company.collection<Client>('clients')
    await clients.put('c1', { id: 'c1', name: 'Acme', phone: '555-0001' })

    // Projection lists only 'phone' — id is NOT listed but must survive.
    const { bundleBytes, transferKey } = await extractPartition(company, {
      seeds: { clients: () => true },
      fieldProjection: { clients: ['phone'] },
    })

    const out = await decryptExtractedPartition(bundleBytes, transferKey)
    const c1 = out['clients']!.find((r) => r.id === 'c1')!
    expect(c1.id).toBe('c1')
    expect(c1.record).toEqual({ id: 'c1', phone: '555-0001' })
    expect(c1.record).not.toHaveProperty('name')
  })
})
